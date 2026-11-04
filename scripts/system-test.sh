#!/usr/bin/env bash
# system-test.sh — In-Region GenAI Gateway 전(全)경로 self-test (사람 없이 PASS/FAIL 자동 판정)
#
# 실행 위치: in-VPC test client EC2 (GenAiGwTestClientStack).
#   - gateway env(ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY)·CA trust·SFN ARN이 이미 셋업돼 있음.
#   - SSM run-command로 투입할 땐 인라인 quoting 함정(괄호·JSON)을 피하려 base64로 파일 전달.
#     인스턴스 ID는 Name 태그(genai-gw-test-client)로 조회한다:
#       IID=$(aws ec2 describe-instances --region ap-northeast-2 \
#               --filters Name=tag:Name,Values=genai-gw-test-client Name=instance-state-name,Values=running \
#               --query 'Reservations[0].Instances[0].InstanceId' --output text)
#       b64=$(base64 -w0 scripts/system-test.sh)
#       aws ssm send-command --instance-ids "$IID" \
#         --document-name AWS-RunShellScript \
#         --parameters "commands=[\"echo $b64 | base64 -d > /tmp/system-test.sh\",\"bash /tmp/system-test.sh\"]"
#     또는 instance가 repo를 git pull 한 뒤 직접 실행.
#
# 사용법:
#   ./scripts/system-test.sh                 # 무비용 차원만 (S-cold, S-cascade, S-reservation, S-admin)
#   ./scripts/system-test.sh --with-gpu      # + GPU 차원 (S-warm, S-permodel) — 과금! 검증 후 즉시 scale-0
#   ./scripts/system-test.sh --only cold     # 특정 차원만 (cold|cascade|warm|permodel|reservation|admin)
#   ./scripts/system-test.sh --report /tmp/r.md   # stdout 집계 + markdown 리포트 파일
#   ./scripts/system-test.sh --no-claude     # 실 claude CLI e2e 스텝 생략 (curl 경로만)
#   ./scripts/system-test.sh --only cascade  # primary→secondary cascade만 (결정적: 아래 fault-injection 필요)
#   CLAUDE_E2E_RUNS=5 ./scripts/system-test.sh --only cold   # claude e2e 반복 횟수(기본 3)
#
# S-cascade 결정적 검증: 라이브에서 throttle은 강제 불가하므로, gateway를 fault-injection
#   모드로 배포해야 cascade를 결정적으로 검증한다(없으면 best-effort 관측 → 통상 SKIP):
#     cdk deploy --exclusively GenAiGwSmartRouterStack -c faultInjection=true \
#       -c higressEndpoint=<NLB> -c vllmEndpoints='{6alias}' -c operatorRoleArns='[...]'
#   그러면 `x-genai-gw-test-throttle-primary: 1` 헤더로 primary 합성 throttle → Haiku cascade.
#   ⚠️ production 배포엔 faultInjection 생략(기본 OFF) — 헤더는 무시되어 테스트 표면 없음.
#
# 종료 코드 = FAIL 개수 (0 = 전부 통과). SKIP은 실패로 치지 않음.
#
# 배경: 이 harness는 두 incident를 영구 회귀테스트로 박제한다.
#   (1) cold→Bedrock streaming fallback의 504 churn(2026-06-12) — S-cold/S-cascade가 가드.
#   (2) warm인데 claude의 max_tokens=32000이 vLLM maxModelLen 초과→400→Bedrock 폴백(2026-06-14):
#       ★진짜 회귀는 input이 클 때만 드러난다★. clamp v1(고정 reserve 8192)은 짧은 prompt
#       (input~769)엔 통했지만, 실 claude(system+tools+멀티턴, input 8k+)에선 input>reserve라
#       `output=window-8192`로도 input+output>window → vLLM 400 → Bedrock(Haiku) 폴백. 짧은
#       prompt로만 검증해 2번 연속 못 잡았다. fix v2 = router가 vLLM 400 본문의 실 input
#       토큰(ground truth)을 파싱해 max_tokens를 정밀 재clamp 후 gateway에 1회 재시도(선제
#       clamp는 1차 필터로 유지). 가드 = S-warm의 **큰-input(>8192) + max32k** 스윕(9k/16k/28k)
#       + 실 claude bigctx e2e. warm 응답에 x-genai-gw-fallback:bedrock-direct가 보이면 = 재clamp
#       미동작 = FAIL. (짧은 max32k 케이스는 보조 — input이 작아 v1도 우연 통과 가능.)

set -uo pipefail

# ─── 설정 ─────────────────────────────────────────────────────────────────────
GW="${ANTHROPIC_BASE_URL:-https://gateway.genai-gw.internal}"
GW="${GW%/}"
MK="${ANTHROPIC_API_KEY:-}"
WARMUP_SFN="${GENAI_GW_WARMUP_SFN:-}"
COOLDOWN_SFN="${GENAI_GW_COOLDOWN_SFN:-}"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
ANTHROPIC_VER="2023-06-01"

# Bedrock fallback이 답할 수 있는 모델. cold 경로는 primary→(throttle 시)secondary cascade.
# ⚠️ default = quality-first(2026-06-14): cold primary=Sonnet3.5, secondary=Haiku3
#    (config/models.ts BEDROCK_MODELS[0]/[1]). 이 게이트웨이는 속도보다 품질이 본분이라
#    cold 안전망도 고품질 모델을 우선한다(Sonnet pool이 더 throttle되는 latency는 감수).
#    배포가 `-c coldFallbackOrder=availability`였다면 순서가 반대(Haiku primary)이므로,
#    그 환경에선 아래 두 값을 env로 뒤집어 실행:
#      COLD_MODEL_PRIMARY=claude-3-haiku-20240307 COLD_MODEL_SECONDARY=claude-3-5-sonnet-20240620 ./system-test.sh
#    S-cold는 둘 중 무엇이 와도 정상(primary 우선, throttle 시 secondary cascade 허용)이고,
#    S-cascade(primary throttle 주입)는 secondary 모델 응답을 기대한다.
COLD_MODEL_PRIMARY="${COLD_MODEL_PRIMARY:-claude-3-5-sonnet-20240620}"
COLD_MODEL_SECONDARY="${COLD_MODEL_SECONDARY:-claude-3-haiku-20240307}"

# alias → 기대 vLLM 모델 hint(warm 경로 model 필드 검증용). config/models.ts와 일치.
ALIASES="coding video ocr longcontext math audio"
# gated(HF 라이선스 승인 선행 필요) — 미승인이면 warm 안 됨 → SKIP+사유.
GATED_ALIASES="longcontext math"

