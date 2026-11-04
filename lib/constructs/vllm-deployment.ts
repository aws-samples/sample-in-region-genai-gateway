import * as cdk from 'aws-cdk-lib/core';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import { Construct, IDependable } from 'constructs';
import { DEFAULT_VLLM_IMAGE, DEFAULT_VLLM_TAG, VllmModelConfig } from '../../config/models';

export interface VllmDeploymentProps {
  cluster: eks.Cluster;
  model: VllmModelConfig;
  hfTokenSecretName: string;
  /**
   * The vllm namespace manifest created once in EksClusterStack.
   * All VllmDeployment resources depend on this to avoid AlreadyExists errors.
   */
  vllmNamespaceManifest: IDependable;
  /**
   * Expose vLLM via an Internal NLB so out-of-cluster callers can reach it: the
   * Higress AI Gateway providers point at this NLB DNS, and the SmartRouter ECS task
   * probes its /health for the cold-vLLM pre-flight. ECS tasks (and the gateway
   * provider config) cannot resolve K8s ClusterIP — a stable NLB DNS is required.
   */
  exposeNlb?: boolean;
  /**
   * S3 bucket name for model cache via Mountpoint for S3 CSI driver.
   * When set, creates a static PV/PVC mounted at /model-cache instead of emptyDir.
   * Each model uses a separate prefix: s3://<bucket>/models/<servingName>/
   */
  modelCacheBucketName?: string;
  /** ASCP SecretProviderClass for hf-token — must exist before pods mount the CSI volume. */
  hfTokenSpcDependency?: IDependable;
}

export class VllmDeployment extends Construct {
  constructor(scope: Construct, id: string, props: VllmDeploymentProps) {
    super(scope, id);

    const { model } = props;
    const namespace = 'vllm';
    const gpuCount = model.gpuCount ?? 1;
    const tensorParallelSize = model.tensorParallelSize ?? gpuCount;
    const imageTag = model.vllmImageTag ?? DEFAULT_VLLM_TAG;

    // Namespace is created once in EksClusterStack.vllmNamespaceManifest.
    // Do NOT create it here — multiple VllmDeployment instances on the same cluster
    // would each try to create the same namespace, causing AlreadyExists errors.

    // hf-token Secret is synced from AWS Secrets Manager by the HfTokenSyncStack Custom Resource.
    // Pods depend on props.hfTokenSecretDependency so Deployment rolls out after the K8s Secret exists.

    // EFS CSI is disabled for all models: Bottlerocket (EKS Auto Mode) nodes run
    // amazon-efs-mount-watchdog which cannot detect the init system ("unrecognized init
    // system aws-efs-csi-dri"), causing all EFS CSI mounts to fail regardless of TLS setting.
    // Status: known issue with EFS CSI v3.0.1 + Bottlerocket. Tracked for Phase 8.
    // Current workaround: emptyDir — model weights re-downloaded from HuggingFace on cold start.
    // Phase 8 resolution: upgrade EFS CSI addon or switch to Mountpoint for Amazon S3.
    //
    // PVC is still created (required by Deployment spec), but the Deployment volume
    // is overridden to emptyDir below until EFS is fixed.

    // When S3 model cache is enabled, download weights directly to /model-cache (= S3 prefix root).
    // Each model PVC uses a separate S3 prefix (models/<servingName>/) for isolation.
    // vLLM reads from /model-cache (the S3 prefix root).
    // Init container downloads to /model-cache so files land at s3://bucket/models/<servingName>/<files>.
    const modelArg = props.modelCacheBucketName
      ? `/model-cache`
      : model.modelId;

    const args = [
      '--model', modelArg,
      '--served-model-name', model.servingName,
      '--max-model-len', String(model.maxModelLen),
      '--trust-remote-code',
      '--tensor-parallel-size', String(tensorParallelSize),
    ];

    // --limit-mm-per-prompt: vLLM v0.9+ accepts JSON dict format '{"image":5,"video":1}'
    // Omit for now — default limits apply (1 image/video/audio per prompt).
    // Re-enable if multi-item per prompt needed and vLLM version is confirmed compatible.

    args.push('--enable-prefix-caching');

    if (model.extraArgs) {
      args.push(...model.extraArgs);
    }

    const envVars: object[] = [
      {
        name: 'HUGGING_FACE_HUB_TOKEN',
        valueFrom: {
          secretKeyRef: {
            name: props.hfTokenSecretName,
            key: 'token',
          },
        },
      },
      // When S3 cache is used, vLLM reads from /model-cache/<servingName> (local-dir layout).
      // HF Hub blob/symlink cache is at /tmp/hf-hub-cache (emptyDir) — used only by init container.
      { name: 'HF_HUB_CACHE', value: props.modelCacheBucketName ? '/tmp/hf-hub-cache' : '/model-cache' },
    ];

    // HPA for scale-out (cpu utilization).
    // Note: Kubernetes built-in HPA cannot scale to 0 — minReplicas floor is 1.
    // True scale-to-zero requires KEDA (Phase 8). Until then, minReplicas=0 in
    // VllmModelConfig means "start Deployment with 0 replicas" but HPA minReplicas=1
    // so the HPA will scale back up once the Deployment receives traffic.
    const hpaMinReplicas = Math.max(model.minReplicas ?? 1, 1);
    const hpaManifest = props.cluster.addManifest(`${id}Hpa`, {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: { name: model.servingName, namespace },
      spec: {
        scaleTargetRef: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          name: model.servingName,
        },
        minReplicas: hpaMinReplicas,
        maxReplicas: model.maxReplicas ?? 1,
        metrics: [
          {
            type: 'Resource',
            resource: {
              name: 'cpu',
              target: { type: 'Utilization', averageUtilization: 70 },
            },
          },
        ],
      },
    });

