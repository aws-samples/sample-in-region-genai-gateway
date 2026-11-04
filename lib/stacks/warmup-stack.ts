/**
 * GenAiGwWarmupStack — vLLM scale-up/down Step Functions
 *
 * 구성:
 *   - scaleVllmFn:    K8s Deployment replicas 조작 Lambda
 *   - pollReadyFn:    K8s Deployment readyReplicas 확인 Lambda
 *   - warmupMachine:  Step Functions — ScaleUp → parallel 준비 폴링 (25분 타임아웃)
 *   - cooldownMachine: Step Functions — ScaleDown (fire-and-forget, 5분 타임아웃)
 *
 * EventBridge 스케줄은 Phase 10 GenAiGwReservationStack으로 이전됨.
 * minReplicas=0 인 모델만 warm-up 대상 (always-on 모델은 제외).
 */
import * as cdk from 'aws-cdk-lib/core';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as path from 'path';
import { Construct } from 'constructs';
import { VllmModelConfig } from '../../config/models';

export interface WarmupStackProps extends cdk.StackProps {
  cluster: eks.Cluster;
  /** Models to manage — only those with minReplicas=0 are warm-up targets */
  vllmModels: VllmModelConfig[];
  /** K8s namespace where vLLM runs, default 'vllm' */
  namespace?: string;
  /**
   * Max seconds to wait for all deployments to become ready.
   * Default: 3000 (50 min — covers llama4-scout S3 prefetch + torch compile ~35min).
   */
  readyTimeoutSecs?: number;
  /**
   * Poll interval in seconds between readiness checks.
   * Default: 60
   */
  pollIntervalSecs?: number;
}

