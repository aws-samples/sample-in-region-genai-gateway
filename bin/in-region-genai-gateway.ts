#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EksClusterStack } from '../lib/stacks/eks-cluster-stack';
import { KarpenterStack } from '../lib/stacks/karpenter-stack';
import { VllmStack } from '../lib/stacks/vllm-stack';
import { SmartRouterStack } from '../lib/stacks/smart-router-stack';
import { CertStack } from '../lib/stacks/cert-stack';
import { DnsStack } from '../lib/stacks/dns-stack';
import { WarmupStack } from '../lib/stacks/warmup-stack';
import { ReservationStack, DAILY_WARMUP_RULE_NAME } from '../lib/stacks/reservation-stack';
import { AdminConsoleStack } from '../lib/stacks/admin-console-stack';
import { TestClientStack } from '../lib/stacks/test-client-stack';
import { HigressStack } from '../lib/stacks/higress-stack';
import { VLLM_MODELS, BEDROCK_MODELS } from '../config/models';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'ap-northeast-2', // data residency: 서울 고정 (환경 변수로 변경 불가)
};

// Read a context value that may arrive as a real JSON value (from cdk.json /
// cdk.context.json) or as a string (from the CLI `-c key=value`, which always
// passes strings). When it's a string, JSON.parse it so `-c operatorRoleArns='[...]'`
// and `-c vllmEndpoints='{...}'` work the same as the cdk.json defaults.
function getJsonContext<T>(key: string, fallback: T): T {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') return raw as T;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch (e) {
    throw new Error(
      `Context "${key}" must be valid JSON when passed via -c (got: ${raw}). ` +
      `Example: -c ${key}='${JSON.stringify(fallback)}'`,
    );
  }
}

const clusterName  = app.node.tryGetContext('clusterName') ?? 'genai-gw';
const GATEWAY_ZONE = 'genai-gw.internal';
const GATEWAY_DOMAIN = `*.${GATEWAY_ZONE}`;

// vllmEndpoints: per-alias NLB DNS map. Consumed by the Higress applier
// (apply-higress.sh) to register the vLLM providers and by SmartRouter's cold-vLLM
// pre-flight. First deploy: omit — providers are applied post-deploy once the NLBs exist.
// After VllmStack deploy, get each NLB DNS:
//   kubectl get svc -n vllm <servingName>-nlb -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
// Then set via cdk.json context or the CLI:
//   "vllmEndpoints": { "coding": "http://internal-xxx.elb.amazonaws.com", "ocr": "..." }
//   -c vllmEndpoints='{"coding":"http://internal-xxx.elb.amazonaws.com"}'
// and redeploy GenAiGwSmartRouterStack (and re-run apply-higress.sh).
const vllmEndpoints = getJsonContext<Record<string, string>>('vllmEndpoints', {});

// operatorRoleArns: IAM role ARNs granted AmazonEKSClusterAdminPolicy for break-glass kubectl.
// Default [] in cdk.json; override via cdk.json/cdk.context.json or the CLI:
//   -c operatorRoleArns='["arn:aws:iam::123456789012:role/Admin"]'
const operatorRoleArns = getJsonContext<string[]>('operatorRoleArns', []);

// higressEndpoint: internal NLB DNS of the Higress gateway — the SmartRouter upstream.
// The NLB is provisioned by k8s post-deploy (no CDK token), so its DNS is fed in like
// vllmEndpoints rather than referenced cross-stack. First deploy: omit — SmartRouter
// synthesizes with an empty upstream and is redeployed once the gateway NLB exists:
//   kubectl get svc -n higress-system higress-gateway-nlb \
//     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
//   -c higressEndpoint=internal-xxx.elb.amazonaws.com   (host only, no scheme/port)
// then redeploy GenAiGwSmartRouterStack to point it at the gateway.
const higressEndpoint = (app.node.tryGetContext('higressEndpoint') ?? '').toString().trim();

// faultInjection: TEST-ONLY. Enables the SmartRouter's synthetic-throttle header so the
// system-test harness's S-cascade can force a deterministic, live primary→secondary cascade.
// Defaults to false (production: no test surface). Set via `-c faultInjection=true`.
const faultInjection = ['true', '1', 'yes'].includes(
  (app.node.tryGetContext('faultInjection') ?? '').toString().toLowerCase(),
);

// coldFallbackOrder: which Bedrock model the cold path tries FIRST.
//   'quality'      (DEFAULT) → Sonnet 3.5 primary, Haiku 3 secondary. Higher quality; the
//                              Seoul Sonnet pool is more throttled so the cold start can be
//                              slower (16–93 s) — accepted as the default since this gateway
//                              optimizes for accuracy, not speed.
//   'availability'           → Haiku 3 primary, Sonnet 3.5 secondary. Faster/less-throttled
//                              pool (4–6 s) at lower quality. For customers who value cold-
//                              start latency over quality.
// Either way the two models are just BEDROCK_MODELS reordered; both stay Seoul IN_REGION.
// Set via `-c coldFallbackOrder=availability`. For production-grade speed AND quality, warm up
// the vLLM alias so the self-hosted model serves directly (the cold path is best-effort).
const coldFallbackOrder = (app.node.tryGetContext('coldFallbackOrder') ?? 'quality')
  .toString().toLowerCase();
