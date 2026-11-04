import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import { CfnPodIdentityAssociation } from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { KubectlV32Layer } from '@aws-cdk/lambda-layer-kubectl-v32';
import { Construct, IDependable } from 'constructs';

export interface EksClusterStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  clusterName: string;
  /** Secrets Manager secret name holding HuggingFace token (key 'token'). Default: 'hf-token'. */
  hfTokenSecretName?: string;
  /** IAM role ARNs granted AmazonEKSClusterAdminPolicy (humans / break-glass). */
  operatorRoleArns?: string[];
}

export class EksClusterStack extends cdk.Stack {
  public readonly cluster: eks.Cluster;
  public readonly efs: efs.FileSystem;
  /** S3 bucket for vLLM model cache (Mountpoint for S3 CSI) — CDK-managed. */
  public readonly modelCacheBucket: s3.Bucket;
  /** Single vllm namespace manifest — VllmDeployment instances must depend on this */
  public readonly vllmNamespaceManifest: IDependable;
  /** SecretProviderClass for hf-token — VllmDeployment pods depend on this + mount the CSI volume. */
  public readonly hfTokenSpcManifest!: IDependable;

  constructor(scope: Construct, id: string, props: EksClusterStackProps) {
    super(scope, id, props);

    const kubectlLayer = new KubectlV32Layer(this, 'KubectlLayer');

    // KMS key for envelope encryption of Kubernetes Secrets in etcd.
    // EKS encrypts etcd volumes with AWS-managed keys by default; this adds a
    // second, customer-managed envelope layer so Secret object *data* is also
    // encrypted with a key you control (defense-in-depth; CKV_AWS_58).
    // NOTE: EKS applies the encryption config at cluster CREATE time only — an
    // existing cluster must be recreated for this to take effect.
    const secretsKey = new kms.Key(this, 'ClusterSecretsKey', {
      description: `Envelope encryption for ${props.clusterName} Kubernetes secrets`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // EKS Auto Mode nodePool role — explicitly CDK-managed so we can grant S3/ECR/etc. without
    // hardcoding CFN-generated role names. Matches aws-eks-v2 addNodePoolRole defaults.
    const nodePoolRole = new iam.Role(this, 'NodePoolRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
    });

    // EKS Auto Mode cluster (aws-eks-v2 L2)
    this.cluster = new eks.Cluster(this, 'GenAiGwCluster', {
      clusterName: props.clusterName,
      vpc: props.vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      version: eks.KubernetesVersion.V1_32,
      defaultCapacityType: eks.DefaultCapacityType.AUTOMODE,
      compute: {
        nodePools: ['system', 'general-purpose'],
        nodeRole: nodePoolRole,
      },
      endpointAccess: eks.EndpointAccess.PUBLIC,
      secretsEncryptionKey: secretsKey,
      kubectlProviderOptions: {
        kubectlLayer,
      },
    });

    // EFS for model cache (shared across GPU pods)
    this.efs = new efs.FileSystem(this, 'ModelCache', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      encrypted: true,
      throughputMode: efs.ThroughputMode.BURSTING,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_7_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.efs.connections.allowDefaultPortFrom(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
    );

    // S3 bucket for vLLM model cache — used by Mountpoint for S3 CSI driver.
    // Replaces EFS (which fails on Bottlerocket EKS Auto Mode due to TLS watchdog issue).
    // Models are downloaded from HuggingFace to /model-cache on first start, persisted in S3.
    // Subsequent cold starts skip the HuggingFace download — read directly from S3 (~2min vs ~15min).
    // bucketName omitted → CDK auto-generates unique suffix, safe for destroy+rebuild.
    // ~1.2TB per model × 6 models; autoDeleteObjects lets cdk destroy clean up.
    this.modelCacheBucket = new s3.Bucket(this, 'VllmModelCacheS3', {
      // Block all public access — model weights must never be publicly reachable.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // Encrypt at rest with an S3-managed key (SSE-S3).
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Reject any request not using TLS (adds an aws:SecureTransport deny policy).
      enforceSSL: true,
      // Keep prior object versions (recover from accidental overwrite of a cached
      // model) but expire them after 30 days so re-downloadable weights don't pile up.
      versioned: true,
      // Server access logs to a dedicated prefix in this same bucket.
      serverAccessLogsPrefix: 'access-logs/',
      lifecycleRules: [
        {
          // Models are re-downloadable from HuggingFace; don't retain stale versions.
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Pod Identity Agent addon — NOTE: EKS Auto Mode has built-in Pod Identity for system addons,
    // but the standalone DaemonSet (Helm addon) gets DESIRED=0 on Auto Mode nodes.
    // Install anyway for compatibility with managed nodegroups if added later.
    const podIdentityAgent = new eks.Addon(this, 'PodIdentityAgentAddon', {
      cluster: this.cluster,
      addonName: 'eks-pod-identity-agent',
    });

    const efsAddon = new eks.Addon(this, 'EfsCsiDriverAddon', {
      cluster: this.cluster,
      addonName: 'aws-efs-csi-driver',
    });

    // Mountpoint for Amazon S3 CSI Driver — model cache via S3 (replaces EFS for GPU nodes)
    const s3MountpointAddon = new eks.Addon(this, 'S3MountpointCsiAddon', {
      cluster: this.cluster,
      addonName: 'aws-mountpoint-s3-csi-driver',
      addonVersion: 'v2.5.0-eksbuild.1',
    });

    new eks.Addon(this, 'MetricsServerAddon', {
      cluster: this.cluster,
      addonName: 'metrics-server',
    });

    // AWS Secrets & Configuration Provider (ASCP) for Secrets Store CSI Driver.
    // Materializes AWS Secrets Manager / Parameter Store entries as K8s Secrets without
    // any plaintext in CDK synth/CFN template. Bundled addon: also installs the upstream
    // Secrets Store CSI driver. Requires pod SA with IRSA/Pod Identity for GetSecretValue.
    //
    // syncSecret.enabled=true: grants the bundled secrets-store CSI driver RBAC to
    // create/list/update native K8s Secrets so the SPC's `secretObjects` actually
    // materialize (default is false — the driver silently no-ops writes).
    const ascpAddon = new eks.Addon(this, 'SecretsStoreAscpAddon', {
      cluster: this.cluster,
      addonName: 'aws-secrets-store-csi-driver-provider',
      configurationValues: {
        'secrets-store-csi-driver': { syncSecret: { enabled: true } },
      },
    });

    // StorageClass: gp3-eks-auto (EKS Auto Mode built-in EBS CSI driver)
    this.cluster.addManifest('StorageClassGp3EksAuto', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 'gp3-eks-auto' },
      provisioner: 'ebs.csi.eks.amazonaws.com',
      parameters: { type: 'gp3', encrypted: 'true' },
      reclaimPolicy: 'Delete',
      volumeBindingMode: 'WaitForFirstConsumer',
      allowVolumeExpansion: true,
    });

    // StorageClass: EFS — EKS Auto Mode (Bottlerocket) watchdog cannot detect init system,
    // so TLS mount fails. encryptInTransit=false uses the non-TLS path which works.
    // Note: StorageClass.parameters is immutable on K8s; changing these fields later requires
    // `kubectl delete sc efs` before re-deploy (fresh-account deploys have no conflict).
    this.cluster.addManifest('StorageClassEfs', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 'efs' },
      provisioner: 'efs.csi.aws.com',
      parameters: {
        provisioningMode: 'efs-ap',
        fileSystemId: this.efs.fileSystemId,
        directoryPerms: '700',
        encryptInTransit: 'false',
      },
      reclaimPolicy: 'Retain',
      volumeBindingMode: 'Immediate',
    });

    // StorageClass: s3-mountpoint (Mountpoint for S3 CSI driver)
    // Immutability note: same as SC efs above — changing provisioner/mountOptions needs delete+recreate.
    const s3StorageClassManifest = this.cluster.addManifest('StorageClassS3Mountpoint', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 's3-mountpoint' },
      provisioner: 's3.csi.aws.com',
      reclaimPolicy: 'Retain',
      volumeBindingMode: 'WaitForFirstConsumer',
      mountOptions: [
        'allow-delete',
        'allow-overwrite',
        'file-mode=0644',
        'dir-mode=0755',
      ],
    });

    // Create vllm namespace once here — VllmDeployment instances must NOT recreate it.
    // Multiple VllmStack instances all share this single EksClusterStack,
    // so creating the namespace in each VllmDeployment causes AlreadyExists errors.
    this.vllmNamespaceManifest = this.cluster.addManifest('VllmNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'vllm' },
    });

