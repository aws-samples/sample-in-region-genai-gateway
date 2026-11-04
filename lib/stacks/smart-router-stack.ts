import * as cdk from 'aws-cdk-lib/core';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'path';
import { Construct } from 'constructs';
import { BedrockModelConfig, BEDROCK_MODELS } from '../../config/models';

export interface SmartRouterStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  /**
   * Internal DNS of the upstream Higress gateway (without scheme/port) — its internal
   * NLB, which terminates TLS on 443 with the self-signed ACM cert. Empty on a fresh
   * deploy (the NLB DNS is only known post-deploy); fed in via bin's higressEndpoint
   * context once the gateway exists, then this stack is redeployed.
   */
  upstreamEndpoint: string;
  /** Phase 8: ACM certificate ARN for HTTPS 443. HTTP-only when omitted. */
  certificateArn?: string;
  /**
   * Bedrock-direct fallback target. When the gateway (Higress) is unreachable or returns
   * an error on /v1/messages, the router bypasses the gateway and calls Bedrock's native
   * Anthropic endpoint directly (Higress ai-proxy 2.0.0 mis-signs SigV4 for Bedrock's
   * /v1/messages — higress#3809). Defaults to the first BEDROCK_MODELS entry (Haiku 3 —
   * the least-throttled Seoul on-demand pool; see config/models.ts). The router uses the
   * ECS task role's credential chain.
   */
  bedrockFallbackModel?: BedrockModelConfig;
  /**
   * Secondary Bedrock-direct fallback target for a cascading in-region fallback. When the
   * primary on-demand model momentarily saturates and throttles (`Too many connections`),
   * the router transparently retries on this model, which has a separate on-demand capacity
   * pool. Defaults to the second BEDROCK_MODELS entry (Sonnet 3.5 — higher quality but a
   * heavily-throttled Seoul pool, hence the backup). Best-effort availability for the
   * cold-start path. Set to skip by passing a model with an empty id.
   */
  bedrockFallbackModelSecondary?: BedrockModelConfig;
  /**
   * Per-alias vLLM internal NLB endpoints (the same `vllmEndpoints` map the Higress providers use).
   * When provided, the router does a fast /health pre-flight against the target alias's vLLM
   * NLB BEFORE calling the gateway: a cold alias (scaled to zero = zero healthy NLB targets)
   * is detected in ~2s and the request goes straight to the Bedrock-direct fallback, instead
   * of letting Envoy hang ~40s on the dead upstream. Empty (the default) disables the pre-flight
   * and the router relies solely on the reactive gateway fallback (the public-repo behaviour).
   */
  vllmEndpoints?: Record<string, string>;
  /**
   * Per-alias vLLM context window (maxModelLen) map. The router clamps an incoming
   * `max_tokens` to fit `maxModelLen - reserve` before the gateway POST, so a warm alias
   * accepts Claude Code's large fixed max_tokens (e.g. 32000) instead of 400-ing on
   * `input + output > maxModelLen` and silently falling back to Bedrock (warm path bypassed).
   * Empty (default) disables the clamp (no-op) — e.g. the public-repo default. Built from
   * VLLM_MODELS in bin (alias → maxModelLen).
   */
  vllmMaxModelLen?: Record<string, number>;
  /**
   * TEST-ONLY fault injection. When true, the router honors the `x-genai-gw-test-throttle-primary`
   * request header by raising a SYNTHETIC throttle on the primary Bedrock model, forcing a
   * deterministic, live cascade to the secondary (Haiku 3) — used by scripts/system-test.sh's
   * S-cascade to verify the real end-to-end cascade. Defaults to false: on a production deploy
   * the header is ignored entirely (no test surface). Set via `-c faultInjection=true`.
   */
  faultInjection?: boolean;
}

