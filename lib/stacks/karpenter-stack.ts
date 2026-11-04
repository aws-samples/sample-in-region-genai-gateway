import * as cdk from 'aws-cdk-lib/core';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import { Construct } from 'constructs';

export interface KarpenterStackProps extends cdk.StackProps {
  cluster: eks.Cluster;
}

export class KarpenterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KarpenterStackProps) {
    super(scope, id, props);

    // EKS Auto Mode uses default NodeClass (auto-created by EKS)
    const nodeClassRef = {
      group: 'eks.amazonaws.com',
      kind: 'NodeClass',
      name: 'default',
    };

    // CPU NodePool (default — system workloads)
    props.cluster.addManifest('NodePoolDefault', {
      apiVersion: 'karpenter.sh/v1',
      kind: 'NodePool',
      metadata: { name: 'default' },
      spec: {
        template: {
          spec: {
            nodeClassRef,
            requirements: [
              { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['spot', 'on-demand'] },
              { key: 'kubernetes.io/arch', operator: 'In', values: ['amd64', 'arm64'] },
              { key: 'eks.amazonaws.com/instance-category', operator: 'In', values: ['c', 'm', 'r'] },
            ],
          },
        },
        disruption: {
          consolidationPolicy: 'WhenEmptyOrUnderutilized',
          consolidateAfter: '1m',
        },
        limits: { cpu: '1000' },
      },
    });

    // GPU NodePool (g6e/g6/g5/p5 families)
    // Taint: 'vllm-gpu' (NOT 'nvidia.com/gpu') — EKS Auto Mode Karpenter converts
    // 'nvidia.com/gpu' resource requests into label requirements, which conflicts with
    // a 'nvidia.com/gpu=true' taint/label when GPU count > 1 (e.g., p5: 8 GPUs).
    // Using 'vllm-gpu' as a neutral taint avoids this label requirement collision.
    props.cluster.addManifest('NodePoolGpu', {
      apiVersion: 'karpenter.sh/v1',
      kind: 'NodePool',
      metadata: { name: 'gpu' },
      spec: {
        template: {
          spec: {
            nodeClassRef,
            taints: [{ key: 'vllm-gpu', value: 'true', effect: 'NoSchedule' }],
            requirements: [
              { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['spot', 'on-demand'] },
              {
                key: 'eks.amazonaws.com/instance-family',
                operator: 'In',
                // g5g excluded: arm64 (Graviton2) — vLLM has no arm64 image
                values: ['g6e', 'g6', 'g5', 'p5en', 'p5e', 'p5', 'p4de', 'p4d'],
              },
              // Explicitly require amd64 to avoid arm64 GPU instances (g5g)
              { key: 'kubernetes.io/arch', operator: 'In', values: ['amd64'] },
            ],
          },
        },
        disruption: {
          consolidationPolicy: 'WhenEmpty',
          consolidateAfter: '5m',
        },
        limits: { 'nvidia.com/gpu': '64' },
      },
    });

    // Neuron NodePool (inf2/trn1/trn2 — optional)
    props.cluster.addManifest('NodePoolNeuron', {
      apiVersion: 'karpenter.sh/v1',
      kind: 'NodePool',
      metadata: { name: 'neuron' },
      spec: {
        template: {
          metadata: {
            labels: { 'aws.amazon.com/neuron': 'true' },
          },
          spec: {
            nodeClassRef,
            taints: [{ key: 'aws.amazon.com/neuron', value: 'true', effect: 'NoSchedule' }],
            requirements: [
              { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['spot', 'on-demand'] },
              {
                key: 'eks.amazonaws.com/instance-family',
                operator: 'In',
                values: ['inf2', 'trn1', 'trn2'],
              },
            ],
          },
        },
        disruption: {
          consolidationPolicy: 'WhenEmpty',
          consolidateAfter: '5m',
        },
      },
    });
  }
}