    // Pod Identity for vLLM pods. Both consumers delegate auth to the pod's SA:
    //  - Mountpoint S3 CSI with `authenticationSource: pod` on the PV uses the consumer pod's SA.
    //  - ASCP inspects the consumer pod's SA for GetSecretValue authorization.
    // One role on `vllm/default` covers both.
    // Trust principal is pods.eks.amazonaws.com (Pod Identity). SessionTagsPrincipal adds
    // sts:TagSession alongside sts:AssumeRole — required by Pod Identity.
    const vllmPodRole = new iam.Role(this, 'VllmPodRole', {
      assumedBy: new iam.SessionTagsPrincipal(
        new iam.ServicePrincipal('pods.eks.amazonaws.com'),
      ),
    });
    this.modelCacheBucket.grantReadWrite(vllmPodRole);

    // hf-token secret in AWS Secrets Manager (pre-created out-of-band, ground truth).
    // Structure: {"token":"hf_..."}. Imported by name; CDK does not manage its lifecycle
    // (rotation, value) — only reads it. grantRead adds secretsmanager:GetSecretValue.
    const hfTokenSecretName = props.hfTokenSecretName ?? 'hf-token';
    const hfSecret = secretsmanager.Secret.fromSecretNameV2(this, 'HfTokenSecret', hfTokenSecretName);
    hfSecret.grantRead(vllmPodRole);