export class SmartRouterStack extends cdk.Stack {
  /** Internal ALB DNS for the Smart Router — set as ANTHROPIC_BASE_URL for `general` use */
  public readonly albDnsName: string;
  /** ALB object — required by DnsStack for Route53 alias records */
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: SmartRouterStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: 'genai-gw-smart-router',
    });

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Runtime task role — the router's boto3 bedrock-runtime client resolves credentials
    // from this role (no static keys). Least-privilege: only InvokeModel* on the fallback
    // foundation models, in their region.
    const fallbackModel = props.bedrockFallbackModel ?? BEDROCK_MODELS[0];
    const bedrockRegion = fallbackModel.awsRegion ?? this.region;
    // Cascading fallback: when the primary (Haiku 3) on-demand pool is momentarily saturated
    // and throttles with `Too many connections`, the router retries on this secondary model
    // (Sonnet 3.5). Haiku 3 and Sonnet 3.5 have SEPARATE on-demand capacity pools (RPM quotas
    // 400 vs 50). Haiku is primary because the Seoul Sonnet pool is heavily throttled (~93%
    // vs Haiku ~43%, measured 2026-06-14) — the cold path optimizes availability over quality.
    // Best-effort in-region answer while the warm vLLM model spins up. Both Seoul IN_REGION.
    const secondaryFallbackModel = props.bedrockFallbackModelSecondary ?? BEDROCK_MODELS[1];
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const fallbackModelArns = [
      `arn:aws:bedrock:${bedrockRegion}::foundation-model/${fallbackModel.bedrockModelId}`,
    ];
    if (secondaryFallbackModel) {
      const secondaryRegion = secondaryFallbackModel.awsRegion ?? this.region;
      fallbackModelArns.push(
        `arn:aws:bedrock:${secondaryRegion}::foundation-model/${secondaryFallbackModel.bedrockModelId}`,
      );
    }
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: fallbackModelArns,
    }));

    // Build image from smart-router/Dockerfile — force amd64 for Fargate (Mac arm64 build host)
    const image = new ecr_assets.DockerImageAsset(this, 'RouterImage', {
      directory: path.join(__dirname, '../../smart-router'),
      platform: ecr_assets.Platform.LINUX_AMD64,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole,
      taskRole,
    });

    const upstreamScheme = props.certificateArn ? 'https' : 'http';
    const upstreamPort   = props.certificateArn ? '443'  : '4000';

    // When an ACM-imported self-signed certificate fronts the internal upstream
    // endpoint (https — the Higress gateway NLB), the router must skip TLS verification
    // for that self-signed chain. Traffic is confined to the VPC CIDR by the security
    // groups below. Over plain http there is no TLS, so verification stays at its
    // secure default.
    const verifyTls = props.certificateArn ? 'false' : 'true';

    taskDef.addContainer('router', {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      environment: {
        // router.py reads GATEWAY_BASE_URL as its upstream base; the value points at the
        // Higress gateway NLB (`upstreamEndpoint`).
        GATEWAY_BASE_URL: `${upstreamScheme}://${props.upstreamEndpoint}:${upstreamPort}`,
        VERIFY_TLS: verifyTls,
        // Bedrock-direct fallback (gateway bypass on /v1/messages). Setting this enables
        // the fallback in router.py; the model + region match the IAM grant above.
        BEDROCK_FALLBACK_MODEL_ID: fallbackModel.bedrockModelId,
        // Cascading secondary: retried on a primary throttle (separate on-demand pool).
        BEDROCK_FALLBACK_MODEL_ID_SECONDARY: secondaryFallbackModel?.bedrockModelId ?? '',
        AWS_REGION: bedrockRegion,
        // Per-alias vLLM NLB endpoints for the cold-vLLM pre-flight (router.py probes
        // /health here before the gateway; cold alias → straight to Bedrock, no ~40s hang).
        // Empty string disables the pre-flight (public-repo default: reactive fallback only).
        VLLM_ENDPOINTS: JSON.stringify(props.vllmEndpoints ?? {}),
        // Per-alias maxModelLen for the warm-path max_tokens clamp (router.py): a large
        // Claude-Code max_tokens is clamped to fit the target alias's context window so a
        // warm vLLM alias serves it directly instead of 400-ing → Bedrock fallback. Empty
        // map disables the clamp (no-op). reserve/floor tunable via the two envs below.
        VLLM_MAX_MODEL_LEN: JSON.stringify(props.vllmMaxModelLen ?? {}),
        // TEST-ONLY: enable the synthetic-throttle header so S-cascade can force a live
        // Sonnet→Haiku cascade. Defaults to "false" → header ignored (production has no
        // test surface). Toggled via `-c faultInjection=true` on the test deploy only.
        BEDROCK_FAULT_INJECTION: props.faultInjection ? 'true' : 'false',
      },
      portMappings: [{ containerPort: 8080, name: 'router' }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'smart-router' }),
    });

    const albSG = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc: props.vpc,
      description: 'SmartRouter Internal ALB - allow from VPC',
      allowAllOutbound: true,
    });
    albSG.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(4000));
    albSG.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(443));

    const ecsSG = new ec2.SecurityGroup(this, 'EcsSG', {
      vpc: props.vpc,
      description: 'SmartRouter ECS tasks - allow from ALB',
      allowAllOutbound: true,
    });
    ecsSG.addIngressRule(albSG, ec2.Port.tcp(8080));

    const albInstance = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: albSG,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // The Bedrock-direct fallback streams keepalive pings so the streaming path never
      // idles (router.py). But a NON-streaming cold fallback is one blocking call with no
      // intermediate bytes; under load a long agentic generation can exceed the ALB's 60s
      // default and surface a spurious 504. Raise the idle timeout to 180s as a backstop —
      // still well under the router's 600s upstream read timeout.
      idleTimeout: cdk.Duration.seconds(180),
    });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
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
      // Phase 8: HTTPS 443
      const httpsListener = albInstance.addListener('HttpsListener', {
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
      const httpListener = albInstance.addListener('Listener', {
        port: 4000,
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

    this.albDnsName = albInstance.loadBalancerDnsName;
    this.alb = albInstance;

    const scheme = props.certificateArn ? 'https' : 'http';
    const port   = props.certificateArn ? '443' : '4000';
    new cdk.CfnOutput(this, 'SmartRouterEndpoint', {
      value: `${scheme}://${albInstance.loadBalancerDnsName}:${port}`,
      description: 'ANTHROPIC_BASE_URL for `general` alias routing',
    });
  }
}
