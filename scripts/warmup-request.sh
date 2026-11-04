#!/usr/bin/env bash
# warmup-request.sh — In-Region GenAI Gateway warm-up reservation 요청
#
# Usage:
#   scripts/warmup-request.sh [OPTIONS]
#
# Options:
#   --alias <alias>       모델 alias (coding|math|ocr|video|longcontext|audio|all)
#                         여러 alias: --alias coding,math
#                         기본값: all
#   --duration <duration> 유지 시간 (예: 1h, 30m, 2h30m, 3600)
#                         기본값: 1h
#   --requester <name>    요청자 이름 (로그/대시보드 표시용)
#                         기본값: $USER
#
# Examples:
#   scripts/warmup-request.sh
#   scripts/warmup-request.sh --alias coding --duration 2h
#   scripts/warmup-request.sh --alias coding,math --duration 3h --requester andrew
#   scripts/warmup-request.sh --alias all --duration 30m
#
# Pre-requisites:
#   - AWS CLI configured with ap-northeast-2 profile
#   - GenAiGwReservationStack deployed

set -euo pipefail

REGION=${AWS_DEFAULT_REGION:-ap-northeast-2}
ALIAS="all"
DURATION="1h"
REQUESTER="${USER:-unknown}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --alias)      ALIAS="$2";     shift 2 ;;
    --duration)   DURATION="$2";  shift 2 ;;
    --requester)  REQUESTER="$2"; shift 2 ;;
    -h|--help)
      sed -n '/^# Usage/,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Parse duration → seconds ──────────────────────────────────────────────────
parse_duration() {
  local d="$1"
  local secs=0
  # e.g. 2h30m, 1h, 45m, 3600
  if [[ "$d" =~ ^[0-9]+$ ]]; then
    secs="$d"
  else
    [[ "$d" =~ ([0-9]+)h ]] && secs=$(( secs + ${BASH_REMATCH[1]} * 3600 ))
    [[ "$d" =~ ([0-9]+)m ]] && secs=$(( secs + ${BASH_REMATCH[1]} * 60 ))
    [[ "$d" =~ ([0-9]+)s ]] && secs=$(( secs + ${BASH_REMATCH[1]} ))
  fi
  if [[ "$secs" -eq 0 ]]; then
    echo "Error: could not parse duration '$d'" >&2; exit 1
  fi
  echo "$secs"
}

DURATION_SECS=$(parse_duration "$DURATION")

# ── Get ReserveFn ARN from CloudFormation ─────────────────────────────────────
RESERVE_FN_ARN=$(aws cloudformation describe-stacks \
  --stack-name GenAiGwReservationStack \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`ReserveFnArn`].OutputValue' \
  --output text 2>/dev/null)

if [[ -z "$RESERVE_FN_ARN" ]]; then
  echo "Error: GenAiGwReservationStack not deployed or ReserveFnArn output not found." >&2
  exit 1
fi

# ── Call Lambda ───────────────────────────────────────────────────────────────
PAYLOAD=$(python3 -c "import json; print(json.dumps({
  'alias': '$ALIAS',
  'durationSecs': $DURATION_SECS,
  'requester': '$REQUESTER',
}))")

echo "▶ Warm-up reservation 요청..."
echo "  Alias    : $ALIAS"
echo "  Duration : $DURATION (${DURATION_SECS}s)"
echo "  Requester: $REQUESTER"
echo ""

OUTFILE=$(mktemp /tmp/genai-gw-reserve-XXXXXX.json)
HTTP_STATUS=$(aws lambda invoke \
  --function-name "$RESERVE_FN_ARN" \
  --region "$REGION" \
  --cli-binary-format raw-in-base64-out \
  --payload "$PAYLOAD" \
  --query 'StatusCode' \
  --output text \
  "$OUTFILE" 2>/dev/null)

RESULT=$(cat "$OUTFILE" 2>/dev/null)
rm -f "$OUTFILE"

# Check for Lambda error
if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'errorMessage' not in d else 1)" 2>/dev/null; then
  true
else
  ERR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('errorMessage','unknown error'))" 2>/dev/null)
  echo "❌ 오류: $ERR" >&2
  exit 1
fi

# Parse result
RID=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('reservationId','?'))" 2>/dev/null || echo "?")
SCALED=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(', '.join(d.get('scaledUp',[])))" 2>/dev/null || echo "")
EXPIRE=$(echo "$RESULT" | python3 -c "
import sys, json, datetime
d = json.load(sys.stdin)
ts = d.get('expireAt', 0)
if ts:
  dt = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone(datetime.timedelta(hours=9)))
  print(dt.strftime('%Y-%m-%d %H:%M KST'))
else:
  print('?')
" 2>/dev/null || echo "?")

echo "✅ Reservation 등록 완료"
echo "  ID      : ${RID:0:8}..."
echo "  만료    : $EXPIRE"
if [[ -n "$SCALED" ]]; then
  echo "  Scale-up: $SCALED (warm-up 시작 — 준비까지 ~8분)"
else
  echo "  Scale-up: 이미 활성 reservation 있음 — scale-up 불필요"
fi
echo ""
echo "  현황 확인: https://admin.genai-gw.internal"
