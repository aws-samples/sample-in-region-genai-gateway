#!/usr/bin/env bash
# NLB DNS 조회 → cdk.json context 업데이트 (vllmEndpoints + higressEndpoint)
# 사용법: ./scripts/get-endpoints.sh [--write-context]
#
#  --write-context  조회된 DNS를 cdk.json context에 자동 기록
#                   - vllmEndpoints: per-alias vLLM NLB 맵 (apply-higress.sh + SmartRouter pre-flight)
#                   - higressEndpoint: Higress gateway NLB host (SmartRouter upstream)
#
# bash 3.2(macOS 기본) 호환: associative array를 쓰지 않고 'alias:service' 라인 목록으로 처리.

set -euo pipefail

WRITE_CONTEXT=false
for arg in "$@"; do
  [[ "$arg" == "--write-context" ]] && WRITE_CONTEXT=true
done

NAMESPACE="vllm"
HIGRESS_NS="higress-system"
HIGRESS_SVC="higress-gateway-nlb"   # higress-stack.ts: HigressStack.GATEWAY_NLB_SVC
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_JSON="$SCRIPT_DIR/../cdk.json"

# alias:nlb-service-name (config/models.ts의 6개 alias와 일치)
MODEL_SERVICES="
coding:qwen35-27b-nlb
video:qwen35-27b-video-nlb
ocr:internvl3-14b-nlb
longcontext:llama4-scout-nlb
math:gemma4-31b-nlb
audio:phi4-multimodal-nlb
"

echo "▶ vLLM NLB DNS 조회 (namespace: $NAMESPACE)"
echo ""

# alias\tendpoint 라인을 누적 (bash 3 호환)
ENDPOINT_LINES=""
COUNT=0

for pair in $MODEL_SERVICES; do
  alias="${pair%%:*}"
  svc="${pair##*:}"
  hostname=$(kubectl get svc -n "$NAMESPACE" "$svc" \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")

  if [[ -z "$hostname" ]]; then
    echo "  ⚠  $alias ($svc): NLB 아직 프로비저닝 중 (Service 없거나 hostname 미할당)"
  else
    endpoint="http://${hostname}:8000"
    ENDPOINT_LINES="${ENDPOINT_LINES}${alias}	${endpoint}
"
    COUNT=$(( COUNT + 1 ))
    echo "  ✓ $alias → $endpoint"
  fi
done

echo ""
echo "▶ Higress gateway NLB DNS 조회 (namespace: $HIGRESS_NS, svc: $HIGRESS_SVC)"
echo ""

# higressEndpoint는 host-only (scheme/port 없음) — bin/in-region-genai-gateway.ts 가 그렇게 기대.
HIGRESS_ENDPOINT=$(kubectl get svc -n "$HIGRESS_NS" "$HIGRESS_SVC" \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")

if [[ -z "$HIGRESS_ENDPOINT" ]]; then
  echo "  ⚠  Higress gateway NLB 아직 프로비저닝 중 (Service 없거나 hostname 미할당)"
else
  echo "  ✓ higressEndpoint → $HIGRESS_ENDPOINT"
fi

echo ""

if [[ "$COUNT" -eq 0 ]]; then
  echo "조회된 vLLM NLB DNS가 없습니다. vLLM NLB Service가 Ready 상태인지 확인하세요:"
  echo "  kubectl get svc -n $NAMESPACE"
  exit 1
fi

if [[ "$WRITE_CONTEXT" == "true" ]]; then
  echo "▶ cdk.json context 업데이트 (vllmEndpoints + higressEndpoint)"

  # Python으로 cdk.json context 업데이트. 입력은 전부 env 로 전달한다 —
  # heredoc(`<<'PYTHON'`) 이 python 의 stdin 을 차지하므로 라인을 stdin 으로 주면
  # python 이 못 읽는다(EOF). 그래서 ENDPOINT_LINES·HIGRESS_ENDPOINT 둘 다 env.
  #   - ENDPOINT_LINES: alias\tendpoint 라인 목록
  #   - HIGRESS_ENDPOINT: Higress gateway NLB host (비어 있으면 키를 건드리지 않음)
  ENDPOINT_LINES="$ENDPOINT_LINES" HIGRESS_ENDPOINT="$HIGRESS_ENDPOINT" \
    python3 - "$CDK_JSON" <<'PYTHON'
import json, os, sys

cdk_json = sys.argv[1]
endpoints = {}
for line in os.environ.get("ENDPOINT_LINES", "").splitlines():
    line = line.rstrip("\n")
    if not line:
        continue
    alias, endpoint = line.split("\t", 1)
    endpoints[alias] = endpoint

with open(cdk_json) as f:
    cdk = json.load(f)

ctx = cdk.setdefault("context", {})
ctx["vllmEndpoints"] = endpoints

higress = os.environ.get("HIGRESS_ENDPOINT", "").strip()
if higress:
    ctx["higressEndpoint"] = higress

with open(cdk_json, "w") as f:
    json.dump(cdk, f, indent=2, ensure_ascii=False)
    f.write("\n")

print("  ✓ cdk.json 업데이트 완료")
print("  vllmEndpoints:", json.dumps(endpoints, indent=4))
if higress:
    print("  higressEndpoint:", higress)
else:
    print("  higressEndpoint: (미조회 — Higress NLB 미준비, 키 건드리지 않음)")
PYTHON

  echo ""
  echo "다음 단계: ./scripts/finalize-deploy.sh (조회된 endpoint로 SmartRouter 재배포 + Higress 구성 적용)"
else
  echo "cdk.json에 아직 기록하지 않았습니다."
  echo "--write-context 옵션을 추가하면 자동으로 업데이트됩니다:"
  echo "  ./scripts/get-endpoints.sh --write-context"
fi
