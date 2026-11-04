/**
 * GenAiGwReservationStack — alias 단위 warm-up reservation 관리
 *
 * 구성:
 *   - DynamoDB WarmupReservations: PK=alias, SK=reservationId, TTL=expireAt
 *   - reserve-fn Lambda: reservation 생성 + EB Scheduler 등록 + scale-up SFN 실행
 *   - expire-fn Lambda:  reservation 만료 처리 + scale-down SFN 실행
 *   - EventBridge Scheduler group: genai-gw-reservations
 *   - EventBridge rules: 08:30 KST → ReserveFn (alias=all, duration=11h)
 *
 * Phase 9 WarmupStack의 EventBridge 스케줄을 이 스택으로 통합.
 * WarmupStack은 SFN만 유지 (스케줄 제거).
 */
import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as path from 'path';
import { Construct } from 'constructs';
import { VllmModelConfig } from '../../config/models';

export interface ReservationStackProps extends cdk.StackProps {
  vllmModels: VllmModelConfig[];
  warmupSfnArn: string;
  cooldownSfnArn: string;
  clusterName: string;
  namespace?: string;
  /**
   * Warm-up cron (UTC). Default: 23:30 UTC = 08:30 KST Mon-Fri (SUN-THU in UTC)
   */
  warmupCron?: string;
  /** Duration in seconds for the daily scheduled reservation. Default: 11h = 39600s */
  scheduledDurationSecs?: number;
  /**
   * Whether the daily warm-up EventBridge rule is enabled on deploy.
   * Default: false — rule is created but disabled to avoid GPU idle cost.
   * Admin Console (/schedule/toggle) can flip at runtime via events:EnableRule.
   */
  dailyScheduleEnabled?: boolean;
}

/** Fixed EventBridge rule name — referenced by AdminConsoleStack for enable/disable toggle. */
export const DAILY_WARMUP_RULE_NAME = 'genai-gw-daily-warmup';

export class ReservationStack extends cdk.Stack {
  /** ARN of reserve-fn — used by warmup-request.sh script */
  public readonly reserveFnArn: string;