export class WarmupStack extends cdk.Stack {
  public readonly warmupMachine: sfn.StateMachine;
  public readonly cooldownMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: WarmupStackProps) {
    super(scope, id, props);

    const namespace = props.namespace ?? 'vllm';
    const clusterName = props.cluster.clusterName;
    const readyTimeoutSecs = props.readyTimeoutSecs ?? 3000; // I7: raised from 1500 (25min) to 3000 (50min)
    const pollIntervalSecs = props.pollIntervalSecs ?? 60;

    // Only scale-to-zero models need warm-up
    const warmupDeployments = props.vllmModels
      .filter(m => m.minReplicas === 0)
      .map(m => m.servingName);

    // ── Lambda IAM role ────────────────────────────────────────────────────────

    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        EksAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['eks:DescribeCluster'],
              resources: [props.cluster.clusterArn],
            }),
            new iam.PolicyStatement({
              actions: ['eks:AccessKubernetesApi'],
              resources: [props.cluster.clusterArn],
            }),
          ],
        }),
      },
    });

    // K8s RBAC access: AccessEntry L2 construct in aws-eks-v2.
    // Using AccessEntry directly rather than cluster.grantAccess() to avoid a
    // cross-stack dependency cycle (cluster.grantAccess() resolves cluster ARN
    // from EksClusterStack, which already depends on stacks WarmupStack depends on).
    //
    // Post-deploy verification:
    //   aws eks list-access-entries --cluster-name genai-gw --region ap-northeast-2
    new eks.AccessEntry(this, 'WarmupLambdaAccessEntry', {
      cluster: props.cluster,
      principal: lambdaRole.roleArn,
      accessPolicies: [
        eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
          accessScopeType: eks.AccessScopeType.CLUSTER,
        }),
      ],
    });

    // ── scale-vllm Lambda ──────────────────────────────────────────────────────

    const scaleVllmLogGroup = new logs.LogGroup(this, 'ScaleVllmLogs', {
      logGroupName: '/aws/lambda/genai-gw-scale-vllm',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // In-place update: adopt orphan logical ID from pre-CDK auto-created log group
    // so CFN performs retention/removalPolicy update instead of CREATE+conflict.
    (scaleVllmLogGroup.node.defaultChild as cdk.CfnResource).overrideLogicalId('ScaleVllmFnLogGroup50CB2B5E');

    const scaleVllmFn = new lambda.Function(this, 'ScaleVllmFn', {
      functionName: 'genai-gw-scale-vllm',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      role: lambdaRole,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/scale-vllm')),
      logGroup: scaleVllmLogGroup,
      environment: {
        EKS_CLUSTER_NAME: clusterName,
        EKS_REGION: 'ap-northeast-2',
      },
    });

    // ── poll-ready Lambda ──────────────────────────────────────────────────────

    const pollReadyLogGroup = new logs.LogGroup(this, 'PollReadyLogs', {
      logGroupName: '/aws/lambda/genai-gw-poll-ready',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (pollReadyLogGroup.node.defaultChild as cdk.CfnResource).overrideLogicalId('PollReadyFnLogGroup1FF6349C');

    const pollReadyFn = new lambda.Function(this, 'PollReadyFn', {
      functionName: 'genai-gw-poll-ready',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      role: lambdaRole,
      timeout: cdk.Duration.minutes(1),
      memorySize: 128,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/poll-ready')),
      logGroup: pollReadyLogGroup,
      environment: {
        EKS_CLUSTER_NAME: clusterName,
        EKS_REGION: 'ap-northeast-2',
      },
    });

    // ── Step Functions IAM role ────────────────────────────────────────────────

    const sfnRole = new iam.Role(this, 'SfnRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      inlinePolicies: {
        InvokeLambda: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              resources: [
                scaleVllmFn.functionArn,
                pollReadyFn.functionArn,
              ],
            }),
          ],
        }),
        Logs: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'logs:CreateLogDelivery', 'logs:PutLogEvents', 'logs:GetLogDelivery',
                'logs:UpdateLogDelivery', 'logs:DeleteLogDelivery', 'logs:ListLogDeliveries',
                'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // ── Warmup state machine ───────────────────────────────────────────────────
    //
    // Input: {
    //   "deployments": ["qwen35-27b", "gemma4-31b"],  ← K8s Deployment names (servingNames)
    //   "namespace":   "vllm",
    //   "clusterName": "genai-gw"
    // }
    // reserve-fn provides this input. Direct invocation (e.g. warmup-manual.sh) must also supply it.

    // Step 1: scale-up all requested deployments
    // namespace and clusterName are fixed at build time; only deployments come from input.
    const scaleUpTask = new tasks.LambdaInvoke(this, 'ScaleUpAll', {
      lambdaFunction: scaleVllmFn,
      payload: sfn.TaskInput.fromObject({
        action: 'scale-up',
        'deployments.$': '$.deployments',
        namespace,
        clusterName,
      }),
      resultPath: '$.scaleUpResult',
    });

    // Step 2: Map — poll each deployment until ready (in parallel)
    //
    // Map itemsPath = $.deployments (string array: ["qwen35-27b", "gemma4-31b"])
    // itemSelector enriches each string item with namespace/clusterName from outer context.
    // Each Map item is: { deployment: "...", namespace: "...", clusterName: "..." }
    //
    // Per-item poll loop: Wait → PollReady → Choice (ready? → Succeed : → Wait)

    const itemWait = new sfn.Wait(this, 'WaitBeforePoll', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(pollIntervalSecs)),
    });

    const itemPoll = new tasks.LambdaInvoke(this, 'PollDeploymentReady', {
      lambdaFunction: pollReadyFn,
      payload: sfn.TaskInput.fromJsonPathAt('$'),
      resultSelector: {
        'ready.$':        '$.Payload.ready',
        'readyReplicas.$':'$.Payload.readyReplicas',
        'message.$':      '$.Payload.message',
        'deployment.$':   '$.Payload.deployment',
      },
      resultPath: '$.pollResult',
    });

    const itemReadyCheck = new sfn.Choice(this, 'IsDeploymentReady')
      .when(
        sfn.Condition.booleanEquals('$.pollResult.ready', true),
        new sfn.Succeed(this, 'DeploymentIsReady'),
      )
      .otherwise(itemWait);

    itemWait.next(itemPoll).next(itemReadyCheck);

    const parallelPoll = new sfn.Map(this, 'PollAllDeployments', {
      comment: 'Poll each vLLM deployment in parallel until ready',
      itemsPath: sfn.JsonPath.stringAt('$.deployments'),
      maxConcurrency: 0,
      resultPath: '$.pollResults',
      // Inject namespace+clusterName (fixed at build time) into each string item
      itemSelector: {
        'deployment.$': '$$.Map.Item.Value',
        namespace,
        clusterName,
      },
    }).itemProcessor(itemWait);

    const warmupSuccess = new sfn.Succeed(this, 'WarmupComplete', {
      comment: 'All deployments ready',
    });

    const warmupDefinition = scaleUpTask
      .next(parallelPoll)
      .next(warmupSuccess);

    const warmupLogGroup = new logs.LogGroup(this, 'WarmupLogs', {
      logGroupName: '/aws/states/genai-gw-warmup',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.warmupMachine = new sfn.StateMachine(this, 'WarmupMachine', {
      stateMachineName: 'genai-gw-warmup',
      definitionBody: sfn.DefinitionBody.fromChainable(warmupDefinition),
      role: sfnRole,
      timeout: cdk.Duration.seconds(readyTimeoutSecs),
      tracingEnabled: true,
      logs: {
        destination: warmupLogGroup,
        level: sfn.LogLevel.ERROR,
        includeExecutionData: true,
      },
    });

    // ── Cooldown state machine ─────────────────────────────────────────────────

    // I5 fix: use $.deployments from SFN input so caller (expire-fn / admin-console)
    // can specify only the affected alias, not all warmup deployments.
    const scaleDownTask = new tasks.LambdaInvoke(this, 'ScaleDownAll', {
      lambdaFunction: scaleVllmFn,
      payload: sfn.TaskInput.fromObject({
        action: 'scale-down',
        'deployments.$': '$.deployments',
        namespace,
        clusterName,
      }),
      resultPath: '$.scaleDownResult',
    });

    const cooldownSuccess = new sfn.Succeed(this, 'CooldownComplete', {
      comment: 'All deployments scaled to zero',
    });

    const cooldownLogGroup = new logs.LogGroup(this, 'CooldownLogs', {
      logGroupName: '/aws/states/genai-gw-cooldown',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.cooldownMachine = new sfn.StateMachine(this, 'CooldownMachine', {
      stateMachineName: 'genai-gw-cooldown',
      definitionBody: sfn.DefinitionBody.fromChainable(scaleDownTask.next(cooldownSuccess)),
      role: sfnRole,
      timeout: cdk.Duration.minutes(5),
      tracingEnabled: true,
      logs: {
        destination: cooldownLogGroup,
        level: sfn.LogLevel.ERROR,
        includeExecutionData: true,
      },
    });

    // ── CloudFormation outputs ─────────────────────────────────────────────────
    // EventBridge schedule is managed by GenAiGwReservationStack (Phase 10).

    new cdk.CfnOutput(this, 'WarmupMachineArn', {
      value: this.warmupMachine.stateMachineArn,
      description: 'SFN ARN — used by GenAiGwReservationStack reserve-fn',
    });
    new cdk.CfnOutput(this, 'CooldownMachineArn', {
      value: this.cooldownMachine.stateMachineArn,
      description: 'SFN ARN — used by GenAiGwReservationStack expire-fn and admin console',
    });
    new cdk.CfnOutput(this, 'WarmupTargets', {
      value: warmupDeployments.join(', '),
      description: 'Deployments managed by warm-up (minReplicas=0 models)',
    });
  }
}
