#!/usr/bin/env bash
# Phase 1: GenAiGwVllm-Coding 스택 배포 워크플로우
# 사용법: ./scripts/deploy-phase1.sh [--skip-infra]
#
#  --skip-infra  Network/EKS/Karpenter 이미 배포된 경우 GenAiGwVllm-Coding 만 배포

set -euo pipefail

SKIP_INFRA=false
for arg in "$@"; do
  [[ "$arg" == "--skip-infra" ]] && SKIP_INFRA=true
done

REGION=${AWS_DEFAULT_REGION:-ap-northeast-2}
CLUSTER_NAME=${CLUSTER_NAME:-genai-gw}
HF_TOKEN_SECRET=${HF_TOKEN_SECRET:-hf-token}

# ─── 0. 사전 확인 ─────────────────────────────────────────────────────────────
echo "▶ 사전 확인 (region=$REGION, cluster=$CLUSTER_NAME)"
aws sts get-caller-identity --query Account --output text > /dev/null
command -v kubectl  > /dev/null || { echo "✗ kubectl not found"; exit 1; }
command -v helm     > /dev/null || { echo "✗ helm not found"; exit 1; }

# ─── 1. HuggingFace 토큰 확인 ─────────────────────────────────────────────────
echo "▶ HuggingFace 토큰 Secret 확인 ($HF_TOKEN_SECRET)"
if ! aws secretsmanager describe-secret --secret-id "$HF_TOKEN_SECRET" --region "$REGION" &>/dev/null; then
  echo ""
  echo "  HuggingFace 토큰 Secret이 없습니다. Qwen3.5-27B 접근에 필요합니다."
  echo "  아래 명령으로 생성하세요:"
  echo ""
  echo "  aws secretsmanager create-secret \\"
  echo "    --name hf-token \\"
  echo "    --region $REGION \\"
  echo "    --secret-string '{\"token\":\"hf_XXXXXXXXXXXX\"}'"
  echo ""
  exit 1
fi
echo "  ✓ hf-token Secret 확인"

# ─── 2. CDK 빌드 ──────────────────────────────────────────────────────────────
echo "▶ CDK TypeScript 빌드"
npm run build

# ─── 3. 인프라 스택 배포 (--skip-infra 가 아닐 때) ────────────────────────────
if [[ "$SKIP_INFRA" == "false" ]]; then
  echo "▶ GenAiGwNetworkStack 배포"
  cdk deploy GenAiGwNetworkStack \
    --context "clusterName=$CLUSTER_NAME" \
    --require-approval never

  echo "▶ GenAiGwEksStack 배포"
  cdk deploy GenAiGwEksStack \
    --context "clusterName=$CLUSTER_NAME" \
    --require-approval never

  echo "▶ GenAiGwKarpenterStack 배포"
  cdk deploy GenAiGwKarpenterStack \
    --context "clusterName=$CLUSTER_NAME" \
    --require-approval never
else
  echo "⏭  --skip-infra: Network/EKS/Karpenter 배포 건너뜀"
fi

# ─── 4. kubeconfig 업데이트 ───────────────────────────────────────────────────
echo "▶ kubeconfig 업데이트"
aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$REGION"
kubectl get nodes

# ─── 5. EFS StorageClass + NVIDIA device plugin 확인 ──────────────────────────
echo "▶ EFS StorageClass 확인"
if ! kubectl get storageclass efs &>/dev/null; then
  echo "✗ StorageClass 'efs' 없음 — GenAiGwEksStack을 먼저 배포하세요"
  exit 1
fi

echo "▶ NVIDIA device plugin DaemonSet 확인"
if ! kubectl get daemonset -n kube-system nvidia-device-plugin-daemonset &>/dev/null; then
  echo "  NVIDIA device plugin이 없습니다. EKS Auto Mode가 자동 설치를 처리합니다."
  echo "  GPU 노드가 스케줄되면 자동으로 설치됩니다."
fi

# ─── 6. GenAiGwVllm-Coding 스택 배포 ─────────────────────────────────────────────
echo "▶ GenAiGwVllm-Coding 스택 배포 (Qwen3.5-27B, g5.12xlarge)"
cdk deploy GenAiGwVllm-Coding \
  --context "clusterName=$CLUSTER_NAME" \
  --require-approval never

echo ""
echo "✓ GenAiGwVllm-Coding 배포 완료"
echo ""
echo "다음 단계:"
echo "  1. EFS 마운트 + 콜드 스타트 확인: scripts/validate-phase1.sh --cold-start"
echo "  2. NLB DNS 조회 + cdk.json 업데이트: scripts/get-endpoints.sh --write-context"
echo "  3. Higress + SmartRouter 배포 후 E2E 테스트:"
echo "       cdk deploy GenAiGwEksStack GenAiGwHigressStack GenAiGwSmartRouterStack -c higressEndpoint=<higress-nlb-dns>"
echo "       scripts/apply-higress.sh && scripts/validate-phase1.sh --e2e"