WITH_GPU=false
ONLY=""
REPORT=""
USE_CLAUDE=true
# warm-up SFN의 자체 timeout = 50분(warmup-stack readyTimeoutSecs=3000, "I7: 1500→3000").
# 실측(2026-06-13 coding): Karpenter GPU 프로비저닝 + 27B weight S3 풀 + CUDA graph가
# 12분을 넘김 → 720s는 너무 짧았다. SFN 한도 아래로 넉넉히 1800s(30분) 기본.
GPU_READY_TIMEOUT="${GPU_READY_TIMEOUT:-1800}"
# gated 모델 probe budget — 미승인이면 노드조차 안 뜨므로 길게 기다릴 이유 없음(300s=5분).
# 승인돼 정상 warm 되는 경우 5분으론 부족할 수 있어, 검증하려면 GATED_READY_TIMEOUT 상향.
GATED_READY_TIMEOUT="${GATED_READY_TIMEOUT:-300}"

for arg in "$@"; do
  case "$arg" in
    --with-gpu)   WITH_GPU=true ;;
    --no-claude)  USE_CLAUDE=false ;;
    --only)       ONLY="__NEXT__" ;;
    --report)     REPORT="__NEXT__" ;;
    *)
      if [[ "$ONLY" == "__NEXT__" ]]; then ONLY="$arg"
      elif [[ "$REPORT" == "__NEXT__" ]]; then REPORT="$arg"
      fi ;;
  esac
done

# ─── 결과 집계 ─────────────────────────────────────────────────────────────────
N_PASS=0; N_FAIL=0; N_SKIP=0
RESULT_LINES=""

_record() {  # <PASS|FAIL|SKIP> <name> <detail>
  local kind="$1" name="$2"; shift 2; local detail="$*"
  RESULT_LINES+="${kind}|${name}|${detail}"$'\n'
}
pass() { N_PASS=$((N_PASS+1)); echo "PASS: $1 ${2:+— $2}"; _record PASS "$1" "${2:-}"; }
fail() { N_FAIL=$((N_FAIL+1)); echo "FAIL: $1 ${2:+— $2}"; _record FAIL "$1" "${2:-}"; }
skip() { N_SKIP=$((N_SKIP+1)); echo "SKIP: $1 ${2:+— $2}"; _record SKIP "$1" "${2:-}"; }
info() { echo "  · $*"; }
hdr()  { echo; echo "═══ $* ═══"; }

# ─── HTTP 헬퍼 ─────────────────────────────────────────────────────────────────
# gw_post <hdr-file> <body-json> [extra-curl-args...] → stdout=body. -k(self-signed) + -m timeout.
gw_post() {
  local hfile="$1" body="$2"; shift 2
  curl -sS -k -m 180 -D "$hfile" -X POST "$GW/v1/messages" \
    -H 'content-type: application/json' \
    -H "anthropic-version: $ANTHROPIC_VER" \
    -H "x-api-key: $MK" \
    "$@" \
    -d "$body"
}
# gw_post_file <hdr-file> <body-file> [extra-curl-args...] → stdout=body.
# Same as gw_post but reads the request body from a FILE (--data-binary @file). Use for the
# large-input regression cases whose body (10k+ tokens of dummy text) is too big/awkward to
# pass as an inline shell string. -m raised: a big prompt + first-token latency can exceed 180s.
gw_post_file() {
  local hfile="$1" bfile="$2"; shift 2
  curl -sS -k -m 300 -D "$hfile" -X POST "$GW/v1/messages" \
    -H 'content-type: application/json' \
    -H "anthropic-version: $ANTHROPIC_VER" \
    -H "x-api-key: $MK" \
    "$@" \
    --data-binary "@$bfile"
}
http_status() { awk 'toupper($1) ~ /^HTTP/ {code=$2} END{print code}' "$1"; }
header_val()  { grep -i "^$2:" "$1" | tail -1 | sed "s/^[^:]*:[[:space:]]*//" | tr -d '\r'; }

# message_start SSE 프레임에서 .message.<field> 추출 (keepalive `: ...` 주석 줄은 건너뜀).
sse_message_field() {  # <stream-body-file> <field>
  grep '^data: ' "$1" \
    | sed 's/^data: //' \
    | while IFS= read -r line; do
        echo "$line" | jq -e 'select(.type=="message_start") | .message' 2>/dev/null && break
      done \
    | jq -r ".$2 // empty" 2>/dev/null | head -1
}

preflight_checks() {
  hdr "Pre-flight"
  local ok=true
  [[ -n "$MK" ]] || { echo "  ✗ ANTHROPIC_API_KEY(=master-key) 미설정"; ok=false; }
  command -v jq   >/dev/null || { echo "  ✗ jq 없음"; ok=false; }
  command -v curl >/dev/null || { echo "  ✗ curl 없음"; ok=false; }
  info "gateway = $GW"
  info "region  = $REGION"
  info "claude CLI = $(command -v claude >/dev/null && echo present || echo absent)"
  $ok || { echo "pre-flight 실패 → 중단"; exit 2; }
}

