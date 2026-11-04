#!/usr/bin/env bash
# apply-higress.sh — Higress AI provider/route 구성을 console REST로 적용
#
# buildHigressConfig() 가 생성한 provider/route payload를 in-cluster higress-console
# (ClusterIP higress-console.higress-system:8080) 에 POST/PUT 한다. AI provider/route
# 는 단일 user-authorable CRD 가 아니라 console 백엔드가 ConfigMap+EnvoyFilter+WasmPlugin
# 으로 컴파일하므로 이 REST 경로가 유일하다. (vLLM 실패→Bedrock fallback 은 이제 Higress
# 가 아니라 SmartRouter 가 담당 — ai-proxy 2.0.0 의 Bedrock /v1/messages 한계, higress#3809.)
#
# 사용법:
#   ./scripts/apply-higress.sh                 # 적용 (kubectl + cdk.json vllmEndpoints 사용)
#   ./scripts/apply-higress.sh --dry-run       # payload 만 출력, console 호출 0
#   ./scripts/apply-higress.sh --console-url http://127.0.0.1:18001  # port-forward 없이 직접
#
# 전제:
#   - kubectl 이 genai-gw(EKS) 컨텍스트로 설정됨 (--console-url 직접 지정 시 불필요)
#   - jq, python3, ts-node(npx) 설치
#   - AWS_DEFAULT_REGION=ap-northeast-2, Secrets Manager 읽기 권한
#
# 멱등성: provider/route 는 name 기준 upsert. 재실행 안전(GET→있으면 PUT, 없으면 POST).
#   - route 는 같은 name 으로 POST 시 HTTP 409 (conflict) → GET-first 분기가 필수.
#   - provider 는 re-POST 가 201 로 통과하지만 일관성 위해 동일하게 PUT.
#   (둘 다 live console 로 검증: PUT=200, DELETE=204.)

set -euo pipefail

REGION=${AWS_DEFAULT_REGION:-ap-northeast-2}
NAMESPACE="higress-system"
CONSOLE_SVC="higress-console"
CONSOLE_PORT=8080
BEDROCK_SECRET="/genai-gw/higress/bedrock-creds"
MASTER_KEY_SECRET="/genai-gw/higress/master-key"   # gateway consumer API key (key-auth)
CONSOLE_SECRET="higress-console"   # k8s Secret with admin creds (chart-managed)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CDK_JSON="$REPO_DIR/cdk.json"

DRY_RUN=false
CONSOLE_URL=""
LOCAL_PORT=18080   # local side of the port-forward tunnel (avoid clashing common ports)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)      DRY_RUN=true; shift ;;
    --console-url)  CONSOLE_URL="$2"; shift 2 ;;
    --local-port)   LOCAL_PORT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

log() { echo "▶ $*"; }