if (!['quality', 'availability'].includes(coldFallbackOrder)) {
  throw new Error(
    `coldFallbackOrder must be 'quality' or 'availability', got '${coldFallbackOrder}'`,
  );
}
// BEDROCK_MODELS defaults to quality-first ([0]=Sonnet, [1]=Haiku). 'availability' swaps them.
const [bedrockPrimary, bedrockSecondary] =
  coldFallbackOrder === 'availability'
    ? [BEDROCK_MODELS[1], BEDROCK_MODELS[0]]
    : [BEDROCK_MODELS[0], BEDROCK_MODELS[1]];

const networkStack = new NetworkStack(app, 'GenAiGwNetworkStack', { env, clusterName });

const eksStack = new EksClusterStack(app, 'GenAiGwEksStack', {
  env,
  vpc: networkStack.vpc,
  clusterName,
  operatorRoleArns,
});
eksStack.addDependency(networkStack);

const karpenterStack = new KarpenterStack(app, 'GenAiGwKarpenterStack', {
  env,
  cluster: eksStack.cluster,
});
karpenterStack.addDependency(eksStack);

// Deployment order: coding → ocr → video → longcontext → math → audio (PE&D priority)
// Each scenario gets its own instance for fault isolation and independent scaling (min=0 for cost).
// Deploy selectively: cdk deploy GenAiGwVllm-Coding (others remain dormant)
const vllmStacksConfig = [
  { id: 'GenAiGwVllm-Coding',       model: VLLM_MODELS['coding'] },
  { id: 'GenAiGwVllm-Ocr',          model: VLLM_MODELS['ocr'] },
  { id: 'GenAiGwVllm-Video',        model: VLLM_MODELS['video'] },
  { id: 'GenAiGwVllm-Longcontext',  model: VLLM_MODELS['longcontext'] },
  { id: 'GenAiGwVllm-Math',         model: VLLM_MODELS['math'] },
  { id: 'GenAiGwVllm-Audio',        model: VLLM_MODELS['audio'] },
];

for (const { id, model } of vllmStacksConfig) {
  const vllmStack = new VllmStack(app, id, {
    env,
    cluster: eksStack.cluster,
    efsFs: eksStack.efs,
    model,
    vllmNamespaceManifest: eksStack.vllmNamespaceManifest,
    modelCacheBucketName: eksStack.modelCacheBucket.bucketName,
    hfTokenSpcDependency: eksStack.hfTokenSpcManifest,
  });
  vllmStack.addDependency(karpenterStack);
}

// Phase 8: self-signed wildcard cert for *.genai-gw.internal
// CertStack runs first — imports cert into ACM, stores CA cert in Secrets Manager.
// Skip GenAiGwCertStack on first deploy (Phases 0-7); add back for Phase 8.
const certStack = new CertStack(app, 'GenAiGwCertStack', {
  env,
  domain: GATEWAY_DOMAIN,
  baseDomain: GATEWAY_ZONE,
});
certStack.addDependency(networkStack);

// Higress AI gateway — the LLM gateway. Installs Higress onto
// the shared EKS Auto Mode cluster; the Helm release + internal-NLB Service synthesize
// into GenAiGwEksStack (the cluster's owning stack) per addHelmChart scoping, while this stack
// owns the deploy-ordering edge and the Bedrock IAM user / consumer-key Secrets.
// Provider/route/key-auth config is applied post-deploy via scripts/apply-higress.sh.
const higressStack = new HigressStack(app, 'GenAiGwHigressStack', {
  env,
  cluster: eksStack.cluster,
  certificateArn: certStack.certificateArn,
});
higressStack.addDependency(eksStack);
higressStack.addDependency(certStack);