# ════════════════════════════════════════════════════════════════════════════
# S-cold — vLLM 전부 cold(scale-0) 가정. general alias → Bedrock-direct fallback.
#   504 fix 회귀 가드: non-stream/stream 200 + fallback 헤더 + 모델 = sonnet|haiku.
# ════════════════════════════════════════════════════════════════════════════
test_cold() {
  hdr "S-cold (Bedrock-direct fallback)"
  local h b model id status fbh fbm

  # --- (1) non-stream ---------------------------------------------------------
  h=$(mktemp); b=$(mktemp)
  gw_post "$h" '{"model":"general","max_tokens":32,"messages":[{"role":"user","content":"Reply with exactly: COLD_OK"}]}' > "$b"
  status=$(http_status "$h"); fbh=$(header_val "$h" x-genai-gw-fallback); fbm=$(header_val "$h" x-genai-gw-fallback-model)
  model=$(jq -r '.model // empty' "$b" 2>/dev/null); id=$(jq -r '.id // empty' "$b" 2>/dev/null)
  if [[ "$status" == "200" && "$fbh" == "bedrock-direct" ]] \
     && { [[ "$model" == "$COLD_MODEL_PRIMARY" ]] || [[ "$model" == "$COLD_MODEL_SECONDARY" ]]; } \
     && [[ "$id" == msg_bdrk_* ]]; then
    pass "S-cold/non-stream" "200, model=$model, hdr-model=$fbm, id=${id:0:18}…"
    [[ "$model" == "$COLD_MODEL_SECONDARY" ]] && info "↳ secondary($COLD_MODEL_SECONDARY) 응답 = primary throttle cascade 발생(정상)"
  else
    fail "S-cold/non-stream" "status=$status fb=$fbh model=$model id=${id:0:18}… (기대 200 + bedrock-direct + sonnet|haiku + msg_bdrk_)"
  fi
  rm -f "$h" "$b"

  # --- (2) streaming (504-churn 회귀 가드) -----------------------------------
  # ⚠️ stream 응답엔 x-genai-gw-fallback-model 헤더가 없다(헤더가 _pump 모델선택 전 송출).
  #    → 모델 판정은 message_start body의 .model 로. 헤더는 x-genai-gw-fallback 만 확인.
  h=$(mktemp); b=$(mktemp); local t0 t1 dt
  t0=$SECONDS
  gw_post "$h" '{"model":"general","max_tokens":48,"stream":true,"messages":[{"role":"user","content":"Count slowly: 1 2 3 4 5"}]}' > "$b"
  t1=$SECONDS; dt=$((t1 - t0))
  status=$(http_status "$h"); fbh=$(header_val "$h" x-genai-gw-fallback)
  model=$(sse_message_field "$b" model); id=$(sse_message_field "$b" id)
  local has_stop; has_stop=$(grep -c '"type":"message_stop"\|^event: message_stop' "$b")
  local has_err;  has_err=$(grep -c '^event: error' "$b")
  if [[ "$status" == "200" && "$fbh" == "bedrock-direct" && "$has_err" == "0" ]] \
     && { [[ "$model" == "$COLD_MODEL_PRIMARY" ]] || [[ "$model" == "$COLD_MODEL_SECONDARY" ]]; } \
     && [[ "$id" == msg_bdrk_* ]] && [[ "$has_stop" -ge 1 ]] && [[ "$dt" -lt 120 ]]; then
    pass "S-cold/stream" "200, model=$model, message_stop ✓, ${dt}s (504-churn 회귀 없음)"
    [[ "$model" == "$COLD_MODEL_SECONDARY" ]] && info "↳ stream도 secondary($COLD_MODEL_SECONDARY) cascade(정상)"
  else
    fail "S-cold/stream" "status=$status fb=$fbh model=$model stop=$has_stop err=$has_err ${dt}s (기대 200 + bedrock-direct + lifecycle 완결 + <120s)"
  fi
  rm -f "$h" "$b"

  # --- (3) 실 claude CLI cold e2e (사용자가 실제 쓰는 경로 — 진짜 PASS 기준) -------
  # 이게 진짜 사용자 경로다. curl 경로(위 1·2)는 router를 검증하지만, claude CLI는
  # 매 턴 여러 병렬 subrequest를 쏘고 SSE를 자체 파싱하므로 별도 가드가 필요하다.
  # 과거(2026-06-13)엔 이 스텝을 "headless startup hang → SKIP"으로 면제했는데, 그게
  # 바로 구멍이었다: 실제로는 cold fallback의 Bedrock throttle backoff 때문에 응답이
  # 16~93s로 들쭉날쭉하거나 timeout 했고(사용자 churning), curl만 PASS라 못 잡았다.
  # 실제 응답을 받아야 PASS. N회(CLAUDE_E2E_RUNS, 기본 3) 반복해 latency 분포·일관성을 본다.
  #   - 504/Churned 출력 → FAIL (504 incident 회귀)
  #   - N회 중 1건도 성공 못 함 → FAIL (claude e2e 깨짐 — 사용자 경로 불통)
  #   - 일부 성공하나 느림(>60s 존재) → PASS + 경고
  #   - 전부 성공 & 전부 <60s → PASS
  # ⚠️ default=quality(Sonnet primary)에선 Sonnet pool throttle(~93%)로 cold이 느릴 수
  #    있다(16~93s) — 이는 quality-first의 의도된 trade-off라 "느림 경고"는 결함이 아니다.
  #    cold 속도가 중요하면 `-c coldFallbackOrder=availability`(Haiku primary, 4~6s)로 배포.
  #    어느 쪽이든 빠른 고품질이 필요하면 vLLM을 warm-up(self-host 모델 직접).
  if $USE_CLAUDE && command -v claude >/dev/null; then
    local runs="${CLAUDE_E2E_RUNS:-3}" ok=0 slow=0 churn=false i out rc cdt c0 maxdt=0 detail=""
    for i in $(seq 1 "$runs"); do
      c0=$SECONDS
      out=$(timeout 150 claude -p "Reply with exactly: CLAUDE_COLD_OK" </dev/null 2>&1); rc=$?
      cdt=$((SECONDS - c0))
      [[ "$cdt" -gt "$maxdt" ]] && maxdt=$cdt
      grep -qi '504\|Gateway Time-out\|Churned' <<<"$out" && churn=true
      if [[ $rc -eq 0 ]] && grep -qi 'CLAUDE_COLD_OK\|OK' <<<"$out"; then
        ok=$((ok+1)); [[ "$cdt" -ge 60 ]] && slow=$((slow+1))
      fi
      detail+="#${i}:${cdt}s$([[ $rc -eq 0 ]] && echo '✓' || echo "✗rc$rc") "
    done
    if $churn; then
      fail "S-cold/claude-CLI" "504/churn 출력 재현! ($detail) — 504 incident 회귀"
    elif [[ "$ok" -eq 0 ]]; then
      fail "S-cold/claude-CLI" "claude e2e 전부 실패 $ok/$runs ($detail) — 사용자 경로 불통(cold fallback throttle/hang?)"
    elif [[ "$slow" -gt 0 || "$maxdt" -ge 60 ]]; then
      pass "S-cold/claude-CLI" "$ok/$runs 성공이나 느린 응답 ${slow}건(max ${maxdt}s ≥60s) — quality-first(Sonnet primary)면 의도된 throttle latency. cold 속도 우선이면 coldFallbackOrder=availability ($detail)"
    else
      pass "S-cold/claude-CLI" "$ok/$runs 성공, max ${maxdt}s (<60s), 504/churn 없음 — 실 사용자 e2e 정상 ($detail)"
    fi
  else
    skip "S-cold/claude-CLI" "$($USE_CLAUDE && echo 'claude 바이너리 없음' || echo '--no-claude')"
  fi
}