  constructor(scope: Construct, id: string, props: ReservationStackProps) {
    super(scope, id, props);

    const namespace = props.namespace ?? 'vllm';
    const allAliases = props.vllmModels
      .filter(m => m.minReplicas === 0)
      .map(m => m.alias);
    // alias → K8s Deployment name (servingName) for WarmupMachine input
    const aliasToServing: Record<string, string> = {};
    for (const m of props.vllmModels) {
      aliasToServing[m.alias] = m.servingName;
    }

    // ── DynamoDB ───────────────────────────────────────────────────────────────

    const table = new dynamodb.Table(this, 'ReservationsTable', {
      tableName: 'GenAiGwWarmupReservations',
      partitionKey: { name: 'alias', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'reservationId', type: dynamodb.AttributeType.STRING },
      billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expireAt',
      // Encrypt at rest with an AWS-owned key (default), made explicit for clarity.
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      // Recover accidental deletes within 35 days.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // GSI: query all reservations for admin console
    table.addGlobalSecondaryIndex({
      indexName: 'ByExpiry',
      partitionKey: { name: 'alias', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'expireAt', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── EventBridge Scheduler group ────────────────────────────────────────────

    new scheduler.CfnScheduleGroup(this, 'SchedulerGroup', {
      name: 'genai-gw-reservations',
    });

    // ── Lambda shared role ─────────────────────────────────────────────────────

    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    table.grantReadWriteData(lambdaRole);

    // SFN start execution
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [props.warmupSfnArn, props.cooldownSfnArn],
    }));

    // EventBridge Scheduler: create/delete one-time schedules
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'scheduler:CreateSchedule',
        'scheduler:DeleteSchedule',
        'scheduler:GetSchedule',
      ],
      resources: ['*'],
    }));

    // ── EventBridge Scheduler execution role (must precede expire-fn/reserve-fn) ─
    // scheduler.amazonaws.com needs its own trust policy to assume this role.
    // Lambda (lambdaRole) cannot be used here — it trusts lambda.amazonaws.com only.
    const schedulerExpireRole = new iam.Role(this, 'SchedulerExpireRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });

    // iam:PassRole so reserve-fn can pass schedulerExpireRole to CreateSchedule API
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [schedulerExpireRole.roleArn],
      conditions: {
        StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' },
      },
    }));

    // ── expire-fn (defined first so reserve-fn can reference its ARN) ──────────

    const expireFnLogGroup = new logs.LogGroup(this, 'ExpireFnLogs', {
      logGroupName: '/aws/lambda/genai-gw-expire-reservation',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // In-place update: adopt orphan logical ID from pre-CDK auto-created log group
    // so CFN performs retention/removalPolicy update instead of CREATE+conflict.
    (expireFnLogGroup.node.defaultChild as cdk.CfnResource).overrideLogicalId('ExpireFnLogGroupBB7AA28D');

    const expireFn = new lambda.Function(this, 'ExpireFn', {
      functionName: 'genai-gw-expire-reservation',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      role: lambdaRole,
      timeout: cdk.Duration.minutes(2),
      memorySize: 128,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/expire-fn')),
      logGroup: expireFnLogGroup,
      environment: {
        EKS_REGION:         'ap-northeast-2',
        RESERVATIONS_TABLE: table.tableName,
        COOLDOWN_SFN_ARN:   props.cooldownSfnArn,
        EKS_CLUSTER_NAME:   props.clusterName,
        K8S_NAMESPACE:      namespace,
        ALIAS_TO_SERVING:   JSON.stringify(aliasToServing),
      },
    });

    // Grant schedulerExpireRole permission to invoke expire-fn
    schedulerExpireRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [expireFn.functionArn],
    }));

    // Allow EventBridge Scheduler to invoke expire-fn (resource-based policy).
    // Scope to this account + the dedicated schedule group so a scheduler in any
    // other account cannot invoke this function (confused-deputy defense). reserve-fn
    // creates one-time schedules named genai-gw-expire-* inside this group at runtime.
    expireFn.addPermission('SchedulerInvoke', {
      principal: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceAccount: this.account,
      sourceArn: `arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule/genai-gw-reservations/*`,
    });

    // ── reserve-fn ─────────────────────────────────────────────────────────────

    const reserveFnLogGroup = new logs.LogGroup(this, 'ReserveFnLogs', {
      logGroupName: '/aws/lambda/genai-gw-reserve',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (reserveFnLogGroup.node.defaultChild as cdk.CfnResource).overrideLogicalId('ReserveFnLogGroup7BD17148');

    const reserveFn = new lambda.Function(this, 'ReserveFn', {
      functionName: 'genai-gw-reserve',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      role: lambdaRole,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/reserve-fn')),
      logGroup: reserveFnLogGroup,
      environment: {
        EKS_REGION:         'ap-northeast-2',
        RESERVATIONS_TABLE: table.tableName,
        WARMUP_SFN_ARN:     props.warmupSfnArn,
        COOLDOWN_SFN_ARN:   props.cooldownSfnArn,
        EXPIRE_FN_ARN:      expireFn.functionArn,
        SCHEDULER_ROLE_ARN: schedulerExpireRole.roleArn,
        ALL_ALIASES:        JSON.stringify(allAliases),
        ALIAS_TO_SERVING:   JSON.stringify(aliasToServing),
        EKS_CLUSTER_NAME:   props.clusterName,
        K8S_NAMESPACE:      namespace,
      },
    });
    this.reserveFnArn = reserveFn.functionArn;

    // ── Daily scheduled reservation (08:30 KST Mon-Fri) ───────────────────────
    // Replaces Phase 9 WarmupStack EventBridge rules.
    // Creates an "all" reservation lasting 11h (08:30→19:30 KST).

    const scheduledDuration = props.scheduledDurationSecs ?? 39600; // 11 hours
    const warmupCron = props.warmupCron ?? 'cron(30 23 ? * SUN-THU *)';
    // Default disabled: rule is created but inert until Admin Console enables it.
    // Reason: "almost never tested" state — daily 11h warm-up burns GPU for no use.
    const dailyScheduleEnabled = props.dailyScheduleEnabled ?? false;

    new events.Rule(this, 'DailyWarmupSchedule', {
      ruleName: DAILY_WARMUP_RULE_NAME,
      description: 'Daily warm-up reservation at 08:30 KST Mon-Fri (all models, 11h)',
      schedule: events.Schedule.expression(warmupCron),
      enabled: dailyScheduleEnabled,
      targets: [
        new targets.LambdaFunction(reserveFn, {
          event: events.RuleTargetInput.fromObject({
            alias: 'all',
            durationSecs: scheduledDuration,
            requester: 'scheduler',
          }),
        }),
      ],
    });

    // ── Outputs ────────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ReserveFnArn', {
      value: reserveFn.functionArn,
      description: 'aws lambda invoke --function-name genai-gw-reserve --payload ...',
    });
    new cdk.CfnOutput(this, 'ReservationsTableName', {
      value: table.tableName,
    });
    new cdk.CfnOutput(this, 'AllAliases', {
      value: allAliases.join(', '),
      description: 'Aliases managed by reservation system',
    });
    new cdk.CfnOutput(this, 'DailyWarmupRuleName', {
      value: DAILY_WARMUP_RULE_NAME,
      description: 'EventBridge rule — toggle via Admin Console or: aws events {enable,disable}-rule',
    });
    new cdk.CfnOutput(this, 'DailyWarmupRuleInitialState', {
      value: dailyScheduleEnabled ? 'ENABLED' : 'DISABLED',
      description: 'Initial state of DailyWarmupSchedule on this deploy',
    });
  }
}
