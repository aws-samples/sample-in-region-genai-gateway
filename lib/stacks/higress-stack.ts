import * as cdk from 'aws-cdk-lib/core';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface HigressStackProps extends cdk.StackProps {
  /** Shared EKS Auto Mode cluster (from EksClusterStack). Higress installs here. */
  cluster: eks.Cluster;
  /**
   * ACM certificate ARN for the internal NLB's TLS 443 listener.
   * Reuses the self-signed wildcard cert (*.genai-gw.internal) from CertStack —
   * the same cert that fronts the SmartRouter ALB.
   */
  certificateArn: string;
  /** Higress umbrella Helm chart version. Pin deliberately; do NOT float. */
  higressChartVersion?: string;
  /**
   * Container image hub + tags for digest/version pinning.
   * Left undefined here = chart defaults (Aliyun registry, chart appVersion).
   * Populate after mirroring images into ECR and pinning digests.
   */
  imageHub?: string;
  gatewayImageTag?: string;
  controllerImageTag?: string;
  consoleImageTag?: string;
}

/**
 * GenAiGwHigressStack — installs Higress (OSS AI gateway) onto the shared EKS Auto Mode
 * cluster. This is the LLM gateway: it fronts the vLLM + Bedrock providers and does
 * the Anthropic↔OpenAI translation and key-auth.
 *
 * ── Why this stack is "thin" (the Karpenter pattern) ───────────────────────────
 * `cluster.addHelmChart()` / `cluster.addManifest()` scope their resources under the
 * *cluster* construct, so the synthesized Custom::AWSCDK-EKS-* resources land in the
 * cluster's owning stack (GenAiGwEksStack), NOT this stack — exactly like GenAiGwKarpenterStack
 * (its NodePools synthesize into GenAiGwEksStack; its own template is ~1KB). This stack
 * therefore exists to (a) own the deploy-ordering dependency edge, (b) carry the
 * Helm release + the hand-written internal-NLB Service, and (c) hold the CDK-native
 * Bedrock IAM user / Secrets Manager wiring that DOES belong in its own stack.
 *
 * ── Exposure design (internal NLB + ACM) ──────────────────────────────────────
 * The chart's built-in gateway Service is suppressed (`gateway.service.type=None`) and
 * we attach our own Service(type=LoadBalancer) annotated as an internal NLB that
 * terminates TLS on 443 with the existing ACM cert and forwards PLAINTEXT to the
 * gateway's Envoy HTTP listener on pod port 80. This mirrors how vLLM is already
 * exposed in this repo (internal NLB via aws-load-balancer-* annotations on EKS Auto
 * Mode) and needs zero new CRDs / no AWS Load Balancer Controller install.
 *
 * The NLB DNS name is only known post-deploy (k8s provisions it). Like the vLLM NLBs,
 * it is fed back into SmartRouter's upstream via the `higressEndpoint` context value
 * post-deploy — there is no CDK-native LB object to alias in DnsStack.
 *
 * ── AI routing (why the console is kept) ──────────────────────────────────────
 * Higress AI provider/route config is NOT a single user-authorable CRD — the console
 * backend compiles each route into a ConfigMap + EnvoyFilter + WasmPlugin, and it is
 * ONLY expressible through the higress-console REST API (POST /v1/ai/{providers,routes}).
 * So the umbrella chart's bundled console is REQUIRED and the provider/route config is
 * applied imperatively post-deploy against the console Service
 * (ClusterIP higress-console.<ns>:8080).
 *
 * Note: the vLLM-failure → Bedrock fallback is owned by SmartRouter (boto3 direct
 * Bedrock /v1/messages), NOT a Higress route fallbackConfig — Higress ai-proxy 2.0.0
 * cannot sign Bedrock's /v1/messages (SigV4 scope error, higress#3809).
 */
export class HigressStack extends cdk.Stack {
  /** Kubernetes namespace Higress is installed into. */
  public static readonly NAMESPACE = 'higress-system';
  /** Gateway pod selector labels (chart 2.2.2 defaults) — our NLB Service targets these. */
  public static readonly GATEWAY_SELECTOR = {
    app: 'higress-gateway',
    higress: `${HigressStack.NAMESPACE}-higress-gateway`,
  };
  /** In-cluster console REST API base (the applier applies provider/route config here). */
  public static readonly CONSOLE_SVC = `higress-console.${HigressStack.NAMESPACE}.svc.cluster.local:8080`;
  /** Name of the hand-written internal-NLB Service (kubectl get svc target for DNS lookup). */
  public static readonly GATEWAY_NLB_SVC = 'higress-gateway-nlb';
  /**
   * Secrets Manager secret holding the Bedrock provider's static AK/SK.
   * JSON: { "accessKeyId": "...", "secretAccessKey": "..." }. The applier reads this
   * and injects it into the bedrock provider's rawConfigs at apply-time — the keys
   * NEVER appear in CDK output, git, or the provider config generator.
   */
  public static readonly BEDROCK_CREDS_SECRET = '/genai-gw/higress/bedrock-creds';