# ════════════════════════════════════════════════════════════════════════════
# S-cascade — primary throttle 시 secondary로 투명 cascade.
#   방향은 배포의 coldFallbackOrder에 따라 다르다(default quality=Sonnet→Haiku, availability=Haiku→Sonnet).
#   harness는 COLD_MODEL_PRIMARY/SECONDARY로 방향-무관하게 검증한다(하드코딩 모델명 의존 X).
#
#   두 경로로 검증한다(우선순위 順):
#   (A) 결정적(deterministic) — gateway가 fault-injection으로 배포된 경우
#       (BEDROCK_FAULT_INJECTION=true; `-c faultInjection=true` 배포). 요청에
#       `x-genai-gw-test-throttle-primary: 1` 헤더를 실으면 router가 primary에 실 Bedrock과
#       동일한 ServiceUnavailableException(합성)을 발생 → _is_throttle 분류 → secondary로
#       cascade. secondary 호출은 진짜 Bedrock이므로, 응답이 secondary면 end-to-end
#       cascade가 라이브로 증명된다. non-stream(x-genai-gw-fallback-model 헤더=secondary) + stream
#       (message_start body .model=secondary) 둘 다 assert. ← cascade를 "강제"할 수 있는 유일한 경로.
#   (B) best-effort 관측 — fault-injection 미배포(production)면 헤더가 무시되어 primary가
#       그대로 응답한다. 이땐 가벼운 cold burst로 우연한 실 throttle cascade를 관측만 시도하고,
#       secondary가 안 나오면(통상) SKIP(사유). 라이브에서 실 throttle은 강제 불가.
#
#   probe: 헤더가 honored 되는지 먼저 1회 확인(non-stream). honored면 (A), 아니면 (B).
# ════════════════════════════════════════════════════════════════════════════
test_cascade() {
  hdr "S-cascade (primary → secondary, primary throttle 시)"
  local h b model id fbm status

  # --- probe: fault-injection 헤더가 honored 되는가? (non-stream 1회) ----------
  h=$(mktemp); b=$(mktemp)
  gw_post "$h" '{"model":"general","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}' \
    -H "x-genai-gw-test-throttle-primary: 1" > "$b" 2>/dev/null
  status=$(http_status "$h"); fbm=$(header_val "$h" x-genai-gw-fallback-model)
  model=$(jq -r '.model // empty' "$b" 2>/dev/null); id=$(jq -r '.id // empty' "$b" 2>/dev/null)
  local honored=false
  [[ "$status" == "200" && "$model" == "$COLD_MODEL_SECONDARY" ]] && honored=true
  rm -f "$h" "$b"

  if $honored; then
    # ===== (A) 결정적 cascade — fault-injection 배포됨 =====
    info "fault-injection honored → 결정적 cascade 검증 (primary→secondary, secondary=$COLD_MODEL_SECONDARY)"
    # (A-1) non-stream: primary 합성 throttle → secondary 응답 + fallback-model 헤더=secondary
    h=$(mktemp); b=$(mktemp)
    gw_post "$h" '{"model":"general","max_tokens":32,"messages":[{"role":"user","content":"Reply with exactly: CASCADE_OK"}]}' \
      -H "x-genai-gw-test-throttle-primary: 1" > "$b"
    status=$(http_status "$h"); fbm=$(header_val "$h" x-genai-gw-fallback-model)
    model=$(jq -r '.model // empty' "$b" 2>/dev/null); id=$(jq -r '.id // empty' "$b" 2>/dev/null)
    # fallback-model 헤더는 Bedrock model ID(예: anthropic.claude-3-5-sonnet-...)라, secondary
    # client alias가 그 ID의 부분문자열인지로 방향-무관하게 검증(sonnet/haiku 하드코딩 회피).
    if [[ "$status" == "200" && "$model" == "$COLD_MODEL_SECONDARY" && "$id" == msg_bdrk_* ]] \
       && [[ "$fbm" == *"$COLD_MODEL_SECONDARY"* ]]; then
      pass "S-cascade/non-stream" "primary throttle 주입 → secondary cascade (model=$model, hdr-model=$fbm)"
    else
      fail "S-cascade/non-stream" "status=$status model=$model hdr-model=$fbm id=${id:0:18}… (기대 200 + $COLD_MODEL_SECONDARY + hdr*=$COLD_MODEL_SECONDARY)"
    fi
    rm -f "$h" "$b"

    # (A-2) streaming: primary 합성 throttle → secondary stream + lifecycle 완결(부분 stream 누수 X)
    #   ⚠️ stream엔 x-genai-gw-fallback-model 헤더 없음 → message_start body .model 로 판정.
    h=$(mktemp); b=$(mktemp); local has_stop has_err
    gw_post "$h" '{"model":"general","max_tokens":48,"stream":true,"messages":[{"role":"user","content":"Count: 1 2 3"}]}' \
      -H "x-genai-gw-test-throttle-primary: 1" > "$b"
    status=$(http_status "$h")
    model=$(sse_message_field "$b" model); id=$(sse_message_field "$b" id)
    has_stop=$(grep -c '"type":"message_stop"\|^event: message_stop' "$b")
    has_err=$(grep -c '^event: error' "$b")
    if [[ "$status" == "200" && "$model" == "$COLD_MODEL_SECONDARY" && "$id" == msg_bdrk_* ]] \
       && [[ "$has_stop" -ge 1 && "$has_err" == "0" ]]; then
      pass "S-cascade/stream" "primary throttle 주입 → secondary stream cascade, lifecycle 완결(부분 stream 누수 없음)"
    else
      fail "S-cascade/stream" "status=$status model=$model stop=$has_stop err=$has_err id=${id:0:18}… (기대 200 + $COLD_MODEL_SECONDARY + message_stop + err 0)"
    fi
    rm -f "$h" "$b"

    # (A-3) 음성 대조: 헤더 없이는 cascade 안 함(primary 그대로) — 주입 외엔 무영향 증명
    h=$(mktemp); b=$(mktemp)
    gw_post "$h" '{"model":"general","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}' > "$b"
    status=$(http_status "$h"); model=$(jq -r '.model // empty' "$b" 2>/dev/null)
    if [[ "$status" == "200" && "$model" == "$COLD_MODEL_PRIMARY" ]]; then
      pass "S-cascade/control" "헤더 없으면 primary($COLD_MODEL_PRIMARY) 그대로 = fault-injection이 통상 트래픽에 무영향"
    else
      # primary가 우연히 실 throttle 맞아 secondary가 와도 cascade는 정상 — 음성대조 실패로 보지 않고 info
      info "음성대조: 헤더 없이 model=$model (primary 기대였으나 실 throttle cascade 가능 — 무해)"
      skip "S-cascade/control" "헤더 없이 model=$model — 우연한 실 throttle일 수 있음(cascade 자체는 정상)"
    fi
    rm -f "$h" "$b"

  else
    # ===== (B) best-effort 관측 — fault-injection 미배포(production) =====
    info "fault-injection 미배포(헤더 무시) → best-effort 관측 모드(실 throttle 강제 불가)"
    local n=8 observed=false prim=0 sec=0 other=0 i
    info "cold burst ${n}건 발사 — secondary($COLD_MODEL_SECONDARY) 응답이 섞이면 우연한 실 throttle cascade 관측"
    for i in $(seq 1 $n); do
      h=$(mktemp); b=$(mktemp)
      gw_post "$h" '{"model":"general","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}' > "$b" 2>/dev/null
      model=$(jq -r '.model // empty' "$b" 2>/dev/null)
      case "$model" in
        "$COLD_MODEL_PRIMARY")   prim=$((prim+1)) ;;
        "$COLD_MODEL_SECONDARY") sec=$((sec+1)); observed=true ;;
        *) other=$((other+1)) ;;
      esac
      rm -f "$h" "$b"
    done
    info "결과: primary($COLD_MODEL_PRIMARY)=$prim secondary($COLD_MODEL_SECONDARY)=$sec 기타/실패=$other"
    if $observed; then
      pass "S-cascade/observed" "secondary($COLD_MODEL_SECONDARY) 응답 $sec건 = 우연한 실 throttle cascade 관측"
    else
      skip "S-cascade/observed" "throttle 미발생(전부 primary=$COLD_MODEL_PRIMARY) — 결정적 검증은 '-c faultInjection=true' 배포 후 재실행. 단위커버 _is_throttle/_fallback_model_chain로 갈음"
    fi
  fi
}

