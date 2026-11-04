import * as cdk from 'aws-cdk-lib/core';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import { Construct, IDependable } from 'constructs';
import { VllmDeployment, nlbLookupOutput } from '../constructs/vllm-deployment';
import { VllmModelConfig } from '../../config/models';

export interface VllmStackProps extends cdk.StackProps {
  cluster: eks.Cluster;
  efsFs: efs.FileSystem;
  model: VllmModelConfig;
  hfTokenSecretName?: string;
  /** Single vllm namespace manifest from EksClusterStack — passed to VllmDeployment */
  vllmNamespaceManifest: IDependable;
  /** S3 bucket name for model cache (Mountpoint for S3 CSI). If unset, falls back to emptyDir. */
  modelCacheBucketName?: string;
  /** ASCP SecretProviderClass for hf-token — pods mount the Secrets Store CSI volume. */
  hfTokenSpcDependency?: IDependable;
}

/**
 * GenAiGwVllmStack — one stack per model (Option A: config-parameterized).
 *
 * Deploy: cdk deploy GenAiGwVllm-Coding GenAiGwVllm-Ocr ...
 * Each stack provisions: vLLM Deployment + HPA + Internal NLB + EFS PVC
 */
export class VllmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VllmStackProps) {
    super(scope, id, props);

    const hfTokenSecretName = props.hfTokenSecretName ?? 'hf-token';

    // Use alias in construct ID so manifests are unique on the shared cluster node
    new VllmDeployment(this, `VllmDeployment-${props.model.alias}`, {
      cluster: props.cluster,
      model: props.model,
      hfTokenSecretName,
      vllmNamespaceManifest: props.vllmNamespaceManifest,
      exposeNlb: true,
      modelCacheBucketName: props.modelCacheBucketName,
      hfTokenSpcDependency: props.hfTokenSpcDependency,
    });

    nlbLookupOutput(this, props.model);

    new cdk.CfnOutput(this, 'ModelAlias', {
      value: props.model.alias,
      description: 'Scenario alias for this model (client model field)',
    });
    new cdk.CfnOutput(this, 'ServingName', {
      value: props.model.servingName,
      description: 'K8s serving name (kubectl get pods -n vllm -l app=<ServingName>)',
    });
  }
}