    // S3 Mountpoint PV/PVC are CDK-managed in EksClusterStack (one per model).
    // PVC name follows <servingName>-model-cache; only referenced here.
    const pvName = `${model.servingName}-model-cache`;

    const deployManifest = props.cluster.addManifest(`${id}Deployment`, {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: model.servingName, namespace },
      spec: {
        // I6 fix: omit spec.replicas from CDK manifest so cdk deploy never overwrites
        // the live replica count managed by scale-vllm Lambda / HPA.
        // Initial replica count is set imperatively by the first WarmupMachine run
        // (minReplicas=0 → Kubernetes defaults to 1 on first create, but WarmupMachine
        //  immediately scales to the correct value before pods schedule).
        // For always-on models (minReplicas=1), the first apply sets replicas=1 correctly
        // because Kubernetes defaults to 1 when spec.replicas is absent on CREATE.
        selector: { matchLabels: { app: model.servingName } },
        template: {
          metadata: { labels: { app: model.servingName } },
          spec: {
            // S3 auth is handled by the Mountpoint CSI driver pod (kube-system/s3-csi-driver-sa),
            // which has its own Pod Identity role granting modelCacheBucket read/write.
            // vLLM pods themselves only need default namespace permissions.
            serviceAccountName: 'default',
            // 'vllm-gpu' taint matches NodePool GPU taint — avoids Karpenter
            // label conflict with nvidia.com/gpu resource requests.
            tolerations: [
              { key: 'vllm-gpu', operator: 'Exists', effect: 'NoSchedule' },
              { key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' },
            ],
            // Pin to exact instance type so Karpenter provisions the right GPU
            affinity: {
              nodeAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: {
                  nodeSelectorTerms: [
                    {
                      matchExpressions: [
                        {
                          key: 'node.kubernetes.io/instance-type',
                          operator: 'In',
                          values: [model.instanceType],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            // Init container: download model weights to /model-cache (= S3 prefix root for this PVC).
            // Each PVC has prefix models/<servingName>/ so files land at s3://bucket/models/<name>/<files>.
            // Delete .cache dir first to avoid stale .incomplete files from previous pods.
            // S3 Mountpoint cannot re-open existing remote inodes for append — fresh start is required.
            //
            // IDEMPOTENT GUARD (fool-proof): if weights are already present in the cache
            // (config.json + at least one *.safetensors/*.bin shard), skip the download
            // entirely. This (a) makes re-deploys / warm restarts near-instant, and
            // (b) sidesteps a hard failure mode of newer huggingface_hub on Mountpoint-for-S3:
            // it stages files as `.incomplete` then RENAMEs to the final name, but S3 FUSE
            // returns ENOSYS (Errno 38) for rename — the init container then crash-loops and
            // never starts, while the GPU node it pulled stays up and bills indefinitely.
            // The pinned image tag (config/models.ts, NOT `latest`) keeps fresh downloads on a
            // huggingface_hub version known to work with Mountpoint-for-S3.
            ...(props.modelCacheBucketName ? {
              initContainers: [
                {
                  name: 'download-model',
                  image: `${DEFAULT_VLLM_IMAGE}:${imageTag}`,
                  command: ['sh', '-c'],
                  args: [
                    // HF_HUB_DISABLE_XET=1: disable Xet protocol (uses random write access,
                    //   incompatible with S3 FUSE which only supports sequential writes).
                    // max_workers=1: serialize downloads to avoid concurrent .incomplete file conflicts.
                    // rm -rf .cache: clean temp files before/after download.
                    [
                      `if [ -f /model-cache/config.json ]`,
                      `&& { ls /model-cache/*.safetensors >/dev/null 2>&1`,
                      `|| ls /model-cache/*.bin >/dev/null 2>&1; }; then`,
                      `echo "Model weights already present in /model-cache — skipping download.";`,
                      `else`,
                      `rm -rf /model-cache/.cache;`,
                      `HF_HUB_DISABLE_XET=1 python3 -c`,
                      `"from huggingface_hub import snapshot_download;`,
                      `snapshot_download(repo_id='${model.modelId}',`,
                      `local_dir='/model-cache',`,
                      `local_dir_use_symlinks=False,`,
                      `max_workers=1)";`,
                      `rm -rf /model-cache/.cache;`,
                      `fi`,
                    ].join(' '),
                  ],
                  env: [
                    {
                      name: 'HUGGING_FACE_HUB_TOKEN',
                      valueFrom: {
                        secretKeyRef: {
                          name: props.hfTokenSecretName,
                          key: 'token',
                        },
                      },
                    },
                    { name: 'HF_HUB_CACHE', value: '/tmp/hf-hub-cache' },
                    { name: 'HF_HUB_ENABLE_HF_TRANSFER', value: '1' },
                    { name: 'HF_HUB_DISABLE_XET', value: '1' },
                  ],
                  volumeMounts: [
                    { name: 'model-cache', mountPath: '/model-cache' },
                    { name: 'hf-hub-tmp', mountPath: '/tmp/hf-hub-cache' },
                    { name: 'hf-token-store', mountPath: '/mnt/hf-token', readOnly: true },
                  ],
                },
              ],
            } : {}),
            containers: [
              {
                name: 'vllm',
                image: `${DEFAULT_VLLM_IMAGE}:${imageTag}`,
                // initCommands: run pip installs before vLLM (e.g., Phi-4 requires scipy)
                // Uses sh -c wrapper: "pip install X && python -m vllm.entrypoints..."
                ...(model.initCommands ? {
                  command: ['sh', '-c'],
                  args: [
                    model.initCommands.join(' && ')
                    + ' && python3 -m vllm.entrypoints.openai.api_server '
                    + args.join(' '),
                  ],
                } : { args }),
                ports: [{ containerPort: 8000, name: 'http' }],
                resources: {
                  limits: { 'nvidia.com/gpu': String(gpuCount) },
                  requests: { 'nvidia.com/gpu': String(gpuCount) },
                },
                env: envVars,
                volumeMounts: [
                  { name: 'model-cache', mountPath: '/model-cache' },
                  ...(props.modelCacheBucketName ? [{ name: 'hf-hub-tmp', mountPath: '/tmp/hf-hub-cache' }] : []),
                  // Mount ASCP SecretProviderClass — required to trigger secretObjects sync
                  // into the `hf-token` K8s Secret referenced by envVars.HUGGING_FACE_HUB_TOKEN.
                  // readOnly mandatory for Secrets Store CSI driver.
                  { name: 'hf-token-store', mountPath: '/mnt/hf-token', readOnly: true },
                ],
                readinessProbe: {
                  httpGet: { path: '/health', port: 8000 },
                  initialDelaySeconds: 120,
                  periodSeconds: 30,
                  failureThreshold: 20,
                },
                livenessProbe: {
                  httpGet: { path: '/health', port: 8000 },
                  initialDelaySeconds: model.livenessInitialDelaySecs ?? 180,
                  periodSeconds: 60,
                  failureThreshold: model.livenessFailureThreshold ?? 5,
                },
              },
            ],
            volumes: [
              props.modelCacheBucketName
                ? {
                    // S3 Mountpoint CSI — model weights persisted across pod restarts.
                    // Init container downloads via --local-dir (flat files, no HF blob/rename).
                    // Subsequent cold starts read directly from S3 (~2min vs ~15min from HF).
                    name: 'model-cache',
                    persistentVolumeClaim: { claimName: pvName },
                  }
                : {
                    // Fallback: emptyDir — weights re-downloaded from HuggingFace on every cold start.
                    // EFS CSI fails on Bottlerocket (EKS Auto Mode) — watchdog init system issue.
                    name: 'model-cache',
                    emptyDir: {},
                  },
              // HF Hub temp cache for init container (blob/symlink layout, not written to S3).
              ...(props.modelCacheBucketName ? [{
                name: 'hf-hub-tmp',
                emptyDir: {},
              }] : []),
              // Secrets Store CSI volume — mounts ASCP-provided secrets from Secrets Manager.
              // secretProviderClass 'hf-token' triggers ASCP to also create the K8s Secret
              // `vllm/hf-token` (key=token) while this pod is running.
              {
                name: 'hf-token-store',
                csi: {
                  driver: 'secrets-store.csi.k8s.io',
                  readOnly: true,
                  volumeAttributes: { secretProviderClass: 'hf-token' },
                },
              },
            ],
          },
        },
      },
    });
    deployManifest.node.addDependency(props.vllmNamespaceManifest);
    if (props.hfTokenSpcDependency) {
      deployManifest.node.addDependency(props.hfTokenSpcDependency);
    }
    hpaManifest.node.addDependency(deployManifest);

    // ClusterIP service for intra-cluster access
    const svcManifest = props.cluster.addManifest(`${id}Service`, {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: model.servingName, namespace },
      spec: {
        selector: { app: model.servingName },
        ports: [{ port: 8000, targetPort: 8000, name: 'http' }],
      },
    });
    svcManifest.node.addDependency(props.vllmNamespaceManifest);

    // Internal NLB: stable DNS for out-of-cluster callers — Higress providers + SmartRouter pre-flight
    if (props.exposeNlb ?? true) {
      const nlbSvcManifest = props.cluster.addManifest(`${id}NlbService`, {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: `${model.servingName}-nlb`,
          namespace,
          annotations: {
            'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
            'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internal',
            'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'ip',
          },
        },
        spec: {
          type: 'LoadBalancer',
          selector: { app: model.servingName },
          ports: [{ port: 8000, targetPort: 8000, name: 'http', protocol: 'TCP' }],
        },
      });
      nlbSvcManifest.node.addDependency(props.vllmNamespaceManifest);
    }
  }
}

// Output tag for CDK to emit NLB DNS lookup instructions
export function nlbLookupOutput(stack: cdk.Stack, model: VllmModelConfig): void {
  new cdk.CfnOutput(stack, `NlbLookup${model.alias}`, {
    value: `kubectl get svc -n vllm ${model.servingName}-nlb -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'`,
    description: `Get Internal NLB DNS for ${model.alias} (${model.modelId})`,
  });
}