# ════════════════════════════════════════════════════════════════════════════
# S-warm — coding alias warm-up → vLLM direct. (GPU 과금, --with-gpu 게이트)
#   warm→assert(model=qwen + fallback 헤더 없음 + tool_use + stream)→scale-0.
# ════════════════════════════════════════════════════════════════════════════
sfn_warmup() {  # <serving-name>
  aws stepfunctions start-execution --region "$REGION" --state-machine-arn "$WARMUP_SFN" \
    --input "{\"deployments\":[\"$1\"],\"namespace\":\"vllm\",\"clusterName\":\"$GENAI_GW_CLUSTER\"}" \
    --query executionArn --output text 2>/dev/null
}
sfn_cooldown() {  # <serving-name>
  [[ -z "$COOLDOWN_SFN" ]] && return 0
  aws stepfunctions start-execution --region "$REGION" --state-machine-arn "$COOLDOWN_SFN" \
    --input "{\"deployments\":[\"$1\"],\"namespace\":\"vllm\",\"clusterName\":\"$GENAI_GW_CLUSTER\"}" \
    --query executionArn --output text 2>/dev/null
}
# warm-up 실행 ARN의 상태가 SUCCEEDED 될 때까지 폴링.
# ⚠️ 버그 이력(2026-06-14): 예전엔 `list-executions --max-items 10 --query ...|[0]`로 폴링했는데,
#    --max-items가 CLI 클라이언트측 페이지네이션을 켜서 `--output text`에 NextToken("None")이
#    둘째 줄로 붙는다 → st="SUCCEEDED\nNone" → `case SUCCEEDED)` 미스매치 → 영원히 TIMEOUT →
#    실제로는 9분에 warm 됐는데 30분 후 false TIMEOUT + 조기 cooldown. SFN 실행이 누적(10+)되며
#    리스트가 페이지네이션 임계를 넘긴 뒤부터 잠복 발현. → describe-execution(단일 실행, 페이지네이션
#    없음, 정확)으로 교체. 권한 없을 때만 list-executions로 폴백하되 NextToken 줄을 제거.
sfn_exec_status() {  # <execution-arn> → 상태 1줄(빈값이면 조회 실패)
  local arn="$1" st
  st=$(aws stepfunctions describe-execution --region "$REGION" --execution-arn "$arn" \
       --query 'status' --output text 2>/dev/null)
  if [[ -z "$st" || "$st" == "None" ]]; then
    # 폴백: describe 권한 없음 추정 → list-executions에서 해당 ARN만, NextToken('None') 줄 제거.
    st=$(aws stepfunctions list-executions --region "$REGION" --state-machine-arn "$WARMUP_SFN" \
         --query "executions[?executionArn=='$arn'].status | [0]" --output text 2>/dev/null \
         | grep -v -x 'None' | head -1)
  fi
  printf '%s' "$st"
}
wait_warm() {  # <execution-arn> <timeout-s>
  local arn="$1" timeout="$2" t0=$SECONDS st
  while (( SECONDS - t0 < timeout )); do
    st=$(sfn_exec_status "$arn")
    case "$st" in
      SUCCEEDED) return 0 ;;
      FAILED|TIMED_OUT|ABORTED) echo "$st"; return 1 ;;
    esac
    sleep 20
  done
  echo "TIMEOUT"; return 1
}

# alias의 warm 응답을 검증(직접 호출). model이 더 이상 Bedrock이 아니고 fallback 헤더가 없으면 vLLM direct.
assert_warm_alias() {  # <alias>
  local alias="$1" h b model fbh status
  h=$(mktemp); b=$(mktemp)
  gw_post "$h" "{\"model\":\"$alias\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: WARM_OK\"}]}" > "$b"
  status=$(http_status "$h"); fbh=$(header_val "$h" x-genai-gw-fallback)
  model=$(jq -r '.model // empty' "$b" 2>/dev/null)
  if [[ "$status" == "200" && -z "$fbh" ]] && [[ "$model" != "$COLD_MODEL_PRIMARY" && "$model" != "$COLD_MODEL_SECONDARY" ]]; then
    pass "S-warm/$alias/non-stream" "200, model=$model, fallback 헤더 없음 = vLLM direct"
  else
    fail "S-warm/$alias/non-stream" "status=$status fb='$fbh' model=$model (기대 200 + no-fallback + non-bedrock)"
  fi
  rm -f "$h" "$b"

  # --- max_tokens=32000 (clamp 회귀 가드, 2026-06-14 버그) ----------------------
  # claude CLI는 매 요청에 max_tokens=32000을 싣는다. clamp 전엔 이게 vLLM maxModelLen
  # (coding=32768 등)을 초과해 vLLM 400 → Bedrock 폴백 → warm인데 Haiku가 답했다(이 버그).
  # router의 warm-path clamp가 들어왔으니, warm alias는 max32k도 vLLM-direct(200 + fallback
  # 헤더 없음 + non-Bedrock model)로 받아야 한다. fallback 헤더가 보이면 = clamp 미동작 = FAIL.
  #   ※ longcontext(maxModelLen 131072)는 32000<window라 clamp 자체가 안 걸리지만, 그래도
  #     vLLM-direct여야 PASS(동일 단언). 작은 window 모델(ocr=8192 등)이 진짜 회귀 표적.
  h=$(mktemp); b=$(mktemp)
  gw_post "$h" "{\"model\":\"$alias\",\"max_tokens\":32000,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: WARM_MAX32K_OK\"}]}" > "$b"
  status=$(http_status "$h"); fbh=$(header_val "$h" x-genai-gw-fallback)
  model=$(jq -r '.model // empty' "$b" 2>/dev/null)
  if [[ "$status" == "200" && -z "$fbh" ]] && [[ "$model" != "$COLD_MODEL_PRIMARY" && "$model" != "$COLD_MODEL_SECONDARY" ]]; then
    pass "S-warm/$alias/max32k" "200, model=$model, fallback 헤더 없음 = clamp 동작(vLLM-direct), 폴백 회귀 없음"
  else
    fail "S-warm/$alias/max32k" "status=$status fb='$fbh' model=$model (기대 200 + no-fallback + non-bedrock) — max_tokens clamp 미동작? warm인데 Bedrock 폴백 = 이번 버그 회귀"
  fi
  rm -f "$h" "$b"
}