// SmartRouter: intercepts `general` alias → detects scenario → rewrites to coding/math/video/...
// Phase 8: HTTPS 443 via ACM cert.
// ANTHROPIC_BASE_URL=https://gateway.genai-gw.internal (via DnsStack Route53 PHZ)
// Upstream is the Higress internal NLB — fed in via `-c higressEndpoint=<NLB DNS>` after the
// gateway NLB is provisioned (k8s post-deploy, no CDK token). On a fresh deploy the upstream
// is empty; redeploy this stack once the NLB DNS is known.
const smartRouterStack = new SmartRouterStack(app, 'GenAiGwSmartRouterStack', {
  env,
  vpc: networkStack.vpc,
  upstreamEndpoint: higressEndpoint,
  certificateArn: certStack.certificateArn,
  // Reuse the per-alias vLLM NLB map for the router's cold-vLLM pre-flight (skip the
  // gateway when the target alias is scaled to zero). Empty when vllmEndpoints is omitted
  // → pre-flight disabled, reactive fallback only (the public-repo default).
  vllmEndpoints,
  // Per-alias context window (alias → maxModelLen) for the router's warm-path max_tokens
  // clamp: a large Claude-Code max_tokens is clamped to fit the target model's window so a
  // warm alias serves it on vLLM instead of 400-ing → Bedrock fallback. Derived from the
  // same VLLM_MODELS config the vLLM stacks use (always populated; clamp is a safe no-op
  // for any alias the router doesn't have a length for).
  vllmMaxModelLen: Object.fromEntries(
    Object.values(VLLM_MODELS).map((m) => [m.alias, m.maxModelLen]),
  ),
  // Cold-fallback cascade order. Default quality-first (Sonnet primary → Haiku secondary);
  // `-c coldFallbackOrder=availability` flips to Haiku primary → Sonnet secondary. See the
  // coldFallbackOrder note above. Both stay Seoul IN_REGION (data stays in-region either way).
  bedrockFallbackModel: bedrockPrimary,
  bedrockFallbackModelSecondary: bedrockSecondary,
  // TEST-ONLY synthetic-throttle surface for S-cascade (default OFF on production).
  faultInjection,
});

// Phase 9: Step Functions warm-up/cool-down SFN machines
// EventBridge schedule moved to GenAiGwReservationStack (Phase 10).
const warmupStack = new WarmupStack(app, 'GenAiGwWarmupStack', {
  env,
  cluster: eksStack.cluster,
  vllmModels: Object.values(VLLM_MODELS),
});
warmupStack.addDependency(karpenterStack);

// Phase 10: Reservation-based warm-up timer + daily schedule integration
// DynamoDB + reserve-fn + expire-fn + EventBridge daily reservation (08:30 KST, 11h)
const reservationStack = new ReservationStack(app, 'GenAiGwReservationStack', {
  env,
  vllmModels: Object.values(VLLM_MODELS),
  warmupSfnArn:  warmupStack.warmupMachine.stateMachineArn,
  cooldownSfnArn: warmupStack.cooldownMachine.stateMachineArn,
  clusterName,
});
reservationStack.addDependency(warmupStack);

// Phase 10: Admin Console (FastAPI ECS, admin.genai-gw.internal)
const adminConsoleStack = new AdminConsoleStack(app, 'GenAiGwAdminConsoleStack', {
  env,
  vpc: networkStack.vpc,
  cluster: eksStack.cluster,
  vllmModels: Object.values(VLLM_MODELS),
  reservationsTableName: 'GenAiGwWarmupReservations',
  cooldownSfnArn: warmupStack.cooldownMachine.stateMachineArn,
  clusterName,
  certificateArn: certStack.certificateArn,
  dailyWarmupRuleName: DAILY_WARMUP_RULE_NAME,
});
adminConsoleStack.addDependency(reservationStack);
adminConsoleStack.addDependency(certStack);

// Route53 Private Hosted Zone: gateway / admin .genai-gw.internal
const dnsStack = new DnsStack(app, 'GenAiGwDnsStack', {
  env,
  vpc: networkStack.vpc,
  zoneName: GATEWAY_ZONE,
  smartRouterAlb: smartRouterStack.alb,
  adminAlb: adminConsoleStack.alb,
});
dnsStack.addDependency(smartRouterStack);
dnsStack.addDependency(adminConsoleStack);

// In-VPC test client (included by default; opt out with -c deployTestClient=false).
// Deploys ONE private EC2 reachable only via SSM Session Manager, pre-wired to the
// gateway with Claude Code installed. Runs as a burstable t3.small in STANDARD credit
// mode (throttle, not surcharge) so idle cost stays negligible.
//   warm-up cold  -> SmartRouter falls back to in-region Bedrock (low-spec answer)
//   genai-gw-warmup    -> GPU spins up, the SAME `claude` command now hits vLLM (Qwen3.5)
const deployTestClient = getJsonContext<boolean>('deployTestClient', true);
if (deployTestClient) {
  const testClientStack = new TestClientStack(app, 'GenAiGwTestClientStack', {
    env,
    vpc: networkStack.vpc,
    gatewayZone: GATEWAY_ZONE,
    masterKeySecret: higressStack.masterKeySecret,
    warmupSfnArn:   warmupStack.warmupMachine.stateMachineArn,
    cooldownSfnArn: warmupStack.cooldownMachine.stateMachineArn,
    // genai-gw-warmup places a timed reservation via reserve-fn (auto-cooldown at expiry);
    // genai-gw-status/genai-gw-cooldown read/clear its rows in the reservations table.
    reserveFnArn: reservationStack.reserveFnArn,
    reservationsTableName: 'GenAiGwWarmupReservations',
    caCertSecretName: '/genai-gw/gateway/ca-cert',
    clusterName,
  });
  testClientStack.addDependency(higressStack);
  testClientStack.addDependency(warmupStack);
  testClientStack.addDependency(reservationStack);
  testClientStack.addDependency(certStack);
  testClientStack.addDependency(dnsStack);
}
