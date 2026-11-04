#!/usr/bin/env bash
# finalize-deploy.sh — `cdk deploy --all` 이후 한 줄로 게이트웨이를 완성한다.
#
# CDK 가 인프라를 세운 뒤 남는 후처리(NLB DNS 조회 → SmartRouter 재배선 → Higress
# provider/route/consumer 적용 + console 부트스트랩)를 이 스크립트가 전부 흡수한다.
# k8s 가 post-deploy 로 띄우는 NLB 의 DNS 는 배포 시점에 알 수 없어 CDK 토큰으로 못
# 박으므로, 이렇게 2-command 흐름(`cdk deploy --all` → `finalize-deploy.sh`)이 된다.
#
#   [1/3] get-endpoints.sh --write-context
#         - vLLM 6개 + Higress gateway NLB DNS 조회 → cdk.json context 기입
#   [2/3] cdk deploy GenAiGwSmartRouterStack --exclusively -c higressEndpoint=<조회값>
#         - SmartRouter upstream 을 Higress gateway NLB 로 재배선
#   [3/3] apply-higress.sh
#         - console 세션 확보(첫 배포면 /system/init 자동) → consumer/provider/route 적용
#
# 사용법:
#   AWS_PROFILE=<p> CDK_DEFAULT_ACCOUNT=<acct> AWS_REGION=ap-northeast-2 \
#     ./scripts/finalize-deploy.sh
#
# 전제:
#   - `cdk deploy --all` 이 이미 성공(16+ 스택 CREATE/UPDATE_COMPLETE)
#   - kubectl 이 해당 EKS 클러스터 컨텍스트로 설정됨 (NLB 조회 + console port-forward)
#   - AWS 자격(Secrets Manager 읽기 + CloudFormation 배포 권한), jq / python3 / npx ts-node
#
# 멱등: 재실행 안전. NLB DNS 재조회 → SmartRouter no-op(이미 같은 upstream) → Higress
#       upsert(이미 적용된 route 는 PUT). console 이 이미 init 됐으면 그 자격으로 로그인.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CDK_JSON="$REPO_DIR/cdk.json"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
MASTER_KEY_SECRET="/genai-gw/higress/master-key"
GATEWAY_ENTRY="https://gateway.genai-gw.internal"

step() { echo ""; echo "═══ $* ═══"; }
die()  { echo "✗ $*" >&2; exit 1; }

command -v kubectl >/dev/null 2>&1 || die "kubectl 미설치 (NLB 조회·console 접근에 필요)"
command -v jq      >/dev/null 2>&1 || die "jq 미설치"
command -v python3 >/dev/null 2>&1 || die "python3 미설치"

# ── [1/3] NLB DNS 조회 → cdk.json context ──────────────────────────────────────
step "[1/3] NLB DNS 조회 → cdk.json (vllmEndpoints + higressEndpoint)"
"$SCRIPT_DIR/get-endpoints.sh" --write-context \
  || die "get-endpoints.sh 실패 — vLLM NLB Service Ready 여부 확인 (kubectl get svc -n vllm)"

# 방금 기입된 higressEndpoint 를 cdk.json 에서 읽어 SmartRouter 배포에 명시 전달.
HIGRESS_ENDPOINT=$(python3 -c "
import json,sys
try:
    print(json.load(open('$CDK_JSON')).get('context',{}).get('higressEndpoint','').strip())
except Exception as e:
    sys.stderr.write('cdk.json 읽기 실패: %s\n'%e); sys.exit(1)
")
[[ -n "$HIGRESS_ENDPOINT" ]] \
  || die "higressEndpoint 미조회 — Higress gateway NLB(higress-system/higress-gateway-nlb) Ready 여부 확인"
echo "  higressEndpoint = $HIGRESS_ENDPOINT"

# ── [2/3] SmartRouter 재배선 ───────────────────────────────────────────────────
step "[2/3] SmartRouter upstream → Higress gateway NLB 재배선"
( cd "$REPO_DIR" && npx cdk deploy GenAiGwSmartRouterStack --exclusively \
    -c higressEndpoint="$HIGRESS_ENDPOINT" --require-approval never ) \
  || die "GenAiGwSmartRouterStack 배포 실패 — AWS 자격/계정/리전 확인 (AWS_PROFILE, CDK_DEFAULT_ACCOUNT)"

# ── [3/3] Higress 구성 적용 (console init 자동 흡수) ────────────────────────────
step "[3/3] Higress provider/route/consumer 적용 (+ console 첫-배포 부트스트랩)"
"$SCRIPT_DIR/apply-higress.sh" \
  || die "apply-higress.sh 실패 — console 접근(kubectl port-forward) / Secrets Manager 권한 확인"

# ── 완료 배너 ──────────────────────────────────────────────────────────────────
cat <<BANNER

══════════════════════════════════════════════════════════════════════
  ✓ In-Region GenAI Gateway 배포 완료
══════════════════════════════════════════════════════════════════════
  진입점 (ANTHROPIC_BASE_URL):
    $GATEWAY_ENTRY
  인증 (ANTHROPIC_API_KEY / x-api-key) — gateway master-key 조회:
    aws secretsmanager get-secret-value --secret-id $MASTER_KEY_SECRET \\
      --region $REGION --query SecretString --output text | jq -r .key

  체험 — VPC 안 테스트 클라이언트(EC2 + Claude Code, 기본 포함, SSM 접속):
    INSTANCE_ID=\$(aws cloudformation describe-stacks --stack-name GenAiGwTestClientStack \\
      --region $REGION --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" \\
      --output text)
    aws ssm start-session --target \$INSTANCE_ID --region $REGION
    → warm 전: SmartRouter 가 in-region Bedrock 으로 fallback
    → genai-gw-warmup coding 후: 같은 요청이 vLLM(Qwen3.5)로 직접
    (테스트 클라이언트 제외 배포: cdk deploy --all -c deployTestClient=false)

  정리 — 전체 스택 삭제(데모 종료 시):
    cdk destroy --all --force
══════════════════════════════════════════════════════════════════════
BANNER