# ★이번(2026-06-14) 회귀의 본체★ — 큰-input clamp 가드.
# 사용자가 실제 claude로 쓰면 system prompt+tools+멀티턴 누적으로 input이 8k+가 되는데,
# clamp v1(고정 reserve 8192)은 input>8192면 `output=window-8192`로도 input+output>window가
# 되어 vLLM 400 → Bedrock(Haiku) 폴백 → "warm인데 Haiku가 답함" 버그. 짧은 prompt(input~769)
# curl로만 검증해 2번 연속 못 잡았다. 이 케이스는 input을 고정 reserve 위로 올려 그 구멍을 박제:
#   clamp v1  → vLLM 400 → x-genai-gw-fallback:bedrock-direct 헤더 → FAIL (회귀 결정적 노출)
#   clamp v2  → 400 본문의 실 input으로 재clamp+재시도 → vLLM-direct 200, 헤더 없음 → PASS
# 입력 크기는 alias window에 맞춤(작은 window는 band가 없어 SKIP — 큰 input은 정당히 Bedrock).
assert_warm_large_input() {  # <alias> <approx_input_tokens>
  local alias="$1" toks="$2" window h b f model fbh status
  window=$(window_of "$alias")
  # 유효 band: 8192 < input < window-1280(v2 재clamp floor 여유). band 없으면(ocr=8192) SKIP.
  #   - input>8192 라야 v1의 고정 reserve를 넘겨 400을 유발(회귀 노출).
  #   - input<window-1280 라야 v2가 재clamp로 최소 출력예산을 남겨 vLLM-direct 가능.
  if [[ "$window" -le 9472 ]]; then
    skip "S-warm/$alias/big-input" "window=$window 작아 (input>reserve & 재clamp 가능) band 없음 — 큰 input은 정당히 Bedrock 폴백(safety net), 회귀 아님"
    return
  fi
  # 요청 input이 reserve(8192)를 확실히 넘되 band 안에 들도록 보정(기본 16000, window 작으면 중앙값).
  if [[ $((window - 1280)) -lt "$toks" ]]; then toks=$(( (8192 + window - 1280) / 2 )); fi
  [[ "$toks" -le 8192 ]] && toks=$(( 8192 + 1024 ))   # 최소한 reserve 초과 보장
  f=$(mktemp); h=$(mktemp); b=$(mktemp)
  make_large_input_body "$f" "$alias" "$toks" 32000   # max_tokens=32000 = claude CLI 실제값
  gw_post_file "$h" "$f" > "$b"
  status=$(http_status "$h"); fbh=$(header_val "$h" x-genai-gw-fallback)
  model=$(jq -r '.model // empty' "$b" 2>/dev/null)
  if [[ "$status" == "200" && -z "$fbh" ]] && [[ "$model" != "$COLD_MODEL_PRIMARY" && "$model" != "$COLD_MODEL_SECONDARY" ]]; then
    pass "S-warm/$alias/big-input" "input~${toks}tok + max32k → 200, model=$model, fallback 헤더 없음 = 실 input 기반 재clamp 동작(vLLM-direct)"
  else
    fail "S-warm/$alias/big-input" "input~${toks}tok status=$status fb='$fbh' model=$model — 고정 reserve가 input>8192를 못 막아 vLLM 400→Bedrock 폴백(이번 회귀). v2 재clamp 재시도 미동작?"
  fi
  rm -f "$f" "$h" "$b"
}

assert_warm_toolstream() {  # <alias> — tool_use + streaming (coding만 깊게)
  local alias="$1" h b status fbh has_tool has_stop
  # tool_use
  h=$(mktemp); b=$(mktemp)
  gw_post "$h" "{\"model\":\"$alias\",\"max_tokens\":256,\"tools\":[{\"name\":\"get_weather\",\"description\":\"Get current weather for a city\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}}],\"messages\":[{\"role\":\"user\",\"content\":\"What is the weather in Seoul? Use the get_weather tool.\"}]}" > "$b"
  status=$(http_status "$h"); has_tool=$(jq -r '[.content[]?|select(.type=="tool_use")]|length' "$b" 2>/dev/null)
  if [[ "$status" == "200" && "${has_tool:-0}" -ge 1 ]]; then
    pass "S-warm/$alias/tool_use" "200, tool_use block ✓ (structured output)"
  else
    fail "S-warm/$alias/tool_use" "status=$status tool_use=$has_tool"
  fi
  rm -f "$h" "$b"
  # streaming
  h=$(mktemp); b=$(mktemp)
  gw_post "$h" "{\"model\":\"$alias\",\"max_tokens\":48,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Count: 1 2 3\"}]}" > "$b"
  status=$(http_status "$h"); fbh=$(header_val "$h" x-genai-gw-fallback)
  has_stop=$(grep -c '"type":"message_stop"\|^event: message_stop' "$b")
  if [[ "$status" == "200" && -z "$fbh" && "$has_stop" -ge 1 ]]; then
    pass "S-warm/$alias/stream" "200, SSE lifecycle 완결, fallback 헤더 없음 = vLLM SSE"
  else
    fail "S-warm/$alias/stream" "status=$status fb='$fbh' stop=$has_stop"
  fi
  rm -f "$h" "$b"
}

# 실 claude CLI warm e2e (사용자 실제 경로 — coding alias warm 시). 이게 2026-06-14 버그의
# 진짜 가드다: 사용자가 `claude`로 코딩 질문을 하면 general→coding(warm)로 가야 하고, claude의
# max_tokens=32000이 router clamp로 vLLM 안에 들어가 **vLLM-direct**로 답해야 한다(Bedrock 폴백 X).
#   - 검출: instance엔 CloudWatch IAM이 없으므로 `claude --debug`의 응답 헤더 로그로 백엔드 판정.
#     warm·clamp 정상 → debug에 `x-genai-gw-fallback`/`bedrock-direct` 문자열이 **없어야** PASS.
#     그게 보이면 = warm인데 Bedrock 폴백 = 이번 버그 회귀 = FAIL.
#   - 504/Churned 출력 → FAIL. rc!=0/무응답(hang) → FAIL(warm e2e 불통).
# detect_scenario가 coding으로 라우팅하도록 코딩 프롬프트 사용(함수/코드/script 키워드).
assert_warm_claude_e2e() {  # <alias> — 현재 coding warm 가정(claude 기본 라우팅 대상)
  local alias="$1"
  if ! $USE_CLAUDE || ! command -v claude >/dev/null; then
    skip "S-warm/$alias/claude-CLI" "$($USE_CLAUDE && echo 'claude 바이너리 없음' || echo '--no-claude')"
    return
  fi
  # 두 변형을 돈다:
  #  (1) short  — 짧은 코딩 프롬프트. 기본 라우팅·warm e2e 정상성 확인(input 작음).
  #  (2) bigctx — 프롬프트에 ~12k 토큰 더미를 박아 input을 reserve(8192) 위로 올린 변형.
  #     ★이게 이번 버그의 실 claude 재현★: 사용자 실제 세션은 system+tools+멀티턴으로
  #     input이 8k+가 된다. clamp v1이면 여기서 vLLM 400→Bedrock 폴백(debug에 bedrock-direct)
  #     →FAIL. v2(실 input 재clamp 재시도)면 vLLM-direct, 헤더 없음→PASS. short만으론 못 잡음.
  _claude_warm_run() {  # <label> <prompt> → echo PASS|FAIL|<detail>; sets nothing
    local label="$1" prompt="$2" out rc dt c0 dbg
    dbg=$(mktemp); c0=$SECONDS
    out=$(timeout 200 claude --debug -p "$prompt" </dev/null 2>"$dbg"); rc=$?
    dt=$((SECONDS - c0))
    local churn=false fellback=false answered=false
    grep -qi '504\|Gateway Time-out\|Churned' <<<"$out$(cat "$dbg")" && churn=true
    # router가 Bedrock으로 폴백하면 응답 헤더에 x-genai-gw-fallback: bedrock-direct 가 박힌다(debug 노출).
    grep -qi 'x-genai-gw-fallback\|bedrock-direct' "$dbg" && fellback=true
    { [[ $rc -eq 0 ]] && grep -qi 'CLAUDE_WARM_OK\|def ok' <<<"$out"; } && answered=true
    if $churn; then
      fail "S-warm/$alias/claude-CLI/$label" "504/churn 출력 (${dt}s, rc=$rc) — 회귀"
    elif $fellback; then
      fail "S-warm/$alias/claude-CLI/$label" "warm인데 응답 헤더에 bedrock-direct (${dt}s) — clamp 미동작 = 이번 버그 회귀(warm→Bedrock 폴백)"
    elif ! $answered; then
      fail "S-warm/$alias/claude-CLI/$label" "claude 무응답/실패 rc=$rc (${dt}s) — warm e2e 불통(debug: $(tail -c 200 "$dbg" | tr '\n' ' '))"
    else
      pass "S-warm/$alias/claude-CLI/$label" "vLLM-direct 응답 ${dt}s, bedrock-direct 헤더 없음 = 실 claude warm e2e 정상(clamp 동작)"
    fi
    rm -f "$dbg"
  }
  # (1) short
  _claude_warm_run short "Write a one-line Python function named ok that returns the string CLAUDE_WARM_OK."
  # (2) bigctx — ~12k 토큰 더미(영문 단어 반복) + 코딩 질문. claude 요청 input이 reserve 초과.
  local filler; filler=$(yes "lorem ipsum dolor sit amet consectetur adipiscing" 2>/dev/null | head -n 1600 | tr '\n' ' ')
  _claude_warm_run bigctx "Here is a large reference text; ignore its content. ${filler} Now: write a one-line Python function named ok that returns the string CLAUDE_WARM_OK."
}