  /**
   * Secrets Manager secret holding the gateway's consumer API key (key-auth).
   * JSON: { "key": "<32-char token>" }. Owned by THIS stack and generated at deploy
   * time. The applier (scripts/apply-higress.sh) reads `.key` and registers it as a
   * `key-auth` consumer credential (HEADER x-api-key) at apply-time; the token never
   * lands in CDK output, git, or the config generator. Clients (Claude Code via
   * SmartRouter) send it as the `x-api-key` header — the Anthropic SDK's auth header,
   * passed through unmodified.
   */
  public static readonly MASTER_KEY_SECRET = '/genai-gw/higress/master-key';
  /** The consumer name registered for key-auth. Routes allow exactly this consumer. */
  public static readonly CONSUMER_NAME = 'genai-gw';

  /** The Bedrock-credentials secret (created here so callers can grantRead if needed). */
  public readonly bedrockCredentialsSecret: secretsmanager.Secret;

  /** The consumer API-key secret (created here so SmartRouter/test-client can grantRead). */
  public readonly masterKeySecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: HigressStackProps) {
    super(scope, id, props);

    const { cluster, certificateArn } = props;
    const ns = HigressStack.NAMESPACE;

    // Pin Higress to non-GPU capacity. The default Karpenter NodePool is UNTAINTED
    // (c/m/r families, system workloads); the GPU pool carries a 'vllm-gpu' taint that
    // Higress pods do NOT tolerate — so gateway/controller/console schedule onto the
    // default pool automatically. No nodeSelector needed; the GPU taint is the guard.
    // Cross-component values are passed under the `higress-core.*` / `higress-console.*`
    // subchart prefixes because the umbrella `higress` chart has no values.yaml of its own.
    const values: Record<string, any> = {
      'higress-core': {
        gateway: {
          // Suppress the chart's own gateway Service entirely — we attach our own
          // internal-NLB Service below. 'None' makes the chart render no Service at all
          // (service.yaml is wrapped in `if not (eq .type "None")`), leaving the field clear.
          service: { type: 'None' },
          // HA: 2 gateway replicas. Pinned to non-GPU nodes via the GPU-taint guard above.
          replicas: 2,
          ...(props.imageHub ? { hub: props.imageHub } : {}),
          ...(props.gatewayImageTag ? { tag: props.gatewayImageTag } : {}),
        },
        controller: {
          replicas: 2,
          ...(props.imageHub ? { hub: props.imageHub } : {}),
          ...(props.controllerImageTag ? { tag: props.controllerImageTag } : {}),
        },
      },
      'higress-console': {
        // Console is REQUIRED (cross-provider fallbackConfig is console-only). HA = 2.
        replicaCount: 2,
        ...(props.imageHub || props.consoleImageTag ? {
          image: {
            ...(props.imageHub ? { repository: `${props.imageHub}/console` } : {}),
            ...(props.consoleImageTag ? { tag: props.consoleImageTag } : {}),
          },
        } : {}),
      },
    };

    // Higress umbrella chart (gateway + controller + console). Bundled console exposes
    // the /v1/ai/* REST API the applier uses for provider/route config.
    const higressChart = cluster.addHelmChart('Higress', {
      chart: 'higress',
      repository: 'https://higress.io/helm-charts',
      release: 'higress',
      namespace: ns,
      version: props.higressChartVersion ?? '2.2.2',
      createNamespace: true,
      // Wait for the release to converge so the gateway pods exist before the NLB
      // Service tries to bind targets. Generous timeout for first-pull on a fresh cluster.
      wait: true,
      timeout: cdk.Duration.minutes(15),
      values,
    });

    // Hand-written internal NLB Service for the gateway data-plane.
    // - TLS 443 terminated at the NLB with the existing ACM cert (ssl-cert annotation),
    //   forwarding PLAINTEXT to the gateway's Envoy HTTP listener on pod port 80.
    // - 'external'/'internal'/'ip' annotations mirror the working vLLM NLB pattern on
    //   EKS Auto Mode (managed LB provisioning; no self-managed LB controller).
    // - Selector matches ONLY the gateway pods (chart 2.2.2 default labels), never the
    //   controller (app: higress-controller) or console (app.kubernetes.io/name: ...).
    const gatewayNlb = cluster.addManifest('HigressGatewayNlb', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: HigressStack.GATEWAY_NLB_SVC,
        namespace: ns,
        annotations: {
          'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
          'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internal',
          'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'ip',
          // NLB terminates TLS with the ACM cert; backend traffic to the pod is plaintext.
          'service.beta.kubernetes.io/aws-load-balancer-ssl-cert': certificateArn,
          'service.beta.kubernetes.io/aws-load-balancer-ssl-ports': '443',
          'service.beta.kubernetes.io/aws-load-balancer-backend-protocol': 'tcp',
        },
      },
      spec: {
        type: 'LoadBalancer',
        selector: HigressStack.GATEWAY_SELECTOR,
        // 443 (NLB, TLS) -> targetPort 80 (Envoy plaintext HTTP L7 listener).
        // targetPort is numeric: the gateway pod has no *named* port 'http' on a cloud
        // install (the named containerPort block renders only for local/kind), but Envoy
        // binds 80 at runtime, so a numeric targetPort:80 is the correct, robust target.
        ports: [{ name: 'https', port: 443, targetPort: 80, protocol: 'TCP' }],
      },
    });
    // The Service can only bind targets once the gateway pods exist.
    gatewayNlb.node.addDependency(higressChart);

    // ── Bedrock auth (static AK/SK → Secrets Manager) ──────────────────────────────
    // Higress' ai-proxy bedrock backend supports ONLY static AWS credentials — there is
    // no IRSA / credential-chain path in its bedrock.go. So the gateway needs a long-lived
    // access key. We mint a dedicated least-privilege IAM user, generate one access key,
    // and stash AK/SK in Secrets Manager. The applier reads the secret and injects it into
    // the bedrock provider's rawConfigs at apply-time, so the keys never touch git, CDK
    // output, or the config generator.
    const bedrockUser = new iam.User(this, 'BedrockGatewayUser', {
      userName: 'genai-gw-higress-bedrock',
    });
    // Least-privilege scope: in-region (Seoul) foundation models only — data residency requires
    // inference to stay in ap-northeast-2, and this keeps the key off cross-region
    // inference profiles even if it leaks.
    bedrockUser.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/*`],
    }));

    const bedrockAccessKey = new iam.AccessKey(this, 'BedrockGatewayAccessKey', {
      user: bedrockUser,
    });

    // Secret value is assembled from the access key's unsafe-unwrapped SK (CDK keeps it
    // out of the synthesized template via a dynamic reference — it resolves at deploy time).
    this.bedrockCredentialsSecret = new secretsmanager.Secret(this, 'BedrockCredentials', {
      secretName: HigressStack.BEDROCK_CREDS_SECRET,
      description: 'Static AK/SK for the Higress ai-proxy Bedrock provider (in-region Seoul, InvokeModel only)',
      secretObjectValue: {
        accessKeyId: cdk.SecretValue.unsafePlainText(bedrockAccessKey.accessKeyId),
        secretAccessKey: bedrockAccessKey.secretAccessKey,
      },
    });

    new cdk.CfnOutput(this, 'BedrockCredsSecret', {
      value: HigressStack.BEDROCK_CREDS_SECRET,
      description: 'Secrets Manager id holding Bedrock AK/SK — the applier injects this into the bedrock provider',
    });

    // ── consumer key-auth (gateway API key → Secrets Manager) ──────────────────────
    // The gateway authenticates clients with a single shared key-auth consumer credential.
    // We mint a 32-char token here at deploy time. The applier (apply-higress.sh) reads
    // `.key`, POSTs a single `key-auth` consumer (HEADER x-api-key), and stamps
    // `authConfig.allowedConsumers` onto every AI route — so an unauthenticated request
    // and an unknown key both get 401. The token never appears in the synthesized
    // template (generateSecretString resolves at deploy time).
    this.masterKeySecret = new secretsmanager.Secret(this, 'HigressMasterKey', {
      secretName: HigressStack.MASTER_KEY_SECRET,
      description: 'Higress gateway consumer API key (key-auth, HEADER x-api-key) for In-Region GenAI Gateway',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'key',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    new cdk.CfnOutput(this, 'MasterKeySecret', {
      value: HigressStack.MASTER_KEY_SECRET,
      description: 'Secrets Manager id holding the gateway API key — the applier registers it as a key-auth consumer',
    });

    new cdk.CfnOutput(this, 'HigressNlbLookup', {
      value: `kubectl get svc -n ${ns} ${HigressStack.GATEWAY_NLB_SVC} -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'`,
      description: 'Internal NLB DNS for the Higress gateway — set as SmartRouter upstream (higressEndpoint)',
    });
    new cdk.CfnOutput(this, 'HigressConsoleSvc', {
      value: HigressStack.CONSOLE_SVC,
      description: 'In-cluster console REST API (the applier applies provider/route config here)',
    });
  }
}