# ── 1. vLLM 엔드포인트 (cdk.json context) ──────────────────────────────────────
# get-endpoints.sh --write-context 가 채워둔 vllmEndpoints 를 그대로 재사용한다.
VLLM_ENDPOINTS=$(python3 -c "
import json,sys
try:
    cdk=json.load(open('$CDK_JSON'))
except Exception as e:
    sys.stderr.write('cdk.json 읽기 실패: %s\n'%e); sys.exit(1)
ep=cdk.get('context',{}).get('vllmEndpoints',{})
print(json.dumps(ep))
")
if [[ "$VLLM_ENDPOINTS" == "{}" || -z "$VLLM_ENDPOINTS" ]]; then
  echo "⚠  cdk.json 에 vllmEndpoints 가 비어 있습니다. 먼저 ./scripts/get-endpoints.sh --write-context 실행." >&2
  echo "   (placeholder 엔드포인트로라도 적용하려면 cdk.json 에 수동 기입.)" >&2
  exit 1
fi
log "vLLM endpoints: $(echo "$VLLM_ENDPOINTS" | jq -c 'keys')"

# ── 2. Bedrock AK/SK + gateway API key (Secrets Manager) ───────────────────────
# dry-run 은 secret 없이 payload 형태만 본다(평문 키/토큰 노출 0).
BEDROCK_CREDS=""
GATEWAY_API_KEY=""
if ! $DRY_RUN; then
  log "Bedrock creds 조회: $BEDROCK_SECRET"
  BEDROCK_CREDS=$(aws secretsmanager get-secret-value \
    --secret-id "$BEDROCK_SECRET" --region "$REGION" \
    --query SecretString --output text 2>/dev/null || echo "")
  if [[ -z "$BEDROCK_CREDS" ]]; then
    echo "⚠  $BEDROCK_SECRET 를 읽지 못했습니다. GenAiGwHigressStack 배포 여부 확인." >&2
    exit 1
  fi

  log "gateway API key 조회: $MASTER_KEY_SECRET (key-auth consumer)"
  GATEWAY_API_KEY=$(aws secretsmanager get-secret-value \
    --secret-id "$MASTER_KEY_SECRET" --region "$REGION" \
    --query SecretString --output text 2>/dev/null | jq -r '.key // empty' || echo "")
  if [[ -z "$GATEWAY_API_KEY" ]]; then
    echo "⚠  $MASTER_KEY_SECRET 의 .key 를 읽지 못했습니다. GenAiGwHigressStack 배포 여부 확인." >&2
    exit 1
  fi
fi

# ── 3. payload 생성 (generator = 단일 진실원천) ────────────────────────────────
log "config payload 생성 (config/emit-higress-config.ts)"
PAYLOAD=$(cd "$REPO_DIR" && VLLM_ENDPOINTS="$VLLM_ENDPOINTS" BEDROCK_CREDS="$BEDROCK_CREDS" \
  GATEWAY_API_KEY="$GATEWAY_API_KEY" npx --yes ts-node config/emit-higress-config.ts)

CONSUMERS=$(echo "$PAYLOAD" | jq -c '.consumers')
PROVIDERS=$(echo "$PAYLOAD" | jq -c '.providers')
ROUTES=$(echo "$PAYLOAD" | jq -c '.routes')
N_CONSUMER=$(echo "$CONSUMERS" | jq 'length')
N_PROV=$(echo "$PROVIDERS" | jq 'length')
N_ROUTE=$(echo "$ROUTES" | jq 'length')
log "생성됨: consumers=$N_CONSUMER providers=$N_PROV routes=$N_ROUTE"

if $DRY_RUN; then
  echo ""
  echo "=== DRY RUN — consumers ==="
  # GATEWAY_API_KEY 없이는 consumer 가 비어 있지만, 혹시 모를 노출 방지로 토큰 마스킹.
  echo "$CONSUMERS" | jq '[.[] | .credentials |= map(.values=["***"])]'
  echo "=== DRY RUN — providers ==="
  # 평문 키가 BEDROCK_CREDS 없이는 애초에 없지만, 혹시 모를 노출 방지로 마스킹.
  echo "$PROVIDERS" | jq '[.[] | if .rawConfigs.awsSecretKey then .rawConfigs.awsSecretKey="***" else . end]'
  echo "=== DRY RUN — routes ==="
  echo "$ROUTES" | jq '.'
  echo ""
  echo "(dry-run: console 호출 없음)"
  exit 0
fi

# ── 4. console 접근 (port-forward 또는 직접 URL) ───────────────────────────────
PF_PID=""
cleanup() { [[ -n "$PF_PID" ]] && kill "$PF_PID" 2>/dev/null || true; }
trap cleanup EXIT

if [[ -z "$CONSOLE_URL" ]]; then
  log "kubectl port-forward svc/$CONSOLE_SVC $LOCAL_PORT:$CONSOLE_PORT (-n $NAMESPACE)"
  kubectl port-forward -n "$NAMESPACE" "svc/$CONSOLE_SVC" "$LOCAL_PORT:$CONSOLE_PORT" >/dev/null 2>&1 &
  PF_PID=$!
  CONSOLE_URL="http://127.0.0.1:$LOCAL_PORT"
  # 터널이 열릴 때까지 대기
  for i in $(seq 1 20); do
    if curl -s -o /dev/null "$CONSOLE_URL" 2>/dev/null; then break; fi
    sleep 0.5
  done
fi
log "console: $CONSOLE_URL"

# ── 5. console 세션 확보 (필요 시 첫 배포 admin 부트스트랩 자동) ─────────────────
# 정상 배포본은 console admin creds 를 `higress-console` k8s Secret 에 평문으로 보관한다.
# 하지만 fresh Helm Higress 는 system.initialized=false + 그 Secret 이 비어 있다 →
# 그땐 /system/init 로 admin 을 만들고 /user/changePassword 로 정식 PW 를 박으면 console
# 이 creds 를 Secret 에 자동 기입한다(이후 재실행은 Secret 의 값으로 그냥 로그인).
# console admin PW = gateway master-key(.key) 로 고정 → Secrets Manager 로 항상 복구 가능.
CONSOLE_USER="admin"
CONSOLE_FINAL_PW="$GATEWAY_API_KEY"                # 최종 PW = master-key (복구 가능)
CONSOLE_INIT_PW="Init${GATEWAY_API_KEY:0:20}"      # 부트스트랩 임시 PW (alphanumeric, ≠ final)

COOKIES=$(mktemp)
trap 'rm -f "$COOKIES"; cleanup' EXIT

# console 로그인 (지정 PW). HTTP code 를 stdout 으로 반환 (200/201 = 성공).
console_login() {
  local pw="$1"
  curl -s -c "$COOKIES" -o /dev/null -w '%{http_code}' \
    -X POST "$CONSOLE_URL/session/login" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg u "$CONSOLE_USER" --arg p "$pw" '{username:$u,password:$p}')" \
    || echo "000"
}