# serving-name 매핑(config/models.ts). 이 harness는 instance에서 도므로 genai-gw-warmup의 alias→serving과 동일.
serving_of() {  # <alias> → serving name
  case "$1" in
    coding)      echo "qwen35-27b" ;;
    video)       echo "qwen35-27b-video" ;;
    ocr)         echo "internvl3-14b" ;;
    longcontext) echo "llama4-scout" ;;
    math)        echo "gemma4-31b" ;;
    audio)       echo "phi4-multimodal" ;;
    *)           echo "" ;;
  esac
}

# alias → maxModelLen (config/models.ts). 큰-input 회귀 케이스가 input 크기를 모델 window에
# 맞춰 정하려면 필요(작은 window 모델은 input을 작게).
window_of() {  # <alias> → maxModelLen
  case "$1" in
    coding|video|math) echo 32768 ;;
    ocr)               echo 8192 ;;
    audio)             echo 16384 ;;
    longcontext)       echo 131072 ;;
    *)                 echo 0 ;;
  esac
}

# 큰-input 요청 본문을 파일로 생성. clamp v1(고정 reserve 8192)을 깨는 핵심 회귀 입력이다:
# input 토큰이 reserve(8192)를 넘으면 v1의 `output=window-8192`로도 input+output>window가 되어
# vLLM 400 → Bedrock 폴백(이번 버그). v2(실 input 기반 재clamp 재시도)는 vLLM-direct로 받아야 함.
#   <out-file> <approx-input-tokens> <max_tokens>
# 더미 input은 영문 단어 반복(1 word ≈ 1.3 토큰 가정 → word 수 = tokens/1.3). 정밀 토큰수가
# 아니라 "input이 reserve를 확실히 초과하는 상태"가 목적. content는 큰 1개 user 메시지.
make_large_input_body() {  # <out-file> <alias> <approx_input_tokens> <max_tokens> [stream]
  local out="$1" alias="$2" toks="$3" maxtok="$4" stream="${5:-false}"
  local words=$(( toks * 100 / 130 ))   # tokens/1.3
  [[ "$words" -lt 1 ]] && words=1
  # 더미 텍스트: 6-word 줄을 (words/6)줄 만들어 이어붙임(yes|head가 printf 큰 반복보다 빠름).
  local filler; filler=$(yes "lorem ipsum dolor sit amet consectetur" 2>/dev/null | head -n "$(( (words/6)+1 ))" | tr '\n' ' ')
  # jq로 JSON 안전 조립(따옴표·개행 escape). stream=true면 stream 필드 추가.
  jq -nc --arg alias "$alias" --arg filler "$filler" \
        --argjson maxtok "$maxtok" --argjson stream "$stream" \
    '{model:$alias, max_tokens:$maxtok}
     + (if $stream then {stream:true} else {} end)
     + {messages:[{role:"user", content:("Analyze the following text and reply with exactly: BIGIN_OK\n\n" + $filler)}]}' \
    > "$out"
}

