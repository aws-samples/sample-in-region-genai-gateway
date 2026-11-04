/**
 * GenAiGwAdminConsoleStack — vLLM warm-up 관리 Admin Dashboard
 *
 * 구성:
 *   - FastAPI ECS Fargate (admin-console/)
 *   - Internal ALB → admin.genai-gw.internal (Route53 PHZ)
 *   - HTTPS 443 via ACM cert (GenAiGwCertStack과 동일 인증서)
 *   - Admin Password: Secrets Manager /genai-gw/gateway/admin-password
 *   - K8s 접근: EKS AccessEntry (deployment 상태 조회)
 */
import * as cdk from 'aws-cdk-lib/core';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { Construct } from 'constructs';
import { VllmModelConfig } from '../../config/models';

export interface AdminConsoleStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  cluster: eks.Cluster;
  vllmModels: VllmModelConfig[];
  reservationsTableName: string;
  cooldownSfnArn: string;
  clusterName: string;
  certificateArn?: string;
  namespace?: string;
  /** EventBridge rule name for daily warm-up schedule — Admin Console toggles enable/disable. */
  dailyWarmupRuleName: string;
}

export class AdminConsoleStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: AdminConsoleStackProps) {
    super(scope, id, props);

    const namespace  = props.namespace ?? 'vllm';
    const allAliases = props.vllmModels.filter(m => m.minReplicas === 0).map(m => m.alias);

    // ── Admin password secret ──────────────────────────────────────────────────

    const adminSecret = new secretsmanager.Secret(this, 'AdminSecret', {
      secretName: '/genai-gw/gateway/admin-password',
      description: 'GenAI Gateway Admin Console password',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 20,
      },
    });

    // ── ECS task role ──────────────────────────────────────────────────────────

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
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
        DdbAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:Query', 'dynamodb:DeleteItem'],
              resources: [
                `arn:aws:dynamodb:ap-northeast-2:${this.account}:table/${props.reservationsTableName}`,
                `arn:aws:dynamodb:ap-northeast-2:${this.account}:table/${props.reservationsTableName}/index/*`,
              ],
            }),
          ],
        }),
        SfnAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['states:StartExecution'],
              resources: [props.cooldownSfnArn],
            }),
          ],
        }),
        EventsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['events:DescribeRule', 'events:EnableRule', 'events:DisableRule'],
              resources: [
                `arn:aws:events:ap-northeast-2:${this.account}:rule/${props.dailyWarmupRuleName}`,
              ],
            }),
          ],
        }),
      },
    });
    adminSecret.grantRead(taskRole);

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // EKS access entry for task role
    new eks.AccessEntry(this, 'AdminTaskAccessEntry', {
      cluster: props.cluster,
      principal: taskRole.roleArn,
      accessPolicies: [
        eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
          accessScopeType: eks.AccessScopeType.CLUSTER,
        }),
      ],
    });

    // ── ECS cluster + task def ─────────────────────────────────────────────────

    const ecsCluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: 'genai-gw-admin-console',
    });

    const image = new ecr_assets.DockerImageAsset(this, 'AdminImage', {
      directory: path.join(__dirname, '../../admin-console'),
      platform: ecr_assets.Platform.LINUX_AMD64,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole,
      executionRole,
    });

    taskDef.addContainer('admin', {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      environment: {
        EKS_REGION:            'ap-northeast-2',
        RESERVATIONS_TABLE:    props.reservationsTableName,
        COOLDOWN_SFN_ARN:      props.cooldownSfnArn,
        ADMIN_SECRET_ARN:      adminSecret.secretArn,
        EKS_CLUSTER_NAME:      props.clusterName,
        K8S_NAMESPACE:         namespace,
        ALL_ALIASES:           JSON.stringify(allAliases),
        DAILY_WARMUP_RULE:     props.dailyWarmupRuleName,
      },
      portMappings: [{ containerPort: 8080, name: 'admin' }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'admin-console' }),
    });

    // ── ALB + SG ───────────────────────────────────────────────────────────────

    const albSG = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc: props.vpc,
      description: 'Admin Console Internal ALB',
      allowAllOutbound: true,
    });
    albSG.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(443));
    albSG.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(8080));

    const ecsSG = new ec2.SecurityGroup(this, 'EcsSG', {
      vpc: props.vpc,
      description: 'Admin Console ECS tasks',
      allowAllOutbound: true,
    });
    ecsSG.addIngressRule(albSG, ec2.Port.tcp(8080));

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: albSG,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const service = new ecs.FargateService(this, 'Service', {
      cluster: ecsCluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [ecsSG],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
    });

    const healthCheck = {
      path: '/health/liveliness',
      interval: cdk.Duration.seconds(30),
      healthyHttpCodes: '200',
    };

    if (props.certificateArn) {
      const httpsListener = this.alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)],
        open: false,
      });
      httpsListener.addTargets('Target', {
        port: 8080,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck,
      });
    } else {
      const httpListener = this.alb.addListener('Listener', {
        port: 8080,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
      });
      httpListener.addTargets('Target', {
        port: 8080,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck,
      });
    }

    const scheme = props.certificateArn ? 'https' : 'http';
    const port   = props.certificateArn ? '443' : '8080';
    new cdk.CfnOutput(this, 'AdminConsoleUrl', {
      value: `${scheme}://${this.alb.loadBalancerDnsName}:${port}`,
      description: 'Admin Console URL (VPN 필요) — admin.genai-gw.internal after DNS setup',
    });
    new cdk.CfnOutput(this, 'AdminPasswordCmd', {
      value: `aws secretsmanager get-secret-value --secret-id /genai-gw/gateway/admin-password --query SecretString --output text --region ap-northeast-2 | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])"`,
      description: 'Retrieve admin password',
    });
  }
}
