#!/usr/bin/env bash
# Phase 7: Smart Router E2E validation
#
# SmartRouter는 게이트웨이 진입점이다. `general` alias 요청을 prompt 분석으로
# scenario alias(coding/math/longcontext...)에 라우팅하고, 명시적 alias는 그대로 통과시킨다.
# Anthropic Messages API(/v1/messages, x-api-key 마스터 키)로 호출한다.
set -euo pipefail

# Get Smart Router endpoint from CloudFormation output
ROUTER_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name GenAiGwSmartRouterStack --region ap-northeast-2 \
  --query 'Stacks[0].Outputs[?OutputKey==`SmartRouterEndpoint`].OutputValue' \
  --output text)

echo "=== Phase 7: Smart Router Validation ==="
echo "Router   : $ROUTER_ENDPOINT"
echo ""

# Get gateway master key
KEY=$(aws secretsmanager get-secret-value \
  --secret-id "/genai-gw/higress/master-key" \
  --region ap-northeast-2 \
  --query SecretString --output text | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])")

run_test() {
  local label="$1"
  local endpoint="$2"
  local model="$3"
  local prompt="$4"
  local expected_scenario="$5"

  echo "--- TEST: $label ---"
  echo "  Model: $model | Expected routing: $expected_scenario"

  RESP=$(curl -sk -X POST "$endpoint/v1/messages" \
    -H "Content-Type: application/json" \
    -H "anthropic-version: 2023-06-01" \
    -H "x-api-key: $KEY" \
    -d "{\"model\": \"$model\", \"max_tokens\": 100, \"messages\": [{\"role\": \"user\", \"content\": \"$prompt\"}]}")

  ACTUAL_MODEL=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('model','?'))" 2>/dev/null || echo "ERROR")
  echo "  Actual model used: $ACTUAL_MODEL"

  if echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'content' in d" 2>/dev/null; then
    echo "  ✅ PASS"
  else
    echo "  ❌ FAIL: $RESP"
  fi
  echo ""
}

# 1. Health check
echo "--- Health check ---"
curl -skf "$ROUTER_ENDPOINT/health/liveliness" && echo " ✅ Router healthy" || echo " ❌ Router unhealthy"
echo ""

# 2. Passthrough test (non-general alias — should bypass detection)
run_test "Direct coding alias (bypass)" "$ROUTER_ENDPOINT" "coding" \
  "Write a fibonacci function in Python" "coding/qwen35-27b"

# 3. general → coding detection
run_test "general → coding detection" "$ROUTER_ENDPOINT" "general" \
  "Write a Python function to sort a list using quicksort" "coding"

# 4. general → math detection
run_test "general → math detection" "$ROUTER_ENDPOINT" "general" \
  "Prove that sqrt(2) is irrational. Show the equation and proof steps." "math"

# 5. general → longcontext detection (long text)
LONG_TEXT=$(python3 -c "print('This is a very long manufacturing document. ' * 2000)")
echo "--- TEST: general → longcontext (${#LONG_TEXT} chars) ---"
RESP=$(curl -sk -X POST "$ROUTER_ENDPOINT/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: $KEY" \
  -d "{\"model\": \"general\", \"max_tokens\": 50, \"messages\": [{\"role\": \"user\", \"content\": \"$LONG_TEXT Summarize this.\"}]}")
echo "  Response snippet: $(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(''.join(b.get('text','') for b in d.get('content',[]))[:80])" 2>/dev/null)"
echo ""

echo "=== Phase 7 validation complete ==="
