#!/usr/bin/env bash
# issue-api-token.sh — Gateway API 키(연구원 온보딩) 안내
#
# Higress AI Gateway는 단일 공유 마스터 키(key-auth consumer)로 인증한다.
# 게이트웨이가 `x-api-key` 헤더의 마스터 키를 key-auth consumer로 검증한다 —
# 연구원별 독립 키 발급(per-key)은 현재 미지원이다(향후 Higress consumer 분리로 확장,
# README "Known Issues" I8 참조).
#
# 이 스크립트는 Secrets Manager에서 마스터 키를 조회해 Claude Code 설정 방법과 함께 출력한다.
#
# Usage:
#   ./scripts/issue-api-token.sh                 # 마스터 키 조회 + 온보딩 안내 출력
#
# Pre-requisites:
#   - AWS_DEFAULT_REGION=ap-northeast-2 (또는 --region 지원 CLI 환경)
#   - Secrets Manager read 권한
#   - jq installed

set -euo pipefail

REGION=${AWS_DEFAULT_REGION:-ap-northeast-2}
MASTER_KEY_SECRET="/genai-gw/higress/master-key"

# ── Get Higress master key ────────────────────────────────────────────────────
echo "▶ Fetching gateway master key from Secrets Manager ($MASTER_KEY_SECRET)..."
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$MASTER_KEY_SECRET" \
  --region "$REGION" \
  --query SecretString --output text)
MASTER_KEY=$(echo "$SECRET_JSON" | jq -r '.key')

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  In-Region GenAI Gateway — 연구원 온보딩"
echo ""
echo "  공유 마스터 키 (x-api-key): $MASTER_KEY"
echo ""
echo "  Claude Code 설정 방법:"
echo "  ─────────────────────"
echo "  # CA 인증서 설치 (최초 1회)"
echo "  aws secretsmanager get-secret-value \\"
echo "    --secret-id /genai-gw/gateway/ca-cert \\"
echo "    --query SecretString --output text \\"
echo "    --region ap-northeast-2 > genai-gw-ca.crt"
echo ""
echo "  # macOS"
echo "  sudo security add-trusted-cert -d -r trustRoot \\"
echo "    -k /Library/Keychains/System.keychain genai-gw-ca.crt"
echo ""
echo "  # ~/.claude/settings.json 또는 환경 변수"
echo "  export ANTHROPIC_BASE_URL=https://gateway.genai-gw.internal"
echo "  export ANTHROPIC_API_KEY=$MASTER_KEY"
echo ""
echo "  # 또는 .env"
echo "  ANTHROPIC_BASE_URL=https://gateway.genai-gw.internal"
echo "  ANTHROPIC_API_KEY=$MASTER_KEY"
echo "══════════════════════════════════════════════════════════"