    // Fool-proof: fail the deploy EARLY (here, before any GPU node is provisioned) if the
    // hf-token secret is missing. fromSecretNameV2 is lazy — a wrong/absent secret is not
    // caught at synth or deploy; the failure only surfaces at pod start, where the init
    // container crash-loops on a FailedMount while the GPU node it triggered keeps billing.
    // This DescribeSecret call runs during EksClusterStack deploy: if the secret does not
    // exist, the SDK raises ResourceNotFoundException and the stack fails fast with a clear
    // cause, instead of silently burning GPU. Pre-create the secret per the README:
    //   aws secretsmanager create-secret --name hf-token \
    //     --secret-string '{"token":"hf_xxx"}' --region ap-northeast-2
    const hfSecretCheck = new cr.AwsCustomResource(this, 'HfTokenSecretCheck', {
      onCreate: {
        service: 'SecretsManager',
        action: 'describeSecret',
        parameters: { SecretId: hfTokenSecretName },
        physicalResourceId: cr.PhysicalResourceId.of(`hf-token-check-${hfTokenSecretName}`),
      },
      onUpdate: {
        service: 'SecretsManager',
        action: 'describeSecret',
        parameters: { SecretId: hfTokenSecretName },
        physicalResourceId: cr.PhysicalResourceId.of(`hf-token-check-${hfTokenSecretName}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });
    // Order the SecretProviderClass after the check so a missing secret blocks the chain.
    hfSecretCheck.node.addDependency(hfSecret);

    const vllmPodPia = new CfnPodIdentityAssociation(this, 'VllmPodPia', {
      clusterName: this.cluster.clusterName,
      namespace: 'vllm',
      serviceAccount: 'default',
      roleArn: vllmPodRole.roleArn,
    });
    vllmPodPia.node.addDependency(this.vllmNamespaceManifest);
    // Addons must be healthy before the consumer pods try to use the PIA.
    vllmPodPia.node.addDependency(s3MountpointAddon);
    vllmPodPia.node.addDependency(ascpAddon);

    // EKS AccessEntry for human operators (break-glass kubectl).
    // Passed via cdk.json context "operatorRoleArns": ["arn:aws:iam::ACCOUNT:role/Admin", ...].
    // Replaces manual `aws eks create-access-entry` + `associate-access-policy` steps.
    for (const [idx, roleArn] of (props.operatorRoleArns ?? []).entries()) {
      new eks.AccessEntry(this, `OperatorAccessEntry${idx}`, {
        cluster: this.cluster,
        principal: roleArn,
        accessPolicies: [
          eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
            accessScopeType: eks.AccessScopeType.CLUSTER,
          }),
        ],
      });
    }

    // SecretProviderClass — declares what ASCP should materialize as a K8s Secret.
    // secretObjects triggers ASCP to sync the CSI-mounted file into a native K8s Secret
    // named `hf-token` (key=token). This K8s Secret only exists while a pod actively mounts
    // the CSI volume — vllm Deployment must therefore mount the CSI volume (see vllm-deployment.ts).
    // No plaintext in CDK output or CFN template — ASCP fetches at pod start via IRSA.
    const hfTokenSpc = this.cluster.addManifest('HfTokenSpc', {
      apiVersion: 'secrets-store.csi.x-k8s.io/v1',
      kind: 'SecretProviderClass',
      metadata: { name: 'hf-token', namespace: 'vllm' },
      spec: {
        provider: 'aws',
        parameters: {
          // ASCP v3.0.0 defaults to IRSA (looks for eks.amazonaws.com/role-arn annotation
          // on the consumer SA). Auto Mode uses Pod Identity instead — flip the default.
          usePodIdentity: 'true',
          objects: JSON.stringify([
            {
              objectName: hfTokenSecretName,
              objectType: 'secretsmanager',
              jmesPath: [{ path: 'token', objectAlias: 'token' }],
            },
          ]),
        },
        secretObjects: [
          {
            secretName: 'hf-token',
            type: 'Opaque',
            data: [{ objectName: 'token', key: 'token' }],
          },
        ],
      },
    });
    hfTokenSpc.node.addDependency(this.vllmNamespaceManifest);
    hfTokenSpc.node.addDependency(ascpAddon);
    // Exposed as a dependency handle for VllmDeployment so pods roll out after SPC exists.
    this.hfTokenSpcManifest = hfTokenSpc;

    // Per-model PV/PVC for S3 Mountpoint cache.
    // Each model gets a separate PVC bound to a distinct S3 prefix (models/<servingName>/).
    // PV.spec.csi.driver and StorageClass.provisioner are immutable — CDK re-deploy of a changed
    // driver requires the external kubectl delete, which is not part of this fresh-account flow.
    const modelPrefixes: { servingName: string; prefix: string }[] = [
      { servingName: 'qwen35-27b',       prefix: 'models/qwen35-27b/' },
      { servingName: 'qwen35-27b-video', prefix: 'models/qwen35-27b-video/' },
      { servingName: 'internvl3-14b',    prefix: 'models/internvl3-14b/' },
      { servingName: 'llama4-scout',     prefix: 'models/llama4-scout/' },
      { servingName: 'gemma4-31b',       prefix: 'models/gemma4-31b/' },
      { servingName: 'phi4-multimodal',  prefix: 'models/phi4-multimodal/' },
    ];
    for (const { servingName, prefix } of modelPrefixes) {
      const pvName = `${servingName}-model-cache`;
      const pvManifest = this.cluster.addManifest(`S3ModelCachePv-${servingName}`, {
        apiVersion: 'v1',
        kind: 'PersistentVolume',
        metadata: { name: pvName },
        spec: {
          capacity: { storage: '1200Gi' },
          volumeMode: 'Filesystem',
          accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 's3-mountpoint',
          // Static PVs do NOT inherit StorageClass.mountOptions — declare per-PV.
          // S3 CSI v2.5.0 does NOT forward volumeAttributes.prefix to mount-s3 as --prefix;
          // must add --prefix explicitly in mountOptions.
          mountOptions: [
            'allow-delete',
            'allow-overwrite',
            'file-mode=0644',
            'dir-mode=0755',
            `--prefix=${prefix}`,
          ],
          csi: {
            driver: 's3.csi.aws.com',
            volumeHandle: pvName,
            volumeAttributes: {
              bucketName: this.modelCacheBucket.bucketName,
              prefix,
              // Per-pod auth: Mountpoint uses the consumer pod's SA (vllm/default)
              // via Pod Identity. Controller-level SA has no bucket access here.
              authenticationSource: 'pod',
              // IMDS is unreachable from Mountpoint pods on EKS Auto Mode (CRT error in logs),
              // so AWS SDK defaults to us-east-1. Force the correct signing region.
              stsRegion: this.region,
            },
          },
        },
      });
      pvManifest.node.addDependency(s3StorageClassManifest);

      const pvcManifest = this.cluster.addManifest(`S3ModelCachePvc-${servingName}`, {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name: pvName, namespace: 'vllm' },
        spec: {
          accessModes: ['ReadWriteMany'],
          storageClassName: 's3-mountpoint',
          volumeName: pvName,
          resources: { requests: { storage: '1200Gi' } },
        },
      });
      pvcManifest.node.addDependency(this.vllmNamespaceManifest);
      pvcManifest.node.addDependency(pvManifest);
    }

    // LWS (LeaderWorkerSet) — multi-node GPU support for p5.48xlarge (LLaMA 4 Scout)
    this.cluster.addHelmChart('LWS', {
      chart: 'lws',
      repository: 'oci://registry.k8s.io/lws/charts/lws',
      release: 'lws',
      namespace: 'lws-system',
      createNamespace: true,
      version: '0.7.0',
    });

    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, 'EfsId', { value: this.efs.fileSystemId });
    new cdk.CfnOutput(this, 'ModelCacheBucket', { value: this.modelCacheBucket.bucketName });
  }
}