SESSION_OK=false

# 1) Secret 에 admin PW 가 있으면 그걸로 로그인 (정상 배포본 / 재실행 경로)
SECRET_PASS=$(kubectl get secret -n "$NAMESPACE" "$CONSOLE_SECRET" \
  -o jsonpath='{.data.adminPassword}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
if [[ -n "$SECRET_PASS" ]]; then
  log "console 로그인 (k8s Secret $CONSOLE_SECRET 의 admin creds)"
  [[ "$(console_login "$SECRET_PASS")" =~ ^20[01]$ ]] && SESSION_OK=true
fi

# 2) 로그인 못 했으면 첫 배포로 보고 /system/init → changePassword 부트스트랩 (멱등)
if [[ "$SESSION_OK" != "true" ]]; then
  log "console 미초기화로 판단 → /system/init 부트스트랩"
  INIT_CODE=$(curl -s -o /tmp/apply-higress-init.json -w '%{http_code}' \
    -X POST "$CONSOLE_URL/system/init" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg u "$CONSOLE_USER" --arg p "$CONSOLE_INIT_PW" \
            '{adminUser:{name:$u,displayName:$u,password:$p}}')" || echo "000")

  if [[ "$INIT_CODE" =~ ^20[01]$ ]]; then
    log "/system/init OK → 임시 PW 로그인 → 정식 PW(master-key)로 변경"
    if [[ ! "$(console_login "$CONSOLE_INIT_PW")" =~ ^20[01]$ ]]; then
      echo "⚠  init 직후 임시 PW 로그인 실패." >&2; exit 1
    fi
    CP_CODE=$(curl -s -b "$COOKIES" -o /tmp/apply-higress-cp.json -w '%{http_code}' \
      -X POST "$CONSOLE_URL/user/changePassword" -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg o "$CONSOLE_INIT_PW" --arg n "$CONSOLE_FINAL_PW" \
              '{oldPassword:$o,newPassword:$n}')" || echo "000")
    if [[ ! "$CP_CODE" =~ ^20[01]$ ]]; then
      echo "⚠  changePassword 실패 (HTTP $CP_CODE)." >&2; exit 1
    fi
    if [[ ! "$(console_login "$CONSOLE_FINAL_PW")" =~ ^20[01]$ ]]; then
      echo "⚠  정식 PW 재로그인 실패." >&2; exit 1
    fi
    SESSION_OK=true
  else
    # init 실패(이미 초기화됐을 수 있음) → 최종 PW(master-key)로 마지막 로그인 시도
    log "/system/init HTTP $INIT_CODE — 이미 초기화 가정, master-key 로 로그인 재시도"
    [[ "$(console_login "$CONSOLE_FINAL_PW")" =~ ^20[01]$ ]] && SESSION_OK=true
  fi
fi

if [[ "$SESSION_OK" != "true" ]]; then
  echo "⚠  console 세션을 확보하지 못했습니다 ($CONSOLE_URL)." >&2
  echo "   k8s Secret $CONSOLE_SECRET 의 adminPassword 또는 console 상태를 점검하세요." >&2
  exit 1
fi

# ── 6. upsert 헬퍼 (name 기준; 있으면 PUT, 없으면 POST) ─────────────────────────
# coll = collection path under CONSOLE_URL, e.g. "v1/ai/providers" / "v1/ai/routes" /
#        "v1/consumers" (consumers live OUTSIDE the /v1/ai tree). label = 표시용.
# 멱등성: 생성기 payload 는 'version' 필드를 절대 싣지 않는다. version 없는 PUT 은
#   console 의 optimistic-concurrency 검사를 건너뛰어 항상 통과(200) — stale version 을
#   실으면 409(ResourceConflictException).
upsert() {
  local coll="$1" name="$2" body="$3"
  local existing
  existing=$(curl -s -b "$COOKIES" "$CONSOLE_URL/$coll" \
    | jq -r --arg n "$name" '.data[]? | select(.name==$n) | .name' 2>/dev/null || echo "")
  local method url code
  if [[ "$existing" == "$name" ]]; then
    method=PUT; url="$CONSOLE_URL/$coll/$name"
  else
    method=POST; url="$CONSOLE_URL/$coll"
  fi
  code=$(curl -s -b "$COOKIES" -o /tmp/apply-higress-resp.json -w '%{http_code}' \
    -X "$method" "$url" -H 'Content-Type: application/json' -d "$body")
  if [[ "$code" == "200" || "$code" == "201" ]]; then
    echo "  ✓ $coll/$name ($method $code)"
  else
    local msg; msg=$(jq -r '.message // empty' /tmp/apply-higress-resp.json 2>/dev/null || echo "")
    echo "  ✗ $coll/$name ($method $code) ${msg}" >&2
    return 1
  fi
}

# ── 7. consumers → providers → routes 순서 (route 는 provider+consumer 를 참조) ──
# consumer 가 먼저 있어야 route 의 authConfig.allowedConsumers 가 유효하다.
if [[ "$N_CONSUMER" -gt 0 ]]; then
  log "consumers 적용 ($N_CONSUMER, key-auth)"
  echo "$CONSUMERS" | jq -c '.[]' | while read -r c; do
    upsert v1/consumers "$(echo "$c" | jq -r '.name')" "$c"
  done
else
  log "consumers 없음 (GATEWAY_API_KEY 미주입) — route 인증 미적용"
fi

log "providers 적용 ($N_PROV)"
echo "$PROVIDERS" | jq -c '.[]' | while read -r p; do
  upsert v1/ai/providers "$(echo "$p" | jq -r '.name')" "$p"
done

log "routes 적용 ($N_ROUTE)"
echo "$ROUTES" | jq -c '.[]' | while read -r r; do
  upsert v1/ai/routes "$(echo "$r" | jq -r '.name')" "$r"
done

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  Higress 구성 적용 완료: consumers=$N_CONSUMER providers=$N_PROV routes=$N_ROUTE"
echo "  검증: curl -b <cookie> $CONSOLE_URL/v1/ai/routes | jq '.data[].name'"
echo "══════════════════════════════════════════════════════════"
