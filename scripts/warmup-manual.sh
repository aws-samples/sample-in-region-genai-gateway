#!/usr/bin/env bash
# warmup-manual.sh — In-Region GenAI Gateway vLLM warm-up/cool-down 수동 실행
#
# Usage:
#   scripts/warmup-manual.sh warmup     # 모든 scale-to-zero 모델 warm-up (readiness 대기)
#   scripts/warmup-manual.sh cooldown   # 모든 모델 scale-to-zero
#   scripts/warmup-manual.sh status     # 현재 warm-up/cool-down SFN 실행 상태 확인
#
# Pre-requisites:
#   - AWS_DEFAULT_REGION=ap-northeast-2 (or configured profile)
#   - GenAiGwWarmupStack deployed

set -euo pipefail

REGION=${AWS_DEFAULT_REGION:-ap-northeast-2}
ACTION=${1:-status}

# ── 스택 출력에서 ARN 조회 ────────────────────────────────────────────────────
get_stack_output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --stack-name GenAiGwWarmupStack \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text
}

case "$ACTION" in
  warmup)
    WARMUP_ARN=$(get_stack_output "WarmupMachineArn")
    TARGETS=$(get_stack_output "WarmupTargets")
    echo "▶ Warm-up 시작: $TARGETS"
    EXEC=$(aws stepfunctions start-execution \
      --state-machine-arn "$WARMUP_ARN" \
      --region "$REGION" \
      --input '{"source":"manual"}' \
      --query executionArn --output text)
    echo "  실행 ARN: $EXEC"
    echo ""
    echo "▶ 준비 완료까지 대기 중 (최대 25분)..."
    aws stepfunctions wait execution-complete \
      --execution-arn "$EXEC" \
      --region "$REGION" && echo "✅ Warm-up 완료" || echo "⚠ Warm-up 타임아웃 또는 실패"
    ;;

  cooldown)
    COOLDOWN_ARN=$(get_stack_output "CooldownMachineArn")
    TARGETS=$(get_stack_output "WarmupTargets")
    echo "▶ Cool-down 시작: $TARGETS"
    EXEC=$(aws stepfunctions start-execution \
      --state-machine-arn "$COOLDOWN_ARN" \
      --region "$REGION" \
      --input '{"source":"manual"}' \
      --query executionArn --output text)
    echo "  실행 ARN: $EXEC"
    aws stepfunctions wait execution-complete \
      --execution-arn "$EXEC" \
      --region "$REGION" && echo "✅ Cool-down 완료" || echo "⚠ Cool-down 실패"
    ;;

  status)
    WARMUP_ARN=$(get_stack_output "WarmupMachineArn")
    COOLDOWN_ARN=$(get_stack_output "CooldownMachineArn")
    echo "══ GenAiGwWarmupStack 상태 ════════════════════════════════"
    echo ""
    echo "▶ Warm-up SFN 최근 실행:"
    aws stepfunctions list-executions \
      --state-machine-arn "$WARMUP_ARN" \
      --region "$REGION" \
      --max-results 3 \
      --query 'executions[*].{Status:status,Start:startDate,Name:name}' \
      --output table 2>/dev/null || echo "  (실행 기록 없음)"

    echo ""
    echo "▶ Cool-down SFN 최근 실행:"
    aws stepfunctions list-executions \
      --state-machine-arn "$COOLDOWN_ARN" \
      --region "$REGION" \
      --max-results 3 \
      --query 'executions[*].{Status:status,Start:startDate,Name:name}' \
      --output table 2>/dev/null || echo "  (실행 기록 없음)"

    echo ""
    echo "▶ vLLM Deployment 현황 (kubectl):"
    kubectl get deployment -n vllm 2>/dev/null || echo "  (kubectl 미설정 또는 접근 불가)"
    ;;

  *)
    echo "Usage: $0 [warmup|cooldown|status]"
    exit 1
    ;;
esac