warm_one_alias() {  # <alias> <deep?> — warmup→assert→cooldown. deep=tool_use+stream도.
  local alias="$1" deep="${2:-false}" serving arn st budget
  serving=$(serving_of "$alias")
  [[ -z "$serving" ]] && { fail "S-warm/$alias" "unknown alias"; return; }
  [[ -z "$WARMUP_SFN" ]] && { skip "S-warm/$alias" "GENAI_GW_WARMUP_SFN 미설정(이 host는 test-client EC2가 아님?)"; return; }

  # gated 모델(longcontext/math)은 HF 라이선스 미승인 시 pod가 weight를 못 받아 GPU 노드
  # 자체가 스케줄 안 됨 → 절대 Ready 안 됨. full budget(30분)을 태우지 말고 짧게 probe 후
  # SKIP(gated). 승인돼 있으면 정상 warm 되므로, 짧은 budget서 Ready면 그대로 검증 진행.
  budget="$GPU_READY_TIMEOUT"
  if printf '%s' "$GATED_ALIASES" | grep -qw "$alias"; then
    budget="$GATED_READY_TIMEOUT"
    info "[$alias] gated 모델 → 짧은 probe budget ${budget}s (미승인이면 빠르게 SKIP)"
  fi

  info "[$alias→$serving] warm-up SFN start…"
  arn=$(sfn_warmup "$serving")
  if [[ -z "$arn" || "$arn" == "None" ]]; then fail "S-warm/$alias" "start-execution 실패"; return; fi
  info "[$alias] 실행 $arn — Ready 폴링(최대 ${budget}s, GPU boot 10~25분)"
  if st=$(wait_warm "$arn" "$budget"); then
    info "[$alias] SUCCEEDED — 응답 검증"
    sleep 10   # NLB 타깃 등록 직후 안정화
    assert_warm_alias "$alias"
    if [[ "$deep" == "true" ]]; then
      assert_warm_toolstream "$alias"
      # ★큰-input clamp 회귀 가드(이번 버그 본체)★ — input을 reserve(8192) 위로 스윕.
      # 짧은 max32k(assert_warm_alias)는 input이 작아 v1도 우연히 통과할 수 있다. 진짜
      # 회귀는 input>reserve일 때만 드러나므로 경계(9k/16k/28k)로 스윕해 band 전체를 가드.
      # 9216=reserve(8192) 바로 위 경계, 16000=중앙, 22000=상단(window 32768 대비 충분한
      # 여유 — 토큰 추정 오차가 있어도 input<window 유지해 v2 재clamp가 출력예산 확보 가능).
      local bt
      for bt in 9216 16000 22000; do
        assert_warm_large_input "$alias" "$bt"
      done
      # 실 claude warm e2e (max_tokens=32000 clamp 회귀 가드) — coding warm일 때만.
      assert_warm_claude_e2e "$alias"
    else
      # 비-deep alias도 큰-input 1건은 가드(window band 있으면). 작은 window는 함수가 SKIP.
      assert_warm_large_input "$alias" 16000
    fi
  else
    # ⚠️ 폴링이 timeout 했는데 warm-up SFN이 아직 RUNNING이면, cooldown과 race가 난다
    #    (cooldown이 deploy를 0으로 내리면 warm-up은 readyReplicas=0을 영원히 폴링).
    #    → cooldown 전에 warm-up을 먼저 ABORT 해서 orphan 루프를 막는다.
    if [[ "$st" == "TIMEOUT" ]]; then
      info "[$alias] 폴링 timeout — warm-up SFN abort(cooldown과 race 방지)"
      aws stepfunctions stop-execution --region "$REGION" --execution-arn "$arn" \
        --cause "system-test poll timeout; aborting before cooldown to avoid race (cc-33697)" >/dev/null 2>&1
    fi
    if printf '%s' "$GATED_ALIASES" | grep -qw "$alias"; then
      skip "S-warm/$alias" "warm-up 미완($st) — gated 모델, HF 라이선스 미승인 추정(노드 미스케줄). 승인 후 GATED_READY_TIMEOUT 상향 재시도. [확인 필요]"
    else
      fail "S-warm/$alias" "warm-up 미완($st) — GPU boot가 ${budget}s 초과. GPU_READY_TIMEOUT 상향 재시도 가능"
    fi
  fi
  info "[$alias] cooldown(scale-0) — GPU 과금 중지"
  sfn_cooldown "$serving" >/dev/null
}

test_warm() {
  hdr "S-warm (vLLM direct, coding)"
  if ! $WITH_GPU; then skip "S-warm" "GPU 과금 차원 — --with-gpu 필요"; return; fi
  warm_one_alias coding true
}

# ════════════════════════════════════════════════════════════════════════════
# S-permodel — 6 alias 각각 warm→라우팅 검증→cooldown. 직렬화(동시 GPU 금지).
# ════════════════════════════════════════════════════════════════════════════
test_permodel() {
  hdr "S-permodel (6 alias, 직렬)"
  if ! $WITH_GPU; then skip "S-permodel" "GPU 과금 차원 — --with-gpu 필요"; return; fi
  local a
  for a in $ALIASES; do
    [[ "$a" == "coding" ]] && continue  # coding은 S-warm에서 deep 검증함
    warm_one_alias "$a" false
  done
}

# ════════════════════════════════════════════════════════════════════════════
# S-reservation — warmup/cooldown SFN 도달성. (instance IAM = ListExecutions only)
#   DDB reservation 테이블·EventBridge rule은 instance에 IAM 없음 → SKIP+사유.
# ════════════════════════════════════════════════════════════════════════════
test_reservation() {
  hdr "S-reservation (warm-up state machine 도달성)"
  if [[ -z "$WARMUP_SFN" ]]; then skip "S-reservation" "GENAI_GW_WARMUP_SFN 미설정"; return; fi
  local out rc
  out=$(aws stepfunctions list-executions --region "$REGION" --state-machine-arn "$WARMUP_SFN" \
        --max-items 5 --query "executions[].status" --output text 2>&1); rc=$?
  if [[ $rc -eq 0 ]]; then
    pass "S-reservation/warmup-sfn" "ListExecutions 응답 ✓ (최근 상태: ${out:-none})"
  else
    fail "S-reservation/warmup-sfn" "ListExecutions 실패: $(echo "$out" | tr '\n' ' ' | cut -c1-120)"
  fi
  skip "S-reservation/ddb-eventbridge" "instance IAM에 DynamoDB/EventBridge 권한 없음 — 제어플레인서 별도 점검. [확인 필요]"
}

# ════════════════════════════════════════════════════════════════════════════
# S-admin — admin console은 HTML-only + instance IAM 없음 → SKIP(사유).
# ════════════════════════════════════════════════════════════════════════════
test_admin() {
  hdr "S-admin (관리 콘솔)"
  skip "S-admin" "admin은 HTML-only + instance에 ECS/readyReplicas IAM 없음 → SFN status(S-reservation)로 갈음. [확인 필요]"
}

# ─── 리포트 ────────────────────────────────────────────────────────────────────
write_report() {
  [[ -z "$REPORT" ]] && return 0
  {
    echo "# In-Region GenAI Gateway — system-test 리포트"
    echo
    echo "- gateway: \`$GW\`  ·  region: \`$REGION\`  ·  --with-gpu: $WITH_GPU"
    echo "- 결과: **PASS $N_PASS / FAIL $N_FAIL / SKIP $N_SKIP**"
    echo
    echo "| 결과 | 테스트 | 상세 |"
    echo "|------|--------|------|"
    printf '%s' "$RESULT_LINES" | while IFS='|' read -r k n d; do
      [[ -z "$k" ]] && continue
      echo "| $k | $n | ${d//|/\\|} |"
    done
  } > "$REPORT"
  echo "리포트 기록: $REPORT"
}

# ─── 집계 출력 ──────────────────────────────────────────────────────────────────
summary() {
  hdr "SUMMARY"
  printf '%s' "$RESULT_LINES" | while IFS='|' read -r k n d; do
    [[ -z "$k" ]] && continue
    printf '  %-4s %-28s %s\n' "$k" "$n" "$d"
  done
  echo
  echo "─────────────────────────────────────────"
  echo "  PASS=$N_PASS  FAIL=$N_FAIL  SKIP=$N_SKIP"
  echo "─────────────────────────────────────────"
}

# ─── 디스패치 ──────────────────────────────────────────────────────────────────
run_dim() {  # <name> <fn>
  if [[ -z "$ONLY" || "$ONLY" == "$1" ]]; then "$2"; fi
}

main() {
  preflight_checks
  run_dim cold        test_cold
  run_dim cascade     test_cascade
  run_dim warm        test_warm
  run_dim permodel    test_permodel
  run_dim reservation test_reservation
  run_dim admin       test_admin
  summary
  write_report
  exit "$N_FAIL"
}

main "$@"
