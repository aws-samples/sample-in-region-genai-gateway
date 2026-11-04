# In-Region GenAI Gateway

> 🌏 **English**: see [README.en.md](README.en.md). 본 문서(한국어)가 정본입니다.

규제나 사내 보안 정책 때문에 **"모든 AI 추론을 서울 리전 안에서만"** 처리해야 하는 조직이 있습니다. 문제는, 이 조건을 지키면서 당장 쓸 수 있는 고성능 AI가 사실상 **최신 최고 성능(frontier) 모델의 37% 수준** 하나로 좁혀진다는 점입니다. 이 샘플은 그 한계를 **82% 수준까지** 끌어올리면서도, 데이터는 **100% 서울 리전 안에** 남깁니다.

**이 솔루션이 없으면** — 다음 세 가지 중 하나를 골라야 하는 딜레마에 빠집니다.

- 규제를 지키려 **서울 리전 안의 모델만** 쓰면 → 코딩 성능의 **60% 이상을 포기**합니다.
- 성능을 위해 **해외 리전 모델**을 쓰면 → **데이터 국외 반출 리스크**를 집니다.
- 성능·규제를 모두 잡으려 **자체 GPU를 24시간** 돌리면 → **비용이 감당하기 어렵게** 커집니다.

**이 솔루션을 쓰면** — 연구원은 평소 쓰던 **Claude Code CLI를 그대로** 씁니다(재교육 불필요). 게이트웨이가 요청을 **서울 리전 안의 가장 적합한 백엔드로 자동 라우팅**합니다. 결과적으로 쓸 수 있는 AI 성능이 frontier의 **37% → 82% 수준**으로 올라가고, 데이터는 **한 번도 한국을 벗어나지 않습니다**.

**추가로 얻는 것**

- **안 쓸 땐 비용 거의 0** — 아무 요청이 없으면 GPU가 0으로 줄어듭니다(scale-to-zero).
- **알아서 예열** — 업무 시간에 맞춰 모델을 미리 띄워 두는 예약(warmup) 기능.
- **끊김 없는 폴백** — self-host 모델이 아직 안 떠 있으면 자동으로 Bedrock(서울)으로 넘겨 응답이 끊기지 않습니다.

---

모든 추론이 한국(Seoul) 리전에서만 발생하도록 강제하는 region-locked LLM Gateway 샘플입니다. 연구원이 **Claude Code CLI**를 그대로 사용하면서, 내부적으로는 Bedrock(Claude Sonnet/Haiku) 또는 EKS 위의 6종 오픈소스 vLLM 모델로 라우팅됩니다.

> **In-region 요건이란?** 규제·계약·사내 보안 정책 때문에 데이터와 그 접근 권한이 특정 리전(여기서는 서울) 밖으로 나가면 안 되는 경우를 말합니다. 이 샘플은 그 요건을 AWS Seoul 리전 단일 운영으로 지원하는 아키텍처를 보여줍니다.

> **Disclaimer — 프로덕션 용도 아님.** 본 저장소는 교육·데모 목적의 샘플 코드이며 **프로덕션 사용을 위한 것이 아닙니다**. 어떠한 보증도 없이 "있는 그대로(as is)" 제공됩니다. 배포 전 반드시 자체 보안·컴플라이언스·운영 요건에 맞춰 검토·강화·테스트하십시오. In-region 데이터 통제 관련 기술은 이 아키텍처가 보여주는 *지원 컨트롤(supporting controls)*을 설명한 것으로, 규제 준수에 대한 인증이나 법적 보증이 아닙니다.

---

## TL;DR

**누가** — 데이터 주권 요건 때문에 모든 추론을 서울 리전 안에 묶어야 하는 제조·공공·금융 등의 고객.
**무엇** — 연구원은 **Claude Code CLI를 그대로** 쓰고, gateway가 내부적으로 서울 in-region Bedrock 또는 self-host open-source vLLM(EKS)으로 라우팅합니다. 트래픽이 리전을 벗어나지 않습니다.
**왜** — 서울 in-region 매니지드 모델만 쓰면 frontier의 ~37% 수준에 갇히지만, 이 repo의 self-host `coding`(Qwen3.5-27B)은 frontier의 **~82%** 수준을 in-region으로 냅니다.

**어떻게 (배포 → 체험 → 정리):**

```bash
npm install

# [1] 인프라 — 전체 스택 배포 (~60-90분, EKS Auto Mode + 17 스택, 테스트 클라이언트 포함)
AWS_DEFAULT_REGION=ap-northeast-2 cdk deploy --all

# [2] 후처리 — NLB DNS 조회 → SmartRouter 재배선 → Higress 구성 적용
./scripts/finalize-deploy.sh

# [3] 체험 — VPC 안 테스트 클라이언트(EC2 + Claude Code)에 SSM 접속 (Name 태그로 조회)
aws ssm start-session --region ap-northeast-2 --target \
  "$(aws ec2 describe-instances --region ap-northeast-2 \
       --filters Name=tag:Name,Values=genai-gw-test-client Name=instance-state-name,Values=running \
       --query 'Reservations[0].Instances[0].InstanceId' --output text)"
bash -l                              # ★ gateway env 로드

# [4] 테스트 — cold 면 Bedrock(Seoul); `genai-gw-warmup coding` 후 같은 명령이 vLLM(Qwen3.5)로
claude "이 함수를 읽기 좋게 리팩터링해줘: ..."

# [5] 정리 — 데모 종료 시 전체 삭제
cdk destroy --all --force
```

> **배포 전 필수 준비**가 있습니다 — HuggingFace 토큰(필수)과, `longcontext`·`math`를 쓸 경우 gated 모델 라이선스 승인입니다. 먼저 **[Prerequisites](#prerequisites)** 를 확인하고 시작하십시오. 단계별 배포·체험·운영 옵션은 **[Deployment](#deployment)** 를 참고하십시오.

- **Region 고정**: `ap-northeast-2` (Seoul) — 코드상 하드코딩 (in-region 요건 지원)
- **스택 수**: 17개 (테스트 클라이언트 기본 포함; `-c deployTestClient=false`로 제외 시 16개)
- **서빙 중 모델**: 6종 vLLM (scale-to-zero) + 2종 Bedrock (ON_DEMAND, IN_REGION)
- **엔드포인트**: HTTPS 443, Route53 Private Hosted Zone (`*.genai-gw.internal`)

---

<details>
<summary><strong>왜 이 repo가 필요한가</strong> — 서울 in-region에 묶이면 frontier의 ~37%, 이 repo는 self-host로 ~82%까지 끌어올립니다 (펼쳐서 논증·벤치마크 보기)</summary>

### 왜 이 repo가 필요한가

**문제.** 데이터 주권 요건이 있는 제조·공공·금융 등의 고객은 데이터와 접근 권한이 리전 밖으로 나가면 안 됩니다. 그래서 LLM도 **서울(ap-northeast-2) 리전 안에서만** 돌려야 합니다. 그런데 서울 in-region으로 즉시 쓸 수 있는 frontier 사양의 매니지드 모델은 사실상 **Amazon Bedrock의 Claude 3.5 Sonnet** 하나뿐입니다 (cross-region inference를 쓰면 트래픽이 리전을 벗어나 in-region 요건에 어긋납니다).

**그 대가가 얼마인가.** Bedrock 서울에 in-region으로 잡히는 Claude 3.5 Sonnet(`2024-06-20`)은 agentic 코딩 기준 **SWE-bench Verified ≈ 33%** 입니다. 오늘의 frontier 상한(Claude Opus 4.8 ≈ 88.6%) 대비 **≈ 37% 수준**에 불과합니다. 즉 "규정을 지키려고 서울에 갇히는 순간, 코딩 능력의 60% 이상을 포기"하게 됩니다. (업데이트판 `2024-10-22`를 쓸 수 있어도 ≈ 49% = frontier의 ≈ 55%로, 갭은 여전히 큽니다.)

**이 repo의 해법 — frontier를 ~82%까지 끌어올리는 hedge.** 가중치가 공개된 open-source 모델을 서울 리전 EKS에 self-host하면, 트래픽이 리전을 벗어나지 않으면서도 훨씬 높은 성능을 낼 수 있습니다. 이 CDK가 기본 탑재한 `coding` 모델 **Qwen3.5-27B**는 **SWE-bench Verified ≈ 72.4% = frontier의 ≈ 82%** 입니다 (지식·수학 축은 90% 이상으로 더 근접). in-region Bedrock(≈37%)에서 **두 배 이상**으로 올라갑니다.

| 서울 in-region 선택지 | SWE-bench Verified | frontier(Opus 4.8=88.6) 대비 |
|----|----|----|
| Bedrock Claude 3.5 Sonnet (`2024-06-20`) — 매니지드 유일 옵션 | ≈ 33% | **≈ 37%** |
| Bedrock Claude 3.5 Sonnet (`2024-10-22`) | ≈ 49% | ≈ 55% |
| **이 CDK의 `coding` = Qwen3.5-27B (self-host)** | **≈ 72.4%** | **≈ 82%** |

**메시지.** *"in-region 요건 때문에 서울에 갇혀 frontier의 37%짜리 모델밖에 못 쓴다"* 는 통념을, 이 **2-command CDK 솔루션**(`cdk deploy --all` → `finalize-deploy.sh`)이 *"frontier 대비 80% 수준을 서울 in-region으로 유지하면서 in-region 요건을 AWS에서 지킨다"* 로 바꿉니다. frontier 100%는 아니지만 80% 수준이면 대부분의 실무를 커버하며, 무엇보다 **데이터 주권을 깨지 않습니다.**

> 수치 근거·해석 주의·더 높은 충실도(Qwen3.5-397B 등) 옵션은 아래 **Model Matrix**의 *성능은 얼마나 떨어지는가* 펼침 섹션을 참고하십시오. 벤치마크는 harness·설정에 따라 ±편차가 있으니 **도입 전 실제 워크로드로 PoC 실측**을 권장합니다.

</details>

---

## Architecture

![In-Region GenAI Gateway architecture](docs/architecture/architecture.png)

연구원 PC(내부망)에서 Direct Connect / Site-to-Site VPN으로 HTTPS 443 요청 →
Route 53 Private Hosted Zone(`*.genai-gw.internal`) → SmartRouter(ECS Fargate, prompt 분석·재작성, Anthropic Messages API 호환) →
Higress AI Gateway(EKS, Anthropic↔OpenAI 변환·key-auth, 6 vLLM + 2 Bedrock provider) →
**EKS Auto Mode**(vLLM × 6, scale-to-zero, Karpenter cpu/gpu/neuron, S3 Mountpoint CSI 모델 캐시) 또는
**Amazon Bedrock**(Seoul in-region fallback)으로 라우팅됩니다. vLLM alias가 cold면 SmartRouter가 pre-flight로 감지해 Bedrock으로 직접 fallback합니다(gateway 우회).
Reservation(EventBridge + Lambda + DynamoDB + Step Functions)이
평일 08:30–19:30 KST 스케줄로 vLLM warmup/cooldown을 제어합니다. 전 구간이 단일 리전(Seoul) 안에서 동작합니다.

> 편집 가능한 원본: [`docs/architecture/architecture.drawio`](docs/architecture/architecture.drawio) (draw.io)

### 라우팅 흐름 (2단계)

요청은 **두 단계**로 백엔드에 도달합니다. 흔히 오해하듯 *Higress가 내용을 보고 라우팅하는 게 아니라*, 그 앞단 **SmartRouter**가 내용 기반으로 alias를 정하고, **Higress는 그 alias 이름만 보고** 백엔드를 매칭합니다.

```mermaid
flowchart TD
    C["연구원 · Claude Code CLI<br/>model: general"]
    C -->|"HTTPS 443 · Anthropic Messages"| SR

    subgraph SR["① SmartRouter (ECS Fargate) — 내용 기반"]
        DET["detect_scenario()<br/>정규식 키워드 카운트<br/>(LLM·임베딩 미사용)<br/>매칭 0이면 default = coding"]
        CLAMP["max_tokens clamp<br/>(window 초과분 선제 축소)"]
        DET --> CLAMP
    end

    SR --> PF{"target alias vLLM<br/>/health pre-flight (~2s)"}
    PF -->|"cold (0 replica)"| BR
    PF -->|"warm"| HG

    subgraph HG["② Higress AI Gateway (EKS) — 이름 매칭"]
        EQ["model 이름 EQUAL 매칭 (내용 안 봄)<br/>alias → vLLM serving name 재작성"]
    end

    HG -->|"200"| VL["vLLM × 6 (EKS Auto Mode, scale-to-zero)<br/>coding·video=Qwen3.5-27B · ocr=InternVL3<br/>math=Gemma4 · longcontext=Llama4 · audio=Phi-4"]
    HG -->|"4xx/5xx<br/>(context overflow → max_tokens 반감 재시도)"| BR

    subgraph BR["Bedrock-direct fallback (boto3, gateway 우회)"]
        SN["Claude 3.5 Sonnet — primary (default, quality-first)"]
        HK["Claude 3 Haiku — secondary"]
        SN -->|"throttle 시에만 cascade"| HK
    end

    VL --> SEOUL(["전 구간 Seoul ap-northeast-2 내 — in-region 보존"])
    BR --> SEOUL
```

**① SmartRouter — 내용 기반 alias 결정 (LLM 안 씀).** `model:general` 요청이 오면 `detect_scenario()`가 prompt를 분석해 6개 alias 중 하나로 정합니다. 추론 LLM이나 임베딩 유사도가 아니라 **순수 정규식 키워드 카운트**입니다:
- 멀티모달은 즉답 — content에 `audio/*` 블록 → `audio`, `video/*` → `video`.
- 텍스트 60,000자 초과 → `longcontext`.
- 나머지는 `math`/`coding`/`ocr` 3개 정규식의 **매칭 단어 수**를 세어 최다 득점 alias 선택.
- **전부 0점이면 default = `coding`** (Qwen3.5-27B가 범용으로 가장 강하므로). → 일반/잡다한 질문은 모두 `coding`으로 갑니다.

이미 `model:coding`처럼 alias를 직접 지정하면 `detect_scenario`를 건너뛰고 그대로 통과합니다.

**② Higress — alias 이름만 매칭 (dumb router).** SmartRouter가 `model` 필드를 결정된 alias로 재작성해 보내면, Higress는 내용을 다시 보지 않고 `modelPredicates`의 **EQUAL(정확 일치)** 로 route를 고른 뒤, provider의 `modelMapping`으로 alias를 실제 vLLM serving 이름(예: `coding`→`qwen35-27b`)으로 한 번 더 바꿔 upstream에 전달합니다.

**Fallback은 Higress가 아니라 SmartRouter가 소유.** vLLM route에는 cross-provider fallback이 **의도적으로 없습니다**(Higress ai-proxy 2.0.0이 Bedrock `/v1/messages` SigV4를 오서명 — [higress#3809](https://github.com/alibaba/higress/issues/3809)). 대신 SmartRouter가 두 겹으로 처리합니다: (1) **pre-flight** — 대상 alias vLLM이 cold(0 replica)면 Higress를 건너뛰고 곧장 Bedrock-direct, (2) **reactive** — Higress가 4xx/5xx를 내면(예: context-window 초과 400 → `max_tokens`를 절반씩 줄여 재시도) 그래도 안 되면 Bedrock-direct. 어느 경로든 fallback 대상은 **scenario와 무관한 공통 in-region Bedrock**(default Sonnet→Haiku, `-c coldFallbackOrder`로 전환 가능)이지, math 전용·coding 전용 Bedrock이 따로 있는 게 아닙니다. 자세한 동작은 아래 [FAQ](#faq)를 참고하십시오.

---

## Deployment

### Prerequisites

- AWS CLI configured (`ap-northeast-2` credentials)
- Node.js >= 18, `npm install -g aws-cdk`
- CDK Bootstrap in `ap-northeast-2`
- **HuggingFace 토큰 (필수)** — 아래 1번 참고.
- **Gated 모델 라이선스 승인 (선택)** — `longcontext`·`math`를 배포할 때만. 아래 2번 참고.

#### 1. HuggingFace 토큰 발급 + Secrets Manager 등록 (필수)

vLLM pod가 모델 weight를 받을 때 HF 토큰을 씁니다. **없으면 vLLM pod가 기동에 실패하고(GPU 노드는 점유한 채 과금) `GenAiGwEksStack` 배포가 즉시 멈춥니다**(deploy-time sanity check가 `hf-token` 부재를 잡습니다).

1. [huggingface.co](https://huggingface.co/join) 가입/로그인.
2. **Settings → Access Tokens → New token** → Type **Read** 선택 → 생성된 `hf_...` 토큰 복사. (weight 다운로드 전용이므로 Read 권한이면 충분.)
3. 그 토큰을 Secrets Manager에 등록 (시크릿 안의 키 이름은 반드시 `token`):

   ```bash
   aws secretsmanager create-secret \
     --name hf-token \
     --secret-string '{"token":"hf_xxxxxxxx"}' \
     --region ap-northeast-2
   ```

#### 2. Gated 모델 라이선스 승인 (선택 — `longcontext`·`math`를 쓸 때만)

기본 6종 중 **2종이 gated** = HF에서 라이선스 동의가 선행돼야 다운로드됩니다. 승인 없이 배포하면 해당 vLLM pod가 **HF 401/403**으로 기동에 실패합니다.

| Alias | 모델 | 승인 절차 |
|-------|------|-----------|
| `longcontext` | [`meta-llama/Llama-4-Scout-17B-16E-Instruct`](https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct) | 모델카드에서 Meta 라이선스 동의 + access request 승인 |
| `math` | [`google/gemma-4-31b-it`](https://huggingface.co/google/gemma-4-31b-it) | 모델카드에서 Google Gemma 라이선스 동의 |

- **반드시 위에서 토큰을 발급한 동일 HF 계정으로** 각 모델카드의 "Agree and access"(access request)를 먼저 눌러 승인받으십시오.
- 나머지 4종(`coding`/`video`=Qwen3.5-27B[Apache-2.0], `ocr`=InternVL3-14B, `audio`=Phi-4 Multimodal)은 gated가 아니므로 추가 승인이 필요 없습니다.
- **두 모델을 안 쓸 거면** 해당 vLLM 스택(`GenAiGwVllm-Longcontext`·`GenAiGwVllm-Math`)을 배포에서 빼면 됩니다(아래 *단계별 배포*에서 제외, 또는 `cdk deploy`에서 해당 스택 생략). gated 승인 없이도 나머지 스택은 정상 배포됩니다.
- ⚠️ gated 여부·라이선스 조건은 모델카드 정책이라 바뀔 수 있습니다. **배포 시점에 각 모델카드에서 확인**하십시오.

### Deploy (2-command)

게이트웨이 데이터플레인의 핵심은 k8s가 **배포 후에** 띄우는 NLB(vLLM 6개 + Higress gateway)입니다. 그 DNS는 배포 시점에 알 수 없어 CDK 토큰으로 못 박으므로, **인프라 배포**와 **후처리 배선**을 두 명령으로 나눕니다:

```bash
npm install

# [1] 인프라 — 전체 스택 배포 (~60-90분, EKS Auto Mode + 17 스택, 테스트 클라이언트 포함)
AWS_DEFAULT_REGION=ap-northeast-2 cdk deploy --all

# [2] 후처리 — NLB DNS 조회 → SmartRouter 재배선 → Higress 구성 적용
./scripts/finalize-deploy.sh
```

`finalize-deploy.sh`가 다음을 한 번에 처리합니다(복붙 0회):

1. **NLB DNS 조회** — vLLM 6개 + Higress gateway NLB DNS를 `kubectl`로 조회해 `cdk.json` context(`vllmEndpoints`, `higressEndpoint`)에 기입합니다 (`scripts/get-endpoints.sh --write-context`).
2. **SmartRouter 재배선** — `cdk deploy GenAiGwSmartRouterStack -c higressEndpoint=<조회값>`으로 upstream을 Higress gateway NLB로 연결합니다.
3. **Higress 구성 적용** — provider/route/key-auth consumer를 console REST로 적용합니다 (`scripts/apply-higress.sh`). **첫 배포라 console admin이 없으면 `/system/init`로 자동 부트스트랩합니다**(admin PW = gateway master-key로 고정, 이후 Secrets Manager로 복구 가능).

완료되면 진입점(`https://gateway.genai-gw.internal`)·master-key 조회법·테스트 클라이언트 접속법을 배너로 출력합니다. 재실행은 멱등입니다(NLB 재조회 → SmartRouter no-op → Higress upsert).

### 체험 + 정리 (3~5)

배포에는 **VPC 안 테스트 클라이언트(EC2 1대)가 기본 포함**됩니다 — Claude Code가 미리 설치·연결된 채 부팅되고 **SSM Session Manager로만** 접속합니다. 게이트웨이를 손으로 바로 체험할 수 있습니다(상세는 [Try it](#try-it-in-vpc-테스트-클라이언트-기본-포함)).

```bash
# [3] SSM 접속 — Name 태그(genai-gw-test-client)로 조회. (CloudFormation output 으로도 가능:
#     aws cloudformation describe-stacks --stack-name GenAiGwTestClientStack --query ...InstanceId)
aws ssm start-session --region ap-northeast-2 --target \
  "$(aws ec2 describe-instances --region ap-northeast-2 \
       --filters Name=tag:Name,Values=genai-gw-test-client Name=instance-state-name,Values=running \
       --query 'Reservations[0].Instances[0].InstanceId' --output text)"
bash -l                  # ★ gateway env 로드 (그냥 bash 금지)

# [4] cold 면 Bedrock(Seoul). genai-gw-warmup coding 후엔 같은 명령이 vLLM(Qwen3.5)로
claude "이 함수를 읽기 좋게 리팩터링해줘: ..."
genai-gw-warmup coding 2h     # 시간 지정 예약(만료 시 자동 cooldown). genai-gw-status 로 폴링
claude "이 함수를 읽기 좋게 리팩터링해줘: ..."   # 이제 vLLM 직접
genai-gw-cooldown coding      # 끝나면 예약 해제 + scale-to-zero (GPU 과금 정지)

# [5] 데모 종료 — 전체 스택 삭제
cdk destroy --all --force
```

> 테스트 클라이언트가 필요 없으면 `cdk deploy --all -c deployTestClient=false`로 제외합니다(스택 16개). 포함하더라도 burstable t3.small **standard credit 모드**라 idle 비용은 미미합니다(~$0.024/hr).

> **운영자 주의**: `cdk.json`의 `operatorRoleArns`는 비어 있는 상태로 배포됩니다(`vllmEndpoints`·`higressEndpoint`는 `finalize-deploy.sh`가 채웁니다). break-glass kubectl용 role ARN은 `-c operatorRoleArns='["arn:aws:iam::<account>:role/<role>"]'`로 넘기거나(또는 본인 `cdk.json`에 지정), 빈 값이면 코드가 그대로 처리합니다.

### 단계별 배포 (권장)

```bash
# Phase 0: 네트워크 + EKS + Karpenter
cdk deploy GenAiGwNetworkStack GenAiGwEksStack GenAiGwKarpenterStack

# Phase 1-6: 모델별 vLLM (선택적)
#   gated 모델(GenAiGwVllm-Longcontext, GenAiGwVllm-Math)은 HF 승인 후에만 추가
cdk deploy GenAiGwVllm-Coding
# (연구원 피드백 후 나머지 추가)

# Phase 7-10: 인증서 + Higress + SmartRouter + Warmup + Reservation + Admin + DNS
#   (GenAiGwHigressStack의 Helm release·NLB는 GenAiGwEksStack에 렌더되므로 GenAiGwEksStack도 함께 재배포)
cdk deploy GenAiGwCertStack GenAiGwEksStack GenAiGwHigressStack GenAiGwSmartRouterStack \
           GenAiGwWarmupStack GenAiGwReservationStack GenAiGwAdminConsoleStack GenAiGwDnsStack

# 후처리: NLB DNS 조회 → SmartRouter 재배선 → Higress 구성 적용
./scripts/finalize-deploy.sh
```

---

## Endpoints

| 용도 | URL | 백엔드 |
|------|-----|--------|
| 통합 진입점 (Anthropic 호환) | `https://gateway.genai-gw.internal` | SmartRouter → Higress |
| Admin Console (운영자 전용) | `https://admin.genai-gw.internal` | FastAPI |

모두 **Internal ALB + ACM(self-signed CA) + HTTPS 443**을 사용하며, Direct Connect / Site-to-Site VPN이 필요합니다.

---

## Researcher Onboarding

### 최초 1회 세팅

1. **CA 인증서 설치** — Secrets Manager에서 CA cert 받아 시스템 trust store에 등록
   ```bash
   aws secretsmanager get-secret-value \
     --secret-id /genai-gw/gateway/ca-cert \
     --query SecretString --output text \
     --region ap-northeast-2 > genai-gw-ca.crt
   # macOS
   sudo security add-trusted-cert -d -r trustRoot \
     -k /Library/Keychains/System.keychain genai-gw-ca.crt
   ```

2. **API 키 발급 요청** — Gateway 운영자에게 요청합니다. 현재는 단일 공유 마스터 키입니다.

3. **Claude Code CLI 설정**
   ```bash
   export ANTHROPIC_BASE_URL=https://gateway.genai-gw.internal
   export ANTHROPIC_API_KEY=<발급받은-토큰>
   claude -p "Hello"   # → Bedrock Sonnet Seoul으로 라우팅
   ```

### Alias 사용

```bash
# general: SmartRouter가 prompt 분석 후 최적 모델 선택
curl https://gateway.genai-gw.internal/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"general","max_tokens":256,"messages":[...]}'

# 특정 alias 강제 (model 필드에 alias 직접 지정)
curl https://gateway.genai-gw.internal/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"coding","max_tokens":256,"messages":[...]}'
```

---

## Try it: in-VPC 테스트 클라이언트 (기본 포함)

게이트웨이를 **직접 체험**할 수 있도록, 배포에는 VPC 안 테스트용 EC2 1대가 **기본 포함**됩니다. Claude Code(GenAI harness)가 미리 설치·게이트웨이 연결까지 끝난 상태로 부팅되고, **SSM Session Manager로만** 접속합니다(public IP·SSH 없음, SSM VPC endpoint 경유). 인스턴스는 burstable **t3.small (standard credit 모드)** 이라 idle 비용이 ~$0.024/hr로 미미하고, baseline 초과 burst는 과금이 아니라 throttle됩니다.

```bash
# 기본 포함 — `cdk deploy --all` 만으로 GenAiGwTestClientStack 이 함께 뜬다.
# 필요 없으면 제외(스택 16개):
cdk deploy --all -c deployTestClient=false
```

핵심은 **같은 명령으로 cold/warm을 비교**하는 것입니다. 클라이언트는 model 하나(`general`)만 고정하고, 전환은 SmartRouter의 자동 fallback이 처리합니다:

```bash
# 1) SSM으로 접속 — 인스턴스 ID 하드코딩 대신 Name 태그로 조회
aws ssm start-session --region ap-northeast-2 --target \
  "$(aws ec2 describe-instances --region ap-northeast-2 \
       --filters "Name=tag:Name,Values=genai-gw-test-client" \
                 "Name=instance-state-name,Values=running" \
       --query 'Reservations[0].Instances[0].InstanceId' --output text)"

# 접속 후 — ★ bash -l 필수 (gateway env 로드). 그냥 bash 는 env 가 안 실린다.
bash -l

# 안내 보기 / 지금 어느 백엔드가 답하는지 확인
genai-gw-demo
genai-gw-which                 # model + x-genai-gw-fallback 헤더 (cold=bedrock-direct, warm=qwen, 헤더 없음)

# 2) warm-up 전 (GPU cold): vLLM alias가 0 replica → SmartRouter가 cold를 감지해
#    in-region Bedrock(Claude 3.5 Sonnet, 서울)으로 직접 fallback
claude "이 함수를 읽기 좋게 리팩터링해줘: ..."

# 3) GPU 모델 기동 (수 분 소요, genai-gw-status로 폴링) — 시간 지정 시 만료에 자동 cooldown
genai-gw-warmup coding 2h      # 2h / 90m / 3600(초) · 미지정 시 1h
genai-gw-status                # coding 이 WARM (reserved, ~Nm left) 으로 뜨면 준비 완료

# 4) warm-up 후: 똑같은 명령이 이제 self-host Qwen3.5-27B(vLLM)로 라우팅
claude "이 함수를 읽기 좋게 리팩터링해줘: ..."

# 5) 끝나면 GPU 과금 정지 (만료 전 수동 정지)
genai-gw-cooldown coding       # 예약 해제 + 해당 alias를 0 replica로 복귀
```

| 헬퍼 | 동작 |
|------|------|
| `genai-gw-which [max_tokens]` | 지금 `coding`에 답하는 백엔드 확인 (model + `x-genai-gw-fallback` 헤더) |
| `genai-gw-warmup <alias> [기간]` | **시간 지정 예약**으로 alias 기동 (`2h`/`90m`/`3600`, 기본 1h). 만료 시 자동 cooldown |
| `genai-gw-status` | alias별 warm/cold + 예약 잔여 시간 + 최근 warm-up 진행 상태 |
| `genai-gw-cooldown <alias>` | 예약 해제 후 alias를 scale-to-zero (`genai-gw <alias>`는 하위호환 alias) |
| `genai-gw-demo` | 위 시나리오 안내 출력 |

> **자동 전환 원리**: 클라이언트는 항상 `ANTHROPIC_MODEL=general`을 보냅니다. SmartRouter는 Higress로 보내기 **전에** 해당 alias의 vLLM NLB `/health`를 ~2s로 pre-flight 합니다. cold(healthy target 0)면 gateway를 건너뛰고 곧장 Bedrock Seoul로 직접 fallback(boto3, Anthropic Messages native)하고, warm이면 Higress→vLLM 정상 경로로 갑니다. gateway나 vLLM이 에러를 반환하는 경우에도 reactive fallback(Bedrock-direct)이 안전망으로 동작합니다. 클라이언트 코드·모델명 변경 없이 동일 명령으로 두 백엔드를 비교 체험할 수 있습니다.

> **`genai-gw-warmup`이 예약(reservation) 기반인 이유**: `genai-gw-warmup`은 warm-up SFN을 직접 부르지 않고 **reserve-fn**(DynamoDB 예약 + EventBridge Scheduler 1회성 만료)을 호출합니다. 따라서 지정한 기간이 지나면 **자동으로 scale-to-zero** 되어, 끄는 걸 잊어도 GPU가 무한정 켜져 있지 않습니다(g5.12xlarge ~$5.7/hr 방지). `genai-gw-cooldown`은 만료 전 수동 정지용이며, **예약 행을 먼저 지운 뒤** scale-0 합니다 — reserve-fn은 예약 0→1 전환에서만 기동하므로, 남은 예약 행이 있으면 다음 `genai-gw-warmup`이 조용히 무시될 수 있기 때문입니다.

### warm-path `max_tokens` clamp 검증 (단계별)

warm(vLLM) 상태에서 Claude Code가 보내는 큰 `max_tokens`(기본 32000)가 모델 context window를 넘어 vLLM 400 → Bedrock 폴백으로 새지 않고, **vLLM이 직접** 답하는지 확인하는 절차입니다. (SmartRouter가 context-overflow 400을 만나면 `max_tokens`를 절반씩 줄여 재시도하는 iterative-halving clamp를 적용합니다.)

```bash
# STEP 0 — 접속 (위 1) 과 동일, Name 태그 → bash -l)

# STEP 1 — cold 확인: 지금은 Bedrock 이 답해야 정상
genai-gw-which 32000
#   기대(cold): model=claude-3-5-sonnet-... (또는 haiku)  +  x-genai-gw-fallback: bedrock-direct

# STEP 2 — warmup (GPU 기동, ~10분)
genai-gw-warmup coding 1h
genai-gw-status                      # coding 이 WARM 으로 뜰 때까지 반복

# STEP 3 — warm 검증: 백엔드 판별은 헤더로만 (모델 자백 무효)
genai-gw-which 32000
#   기대(warm): model=qwen35-27b  +  x-genai-gw-fallback: (none) = vLLM-direct
#   혹시 x-genai-gw-fallback: bedrock-direct 가 뜨면 → 회귀 (보고 요망)

# STEP 4 — 실제 claude CLI 로 큰 작업(헤더로 vLLM-direct 확인)
claude --debug -p "Summarize the design tradeoffs of a large codebase in detail." 2>&1 \
  | grep -i 'x-genai-gw-fallback' \
  && echo "↑ bedrock-direct 보이면 폴백(결함)" \
  || echo "fallback 헤더 없음 = vLLM-direct (정상)"

# STEP 5 — 끝나면 비용 정지 (예약 만료 전 수동)
genai-gw-cooldown coding
```

> ⚠️ **백엔드 판별은 `x-genai-gw-fallback` 헤더로만** 합니다. claude에게 "너 누구냐"고 물어도 정체성이 system prompt에 주입돼 있어 Qwen이 답해도 `claude-...`라고 답합니다 — 모델 자백은 신뢰하지 마십시오.

---

## Model Matrix

### vLLM (EKS Auto Mode, scale-to-zero)

| Alias | 모델 | 라이선스 | EC2 | GPU | Max Ctx | Loading (캐시 있음) | 주요 벤치마크 |
|-------|------|----------|-----|-----|---------|---------------------|---------------|
| `coding` | Qwen3.5-27B | Apache-2.0 | g5.12xlarge | 4×A10G | 32,768 | ~8 분 | SWE-bench 72.4% / LCB v6 80.7% |
| `video` | Qwen3.5-27B | Apache-2.0 | g5.12xlarge | 4×A10G | 32,768 | ~8 분 | MMMU 85.0 (vision/video) |
| `ocr` | InternVL3-14B | MIT | g5.12xlarge | 4×A10G | 8,192 | ~5 분 | DocVQA 94.1 / OCRBench 875 |
| `math` | Gemma 4 31B | **gated** (Gemma) | g6e.12xlarge | 4×L40S | 32,768 | ~6–8 분 | AIME 2026 89.2% / GPQA 84.3% |
| `audio` | Phi-4 Multimodal | MIT | g5.xlarge | 1×A10G | 16,384 | ~5–7 분 | 통합 audio+vision |
| `longcontext` | LLaMA 4 Scout 17B-16E | **gated** (Meta) | g6e.48xlarge | 8×L40S | 131,072 | **~35 분** | 128K context / MoE (17B active) |

- **gated 모델**(`math`·`longcontext`)은 HF 라이선스 승인이 선행돼야 합니다 — [Prerequisites](#prerequisites) 2번을 참고하십시오. 안 쓰면 해당 스택을 배포에서 빼면 됩니다.
- **scale-to-zero**: `minReplicas=0` — 미사용 시 GPU 노드를 해제하고, 다음 요청 시 Karpenter가 노드를 프로비저닝하며 vLLM을 시작합니다.
- **all warmup (병렬)**: LLaMA 4 Scout 기준 ~35 분입니다 (가장 느린 모델이 결정).
- **캐시 위치**: S3 Mountpoint (`s3://<model-cache-bucket>/<servingName>/`)
- **LLaMA 4 Scout 특이사항**: `--enforce-eager`가 필수입니다 (CUDA graph capture 비활성화, 부팅 20분 초과 방지).
- ⚠️ 라이선스·벤치마크는 모델카드 기준이며 변할 수 있습니다 — **배포 시점에 각 모델카드에서 확인**하십시오.

### Bedrock (ON_DEMAND / IN_REGION Seoul)

| Alias | Bedrock Model ID | 용도 |
|-------|------------------|------|
| `claude-3-5-sonnet-20241022` | `anthropic.claude-3-5-sonnet-20240620-v1:0` | Claude Code CLI 기본 target |
| `claude-3-haiku-20240307` | `anthropic.claude-3-haiku-20240307-v1:0` | 빠른/저비용 처리 (⚠️ 모델 EOL 일정은 Bedrock 콘솔에서 확인하고, 후속 모델로 alias를 갱신하십시오) |

> **Alias ≠ 서빙 모델 ID**: 첫 행의 client alias(`...20241022`)와 실제 서빙 Bedrock Model ID(`...20240620-v1:0`)는 의도적으로 다릅니다. 왼쪽은 Claude Code CLI가 보내는 model 문자열이고, 오른쪽은 서울 in-region에서 실제 응답하는 Sonnet 3.5입니다. CLI가 어떤 Sonnet alias를 보내든 in-region 모델로 매핑되도록 한 것입니다.

> **"OpenAI 계열"이 필요한 경우**: proprietary GPT(예: gpt-5.x)는 가중치가 비공개라 self-host가 불가능합니다. 반면 open-weight **gpt-oss-20b / gpt-oss-120b**는 vLLM alias로 추가해 Seoul in-region으로 운영할 수 있습니다. Bedrock 경유 경로는 서울 in-region 제공 여부를 콘솔에서 확인한 후 사용하십시오.

<details>
<summary><strong>성능은 얼마나 떨어지는가</strong> — frontier 대비 위치, 더 높은 충실도 옵션, 수치 해석 주의 (2026-06 검증, 펼치기)</summary>

### 성능은 얼마나 떨어지는가 — frontier 대비 위치 (2026-06 검증)

> 데이터 주권 요건 때문에 frontier proprietary 모델(Claude Opus, GPT 등)을 직접 못 쓰고 self-host open-weight로 대체할 때, **얼마나 성능을 양보하는지**를 먼저 알고 도입을 결정해야 합니다.

현행 `coding` alias의 **Qwen3.5-27B**를 frontier 상한과 비교하면 다음과 같습니다 (정규화 = `max(GPT-5.5, Claude Opus 4.8)`를 100으로):

| 축 | Qwen3.5-27B | frontier 상한 | **frontier 대비** |
|----|-------------|---------------|-------------------|
| 코딩 (SWE-bench Verified) | 72.4 | 88.6 (Opus 4.8) | **≈ 82%** |
| 지식 (GPQA Diamond) | 85.5 | 93.6 | ≈ 91% |
| 수학 (AIME 2026) | 90.8 | ~96.7 | ≈ 94% |
| 코드 생성 (LiveCodeBench v6) | 80.7 | ~88 | ≈ 92% |

- **헤드라인: 가장 까다로운 축인 agentic 코딩(SWE-bench)에서 frontier의 ≈ 82% 수준입니다.** 지식·수학으로 갈수록 격차가 줄어 90% 이상으로 근접합니다. 남는 갭은 "가장 어려운 agentic 코딩"에 집중됩니다.
- **vs. 서울 in-region 매니지드 baseline**: in-region 요건으로 서울에 묶이면 Bedrock Claude 3.5 Sonnet(`2024-06-20`)이 사실상 유일한 frontier급 매니지드 옵션인데, 이 모델의 SWE-bench Verified는 **≈ 33%**(agentic scaffold 기준, [Anthropic](https://www.anthropic.com/news/swe-bench-sonnet)) = frontier의 **≈ 37%** 입니다. 업데이트판 `2024-10-22`도 ≈ 49%(≈ 55%)입니다. **self-host Qwen3.5-27B(72.4%, ≈ 82%)는 in-region 매니지드 대비 코딩 능력을 2배 이상**으로 끌어올립니다. 이것이 이 repo의 핵심 가치입니다 (상단 *TL;DR* 및 *왜 이 repo가 필요한가* 펼침 섹션 참고).
- **더 높은 충실도가 필요하면** 동일 Qwen3.5 패밀리(전부 Apache-2.0, self-host 가능)의 플래그십 **Qwen3.5-397B-A17B**(403B MoE / 17B active)로 `coding` alias를 교체할 수 있습니다 — SWE-bench **76.4** (frontier의 ≈ 86%), 지식·수학은 94–99%입니다. 단 H200(P5en) 다수가 필요해 비용이 크게 증가합니다.
- ⚠️ **수치 해석 주의**: SWE-bench는 harness·vendor마다 ±3~5점 편차가 있고, 위 Qwen 수치는 모델카드의 peak reasoning mode 기준이라 실서비스 기본 설정에선 더 낮을 수 있습니다. **도입 전 실제 워크로드로 PoC 실측**을 권장합니다.
- 출처: Qwen 공식 HF 모델카드(`Qwen/Qwen3.5-27B`, `Qwen/Qwen3.5-397B-A17B`) + vals.ai(SWE-bench) · llm-stats(GPQA) · Artificial Analysis 교차검증.

</details>

---

<details>
<summary><strong>CDK Stacks (17개)</strong> — 스택별 역할 표 (펼치기)</summary>

| Stack | 역할 |
|-------|------|
| `GenAiGwNetworkStack` | VPC 10.0.0.0/16, 3 AZ, NAT GW, VPC Endpoints (S3/DDB/ECR/STS/SM) |
| `GenAiGwEksStack` | EKS Auto Mode v1.32, S3 Mountpoint CSI driver, model-cache S3 bucket |
| `GenAiGwKarpenterStack` | NodePools: cpu / gpu (amd64) / neuron |
| `GenAiGwVllm-Coding` | Qwen3.5-27B (g5.12xlarge, 4×A10G) |
| `GenAiGwVllm-Video` | Qwen3.5-27B (g5.12xlarge, 4×A10G, vision/video) |
| `GenAiGwVllm-Ocr` | InternVL3-14B (g5.12xlarge, 4×A10G) |
| `GenAiGwVllm-Math` | Gemma 4 31B (g6e.12xlarge, 4×L40S) — gated |
| `GenAiGwVllm-Audio` | Phi-4 Multimodal (g5.xlarge, 1×A10G) |
| `GenAiGwVllm-Longcontext` | LLaMA 4 Scout 17B-16E (g6e.48xlarge, 8×L40S) — gated |
| `GenAiGwCertStack` | Self-signed wildcard cert `*.genai-gw.internal` → ACM + Secrets Manager (CA) |
| `GenAiGwHigressStack` | Higress AI Gateway (EKS Helm) + Bedrock IAM user / consumer-key Secrets. Helm release + internal NLB 443은 `GenAiGwEksStack`에 렌더 |
| `GenAiGwSmartRouterStack` | SmartRouter ECS Fargate, Internal ALB 443 |
| `GenAiGwWarmupStack` | Step Functions (Warmup / Cooldown) |
| `GenAiGwReservationStack` | DynamoDB reservation + reserve/expire Lambda + EventBridge |
| `GenAiGwAdminConsoleStack` | FastAPI ECS + ALB (`admin.genai-gw.internal`) |
| `GenAiGwDnsStack` | Route53 PHZ `genai-gw.internal` + alias records |
| `GenAiGwTestClientStack` | in-VPC 테스트 EC2 (t3.small standard credit, SSM 전용) + Claude Code. 기본 포함, `-c deployTestClient=false`로 제외 |

</details>

<details>
<summary><strong>Warm-up / Reservation</strong> — 콜드 스타트 사전 기동, 자동 스케줄 (펼치기)</summary>

vLLM 모델은 미사용 시 `scale-to-zero` 상태입니다. 첫 요청 시 5~35분 콜드 스타트가 발생합니다. 사전에 warm-up 하려면 다음과 같이 합니다:

```bash
# 특정 alias 1시간 warm-up
scripts/warmup-request.sh --alias coding --requester andrew

# 복수 alias + 기간
scripts/warmup-request.sh --alias coding,math --duration 2h --requester andrew

# 전체 모델 30분
scripts/warmup-request.sh --alias all --duration 30m
```

- 예약은 DynamoDB `GenAiGwWarmupReservations`에 저장되고 → `reserve-fn`이 Warmup SFN을 트리거합니다.
- 만료 시 `expire-fn`이 Cooldown SFN을 트리거합니다 (겹치는 예약이 있으면 연장).
- **자동 스케줄**: 평일 08:30~19:30 KST, EventBridge rule로 모든 alias를 자동 warm-up합니다.
- **Admin Console**: `https://admin.genai-gw.internal` — 현재 예약/상태 확인 및 수동 조작이 가능합니다.

</details>

<details>
<summary><strong>Admin Console</strong> — 운영자 콘솔 (replicas·예약·수동 스케일) (펼치기)</summary>

- URL: `https://admin.genai-gw.internal` (내부망)
- 인증: Basic Auth — 비밀번호는 Secrets Manager `/genai-gw/admin-console/password`
- 기능:
  - 현재 alias별 replicas / 노드 상태
  - Active reservations 목록 / 남은 시간
  - 수동 warm-up / cool-down
  - Gateway 로그 / Bedrock 호출 통계 (기본)

</details>

<details>
<summary><strong>In-region 데이터 통제 체크리스트</strong> — 기술 통제 매핑 + CRIS 미사용 근거 (펼치기)</summary>

> ⚠️ 아래 기술 통제는 in-region 요건을 **지원**하는 것이지, 이 코드를 배포한다고 자동으로 규정을 "준수"하게 되는 것은 아닙니다. 실제 컴플라이언스는 조직의 정책·인력 접근통제·감사·법적 검토를 포함한 종합 판단이며, 반드시 자체 보안/법무 검토를 거쳐야 합니다.

| 요건 | 지원하는 기술 통제 |
|------|--------------------|
| 모든 추론 Seoul 리전 | `bin/in-region-genai-gateway.ts` — region 하드코딩 |
| Bedrock IN_REGION only | `config/models.ts` BEDROCK_MODELS 전부 `ap-northeast-2` |
| Bedrock ON_DEMAND only | Provisioned Throughput / Cross-region Inference 미사용 |
| 연구원 네트워크 격리 | Internal ALB + Route53 PHZ, public endpoint 없음 |
| 데이터 in transit 암호화 | ACM + HTTPS 443 (self-signed wildcard cert) |
| 모델 가중치 격리 | S3 bucket 서울 리전, prefix per alias, 노드 IAM scope |
| AWS API egress | VPC Endpoints (S3/DDB/ECR/STS/SM) — NAT 우회 |

> **왜 Cross-Region Inference(CRIS)를 쓰지 않는가?** Bedrock에서 frontier 모델을 Seoul에서 호출하더라도, 그 모델이 in-region이 아니라 CRIS(geographic inference profile)로만 제공되면 추론 중 input prompt와 output이 같은 geography(예: APAC) 내 타 리전으로 전송됩니다 — 저장은 source 리전에만 남지만 **처리는 Seoul을 벗어납니다** ([AWS 문서](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html): *"your input prompts and output results might move outside of your source Region during cross-Region inference"*). 데이터의 국내 체류가 요건인 환경에서는 부적합합니다. 본 게이트웨이는 (1) Seoul **IN_REGION on-demand** Bedrock 모델만 사용하고, (2) 그 외에는 EKS 위 **self-host vLLM**으로 라우팅하여 추론이 Seoul을 벗어나지 않도록 강제합니다.

</details>

<details>
<summary><strong>Key Design Decisions</strong> — EKS Auto Mode·S3 Mountpoint·스마트 라우팅·Higress 변환·Pod Identity (펼치기)</summary>

### EKS Auto Mode v1.32
- `aws-cdk-lib/aws-eks-v2` 사용 (Auto Mode 지원)
- NodePool 중 `system`, `general-purpose`만 활성, GPU는 Karpenter가 프로비저닝
- EBS CSI provisioner: `ebs.csi.eks.amazonaws.com` (Auto Mode 전용)

### 모델 캐시: S3 Mountpoint (EFS 대체)
- EKS Auto Mode + EFS CSI v3.x + Bottlerocket 조합에서 `amazon-efs-mount-watchdog` init system 미감지로 TLS 기반 NFS mount 실패 (I1)
- S3 Mountpoint CSI (`aws-mountpoint-s3-csi-driver`)로 우회 — alias별 prefix로 격리, 노드 IAM 권한 스코핑
- 재부팅/노드 교체 후에도 가중치 캐시 영속화

### Scale-to-zero + Warm-up
- `minReplicas=0` 기본값 → GPU 비용 상시 지출 없음
- Karpenter ExistNow/ProvisionUnderThreshold 이벤트로 노드 생성, vLLM init에 5~35분 소요
- Warm-up은 Step Functions로 오케스트레이션 (I7 수정: 최대 50분 timeout)

### Smart Routing & Bedrock-direct fallback
- `general` alias 요청 시 **정규식 키워드 카운트**(LLM·임베딩 미사용)로 scenario 감지 → `coding`/`math`/... 모델로 재작성. 매칭 0이면 default = `coding`. (멀티모달·초장문만 키워드 전에 우선 판정. 상세는 위 *라우팅 흐름* 및 [FAQ](#faq).)
- `model` 필드에 alias를 직접 지정하면 SmartRouter가 그대로 통과(scenario 감지 생략)
- vLLM alias가 cold면 SmartRouter가 pre-flight로 감지 → Higress를 우회하고 Bedrock(Anthropic Messages native, boto3)으로 직접 fallback. gateway/vLLM 에러 시에도 reactive fallback이 안전망
- **Warm-path `max_tokens` clamp (2단계)** — vLLM은 `input_tokens + max_tokens ≤ maxModelLen`을 **엄격히** 강제(초과 시 HTTP 400)합니다. Claude Code는 매 요청에 큰 고정 `max_tokens`(관측 32000)를 싣는데, 이는 작은 모델의 window(예: `coding`=Qwen3.5-27B maxModelLen 32768)를 넘겨 **warm alias가 400 → Bedrock으로 폴백**(warm인데 Haiku가 답하는) 결함을 일으켰습니다(2026-06 incident). SmartRouter가 두 단계로 막습니다:
  1. **선제(preemptive) clamp** — gateway POST **전에** `max_tokens`를 `min(요청값, maxModelLen − reserve)`(floor 보장)로 줄입니다. 짧은 prompt + 큰 max_tokens라는 흔한 케이스를 round-trip 없이 잡는 1차 필터입니다. reserve는 tokenizer 의존을 피한 고정 여유(`VLLM_INPUT_TOKEN_RESERVE`, 기본 8192).
  2. **반응형(reactive) iterative halving** — 실 입력이 reserve를 넘으면(Claude Code의 system+tools+멀티턴 누적은 흔히 8k~24k+) 선제 clamp만으론 여전히 `input+output>window`라 400이 납니다. 이때 SmartRouter가 `max_tokens`를 **절반씩 줄여 gateway에 재시도**(최대 `VLLM_RECLAMP_MAX_RETRIES`=6, floor `VLLM_MIN_OUTPUT_TOKENS`=1024)합니다. 각 400은 generation 없는 빠른 validation reject(~50ms)라 보통 1~2회로 `input+max_tokens≤window`에 수렴합니다. tokenizer 불필요·모델 무관(vLLM 400 메시지의 input-token 수는 `window−max_tokens+1` 하한값일 뿐 실측이 아니라 신뢰 불가 → 값 파싱 대신 halving으로 수렴). 입력이 window에 근접해 floor에서도 안 들어가는 극단(작은 window 모델)만 기존 Bedrock fallback이 받습니다(안전망 유지).
  - alias별 window는 `VLLM_MAX_MODEL_LEN`(JSON map, `config/models.ts`의 `VLLM_MODELS`에서 생성)으로 주입하며, 맵에 없는 alias는 clamp 비활성(안전 no-op). 반응형 재시도는 `VLLM_RECLAMP_RETRY=false`로 끌 수 있습니다.

#### Cold-start 가용성: cascade + 504 churn 차단
cold fallback의 용도는 "vLLM이 기동되는 동안, 부족하나마 in-region Bedrock으로 즉답"입니다(품질 < 가용성, best-effort). 이를 위해 두 가지가 들어가 있습니다.

- **Cascading in-region fallback (default Sonnet 3.5 → Haiku 3)** — primary fallback 모델이 일시적 capacity throttle(`ServiceUnavailableException: Too many connections`)을 맞으면, SmartRouter가 secondary 모델로 투명하게 cascade합니다. 두 모델은 **독립된 on-demand capacity 풀**(RPM 50 vs 400 — 8× 차이의 별도 풀)이라, 한쪽이 포화여도 다른 쪽은 여유가 있을 확률이 높습니다. 둘 다 Seoul(`ap-northeast-2`) IN_REGION이라 「전 추론 리전 내」 제약을 보존합니다. throttle 계열 예외(`ServiceUnavailableException`/`ThrottlingException`/`TooManyRequestsException`)에서만 cascade하고, malformed 등 terminal 에러는 즉시 반환합니다. non-stream/stream 양 경로 모두 적용되며, streaming은 첫 frame을 큐잉하기 전에 모델별로 시도하므로 throttle된 primary가 부분 stream을 흘리지 않습니다.
  - **순서 결정 = quality vs availability (deploy-time configurable)**: 기본은 **품질 우선 = Sonnet 3.5 primary**입니다. 이 게이트웨이의 본분이 정확도이므로 cold 안전망도 고품질을 먼저 시도합니다. ⚠️ trade-off (2026-06-14 측정): Seoul Sonnet 3.5 on-demand 풀이 ~93% throttle인 반면 Haiku 3 풀(RPM 400, 8× 큼)은 ~43%라, Sonnet primary는 cold 요청이 botocore adaptive-retry backoff로 **16~93초(때때로 timeout)**, Haiku primary는 **4~6초**입니다. 품질을 위해 느린 cold-start를 기본으로 감수합니다. cold **속도**가 더 중요하면 `-c coldFallbackOrder=availability`로 배포하면 Haiku 3가 primary가 됩니다(기본은 `quality`). 빠른 고품질이 필요하면 vLLM alias를 warm-up해 self-host 모델로 직접 받으십시오.
  - 환경변수: `BEDROCK_FALLBACK_MODEL_ID`(primary), `BEDROCK_FALLBACK_MODEL_ID_SECONDARY`(secondary, 빈 값이면 cascade 비활성). bin이 `coldFallbackOrder` context에 따라 `config/models.ts`의 `BEDROCK_MODELS[0]`/`[1]`(default quality=Sonnet/Haiku) 또는 그 역순을 주입합니다.
  - ⚠️ Claude 3 Haiku는 EOL 일정이 있으니(Bedrock 콘솔 확인), Seoul IN_REGION에서 후속(예: Haiku 3.5)이 가용해지면 `config/models.ts`의 primary를 갱신하십시오. 풀 용량(throttle 비율)이 바뀌면 primary/secondary 순서도 재검토하십시오.
- **Streaming 504 churn 차단** — cold→Bedrock streaming fallback이 throttle backoff 동안 0 byte를 흘리면 fronting ALB의 idle timeout이 504를 발화하던 결함이 있었습니다(2026-06 incident). 세 가지 가드로 차단합니다: (1) SSE keepalive ping(`BEDROCK_KEEPALIVE_SECS`, 기본 10s) — slot 대기·첫 byte 지연 구간에도 bytes를 흘려 ALB idle timer를 리셋, (2) 동시성 semaphore(`BEDROCK_MAX_CONCURRENCY`, 기본 3) — burst를 직렬화해 "Too many connections" 자체를 줄임, (3) boto3 adaptive retry(`BEDROCK_MAX_ATTEMPTS`, 기본 8) + ALB idle timeout 180s.

### Higress Anthropic ↔ OpenAI 변환
- Claude Code는 `thinking`, `betas`, `anthropic_version` 등 Anthropic 전용 파라미터를 `/v1/messages`로 전송
- Higress AI Gateway가 Anthropic Messages를 OpenAI Chat Completions로 native 변환해 vLLM(OpenAI 호환)에 전달하고, 응답을 Anthropic 양식으로 역변환한다 (이전 LiteLLM의 `drop_params`/수동 sanitize를 대체)

### Pod Identity > IRSA
- Bedrock 호출, S3 Mountpoint 모두 EKS Pod Identity 사용
- S3 Mountpoint CSI는 OIDC 기반 IRSA 경로도 함께 구성

</details>

<details>
<summary><strong>Cost Model</strong> — scale-to-zero ~$0.45/hr, 모델 기동 시 alias별 추가 (펼치기)</summary>

### scale-to-zero (상시)
| 컴포넌트 | 인스턴스 | 시간당 |
|----------|----------|--------|
| EKS Control Plane | — | $0.10 |
| Karpenter system nodes | m5.large | ~$0.10 |
| SmartRouter / Admin ECS | Fargate (0.5 vCPU × 2) | ~$0.07 |
| Higress (gateway/controller/console) | EKS pods (non-GPU 노드) | EKS 노드 비용에 포함 |
| Internal LB × 3 (SmartRouter ALB + Admin ALB + Higress NLB) | — | ~$0.07 |
| NAT GW | — | ~$0.05 |
| S3 Storage (모델 캐시) | ~500 GB | ~$0.02 |
| 테스트 클라이언트 (기본 포함) | t3.small (standard credit) | \~$0.024 + EBS 20GB gp3 \~$0.002 |
| **상시 합계** | | **\~$0.47/hr (\~$340/month)** |

### vLLM 모델 기동 시 (alias 별)
| Alias | 인스턴스 | 시간당 추가 |
|-------|----------|-------------|
| coding / video / ocr | g5.12xlarge | ~$5.67 |
| math | g6e.12xlarge | ~$3.90 |
| audio | g5.xlarge | ~$1.00 |
| longcontext | g6e.48xlarge | ~$30.90 |

자동 스케줄(평일 08:30~19:30 KST, 11h × 21일) 기준 전체 warm-up 시 월 비용은 다음과 같습니다:
- coding + video + ocr + math + audio: \~$17/hr × 231h = \~$3,927
- + longcontext (필요 시만): +$30.90/hr × 사용시간

> 비용 최적화: `longcontext`는 예약(`--alias longcontext`)으로만 기동하고, 필요 없는 alias는 `minReplicas=0`으로 유지하십시오.
> 모든 가격은 작성 시점 개략 추정치입니다. 최신 요율은 [AWS Pricing Calculator](https://calculator.aws/)에서 확인하십시오.

</details>

<details>
<summary><strong>Operations</strong> — 수동 스케일·로그·헬스 체크 (펼치기)</summary>

### 수동 스케일
```bash
# alias 즉시 기동 (Warmup SFN 우회)
kubectl scale deployment <servingName> -n vllm --replicas=1

# alias 즉시 해제
kubectl scale deployment <servingName> -n vllm --replicas=0
```

### 로그
- vLLM: `kubectl logs deploy/<servingName> -n vllm -f`
- Higress: `kubectl logs deploy/higress-gateway -n higress-system -f`
- SmartRouter: CloudWatch Logs `/ecs/genai-gw-smart-router`
- Admin Console: CloudWatch Logs `/ecs/genai-gw-admin-console`
- Warmup SFN: Step Functions console `GenAiGwWarmup`/`GenAiGwCooldown`

### 헬스 체크
```bash
# SmartRouter (게이트웨이 진입점)
curl https://gateway.genai-gw.internal/health/liveliness

# Higress gateway (in-cluster, NLB DNS로)
kubectl exec -n vllm <curl-pod> -- curl -sk https://<higress-nlb>:443/
```

</details>

<details>
<summary><strong>검증 결과 (Test Report)</strong> — E2E 4/4 PASS + 해결한 corner case 3종 (펼치기)</summary>

배포된 환경에서 게이트웨이 진입점(`gateway.genai-gw.internal`, Anthropic Messages API `/v1/messages`, `x-api-key` 마스터 키)으로 in-VPC 클라이언트에서 실측한 결과입니다. 4개 핵심 경로가 모두 통과했고, 운영 중 발견한 corner case 3종을 해결했습니다.

> ⚠️ 아래는 특정 배포에서의 실측 스냅샷입니다. 모델 버전·벤치마크·지연 수치는 배포 환경·시점에 따라 달라질 수 있으니 **도입 전 자체 환경에서 재현**하십시오.

### E2E 경로 (4/4 PASS)

| # | 시나리오 | 경로 | 결과 |
|---|----------|------|------|
| 1 | **cold → Bedrock** | vLLM scale-0 상태에서 요청 → SmartRouter pre-flight가 cold 감지 → Bedrock-direct | HTTP 200, `x-genai-gw-fallback: bedrock-direct`, `claude-3-5-sonnet` 응답 |
| 2 | **warm → vLLM (non-stream)** | vLLM warm 상태 → Higress → vLLM 직접 | HTTP 200, `model: qwen35-27b`, fallback 헤더 없음 |
| 3 | **tool use → vLLM direct** | warm tool-call 요청 → vLLM 직접 처리 | HTTP 200, structured `tool_use` block, `stop_reason: tool_use`, fallback 없음 |
| 4 | **streaming → vLLM** | `stream:true` warm 요청 | HTTP 200, `text/event-stream`, native Anthropic SSE(`message_start`→`content_block_delta`×N→`message_stop`) |

### 해결한 corner case (3종)

| 증상 | 근본 원인 | 해결 |
|------|-----------|------|
| **cold 요청 ~41초 지연** | vLLM alias가 scale-0면 NLB target이 0개 → Envoy(Higress)가 dead upstream에 ~40초 hang 후 503 | SmartRouter가 Higress 호출 **전** 해당 alias의 vLLM NLB `/health`를 2초 timeout으로 직접 pre-flight. cold면 gateway 우회하고 즉시 Bedrock-direct → **41초 → ~2.5초** |
| **tool-call XML이 평문으로 누출** | `--tool-call-parser hermes`는 JSON-in-`<tool_call>`을 기대하지만 Qwen3.5-27B는 XML 형식(`<tool_call><function=...>`)으로 출력 → 파서가 못 잡고 평문 누출 | parser를 `qwen3_xml`로 교체(`config/models.ts`의 `coding`·`video`) → structured `tool_use` block으로 vLLM 직접 처리 |
| **Bedrock `/v1/messages` SigV4 실패** | Higress ai-proxy 2.0.0은 Bedrock의 Anthropic Messages를 native 미지원 → OpenAI Chat→Bedrock Converse 2단 변환 중 SigV4 scope 에러([higress#3809]) | gateway-level fallback 제거. SmartRouter가 vLLM 실패 시 Bedrock의 native `/v1/messages`를 boto3로 **직접** 호출(gateway 우회) — Bedrock이 Anthropic 본문을 그대로 수용 |

[higress#3809]: https://github.com/alibaba/higress/issues/3809

### 자동 self-test 하네스 (`scripts/system-test.sh`)

배포 환경 전(全)경로를 사람 없이 PASS/FAIL로 자동 판정하는 하네스입니다. **in-VPC 테스트 클라이언트 EC2**(GenAiGwTestClientStack) 안에서 실행하며, gateway env(`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`)·CA trust·Step Functions ARN이 이미 셋업돼 있습니다. 종료 코드 = FAIL 개수(0=전부 통과), SKIP은 실패로 치지 않습니다.

```bash
# 테스트 클라이언트에 SSM 접속 — Name 태그(genai-gw-test-client)로 조회
aws ssm start-session --region ap-northeast-2 --target \
  "$(aws ec2 describe-instances --region ap-northeast-2 \
       --filters "Name=tag:Name,Values=genai-gw-test-client" \
                 "Name=instance-state-name,Values=running" \
       --query 'Reservations[0].Instances[0].InstanceId' --output text)"
# 접속 후 ★ bash -l 필수 (gateway env 로드)

# 무비용 차원만 (S-cold, S-cascade, S-reservation, S-admin)
./scripts/system-test.sh

# + GPU 차원 (S-warm, S-permodel) — 과금! 검증 후 즉시 scale-0
./scripts/system-test.sh --with-gpu

# 특정 차원만 / 리포트 파일
./scripts/system-test.sh --only cold
./scripts/system-test.sh --report /tmp/report.md
```

| 차원 | 검증 내용 | 비용 |
|------|-----------|------|
| **S-cold** | vLLM scale-0 → Bedrock-direct fallback. non-stream/stream 200 + `x-genai-gw-fallback` 헤더 + 모델=Sonnet\|Haiku + **504 churn 회귀 가드**(stream lifecycle 완결) | 무비용 |
| **S-cascade** | primary throttle → secondary cascade (방향은 배포 `coldFallbackOrder`에 따름; default Sonnet→Haiku). fault-injection 배포 시 **결정적**(아래), 아니면 best-effort 관측 | 무비용 |
| **S-warm** | `coding` warm-up → vLLM direct. 200 + 모델=qwen + fallback 헤더 없음 + tool_use + streaming + **`max_tokens=32000` clamp 회귀 가드**(warm인데 Bedrock 폴백이면 FAIL) + **실 claude CLI e2e**(`--debug` 응답 헤더로 vLLM-direct 확인). 검증 후 scale-0 | GPU(`--with-gpu`) |
| **S-permodel** | 6 alias 각각 warm→라우팅 검증→cooldown(직렬, 동시 GPU 금지). gated(longcontext/math)는 HF 미승인 시 SKIP | GPU(`--with-gpu`) |
| **S-reservation** | warm-up/cooldown Step Functions 도달성 | 무비용 |
| **S-admin** | 관리 콘솔(HTML-only) — SFN status로 갈음 | 무비용 |

**S-cascade 결정적 검증** — 라이브에서 실 throttle은 강제할 수 없으므로, gateway를 fault-injection 모드로 배포하면 합성 throttle로 cascade를 결정적으로 검증할 수 있습니다(테스트 전용, 기본 OFF — production 배포엔 `faultInjection` 생략 시 테스트 헤더가 무시되어 표면 자체가 없음):

```bash
# fault-injection 활성 배포 (env 보존: higress/vllm/operatorRole 함께 전달 필수)
cdk deploy --exclusively GenAiGwSmartRouterStack -c faultInjection=true \
  -c higressEndpoint=<NLB> -c vllmEndpoints='{...6 alias...}' -c operatorRoleArns='[...]'

# 그러면 x-genai-gw-test-throttle-primary: 1 헤더로 primary 합성 throttle → secondary cascade
./scripts/system-test.sh --only cascade
```

> ⚠️ SSM run-command로 스크립트를 투입할 땐 인라인 quoting 함정(괄호·JSON)을 피하려 base64로 전달하십시오:
> ```bash
> b64=$(base64 -w0 scripts/system-test.sh)
> aws ssm send-command --instance-ids <i-...> --document-name AWS-RunShellScript \
>   --parameters "commands=[\"echo $b64 | base64 -d > /tmp/system-test.sh\",\"bash -l /tmp/system-test.sh --only cascade\"]"
> ```

</details>

<details>
<summary><strong>Known Issues</strong> (펼치기)</summary>

| # | 이슈 | 상태 |
|---|------|------|
| I1 | Bottlerocket + EFS TLS mount 실패 | S3 Mountpoint로 우회 (운영 안정) |
| I8 | 연구원별 독립 API 키 미지원 | 단일 공유 마스터 키. 향후 Higress consumer key-auth(연구원별 consumer)로 분리 예정 |
| — | Bedrock 모델 EOL | Seoul IN_REGION 후속 모델로 alias 갱신 필요. EOL 일정은 Bedrock 콘솔에서 확인 |

</details>

---

## FAQ

**Q. 일반적인(generic) 질문을 하면 어떤 모델이 답하나요?**
`coding`(Qwen3.5-27B)이 답합니다. `model:general`로 들어온 요청을 SmartRouter의 `detect_scenario()`가 키워드로 분류하는데, math/coding/ocr 키워드가 하나도 안 잡히면 **default가 `coding`** 입니다 (Qwen3.5-27B가 범용으로 가장 강하므로). 즉 "오늘 날씨", "이 글 요약해줘" 같은 잡다한 질문도 전부 `coding` alias로 라우팅됩니다 — 단, 그 alias가 warm일 때 얘기입니다(cold면 아래 Q2처럼 Bedrock).

**Q. `math` 질문이 들어왔는데 `math` 모델이 warm-up 안 돼 있으면 Bedrock Sonnet 3.5가 답하나요?**
네 — **기본 설정에서는 Sonnet 3.5가 답합니다**(throttle 시에만 Haiku 3로 cascade). 정확한 흐름: 질문에 수학 키워드가 많으면 SmartRouter가 `math` alias로 정합니다 → `math` vLLM이 cold(0 replica)면 pre-flight가 감지 → Higress를 건너뛰고 **공통 in-region Bedrock fallback**(default primary=Sonnet 3.5, throttle 시 Haiku 3로 cascade)으로 직접 응답합니다. **중요**: fallback 대상은 *math 전용 Bedrock 모델*이 아니라 **scenario와 무관한 공통 Bedrock**입니다. 즉 "math가 cold라서 math 비슷한 Bedrock으로 간다"가 아니라, "vLLM 어느 alias든 cold면 동일한 in-region Bedrock(Sonnet→Haiku)이 받는다"입니다. `math`를 미리 `genai-gw-warmup math`로 띄워두면 그때는 Gemma 4 31B(vLLM)가 직접 답합니다.

**Q. cold fallback 순서(Sonnet vs Haiku 누가 먼저)는 바꿀 수 있나요? 왜 Sonnet이 기본인가요?**
**바꿀 수 있고, 기본은 품질 우선(Sonnet 3.5 primary → Haiku 3 secondary)입니다.** 이 게이트웨이의 존재 이유 자체가 속도가 아니라 **정확도·품질**(그래서 어렵게 Qwen을 self-host)이므로, cold 안전망도 고품질 모델을 먼저 시도하는 게 기본값입니다.

단 **trade-off가 있습니다** — 2026-06 측정 시 Seoul on-demand 풀에서 Sonnet 3.5는 **~93% throttle**(`Too many connections`), Haiku 3는 **~43%**(별도 풀, RPM 400 = Sonnet 50의 8배)였습니다. 그래서 Sonnet primary면 cold 요청이 retry backoff로 **16~93초(때때로 timeout)**, Haiku primary면 **4~6초**입니다. **품질을 위해 느린 cold-start를 기본으로 감수**합니다.

cold-start **속도**가 품질보다 중요한 고객은 배포 시 한 줄로 순서를 뒤집을 수 있습니다(소스 수정 불필요):

```bash
cdk deploy ... -c coldFallbackOrder=availability   # → Haiku 3 primary, Sonnet 3.5 secondary
# 기본값은 -c coldFallbackOrder=quality (Sonnet primary)
```

어느 쪽이든 두 모델 모두 Seoul IN_REGION이라 「전 추론 리전 내」는 보존됩니다. **빠른 속도 + 고품질을 동시에 원하면** 해당 vLLM alias를 `genai-gw-warmup`으로 띄워 self-host 모델(coding=Qwen3.5-27B 등, frontier의 ~82%)로 직접 받는 게 정답입니다 — cold 경로는 어디까지나 "vLLM 기동 동안의 best-effort 안전망"입니다. (Haiku 3 EOL 일정은 Bedrock 콘솔에서 확인하고, 후속 모델로 `config/models.ts`를 갱신하십시오.)

**Q. Claude Code가 "저는 Anthropic의 Claude"라고 답하던데, 그럼 실제로 Claude가 추론한 건가요?**
**아닙니다 — 모델의 자기소개는 백엔드 판별 신호가 아닙니다.** Claude Code CLI는 추론 모델에게 system prompt로 "너는 Claude Code"라는 정체성을 **주입**하므로, 실제 추론을 Qwen이 했든 Haiku가 했든 모델은 그 주입된 정체성을 그대로 따라 말합니다. "너 누구냐"고 물어도 Qwen이 "저는 Claude입니다"라고 확신에 차서 답합니다(자기가 Qwen인 줄 모름). **실제 백엔드는 응답 헤더(`x-genai-gw-fallback`)와 SmartRouter 로그로만** 판별합니다:
- 헤더 없음 + `model: qwen35-27b` → vLLM(Qwen)이 답함.
- `x-genai-gw-fallback: bedrock-direct` + `model: claude-3-haiku...` → cold라서 Bedrock이 답함.

**Q. 라우팅 분류에 LLM이나 임베딩이 쓰이나요?**
아니요. `detect_scenario()`는 **순수 정규식 키워드 카운트**입니다(`re.findall()`로 math/coding/ocr 단어 빈도를 세어 최다 득점 선택). 임베딩 유사도 검색도, LLM 분류기도 없습니다 — 가볍고 결정적(deterministic)이지만 그만큼 거칩니다(예: "이 함수의 방정식을 풀어줘"는 coding·math 동점). 멀티모달(audio/video)과 초장문(longcontext)만 키워드 이전에 우선 판정됩니다.

---

## Cleanup

```bash
cdk destroy --all --force
```

- EKS Auto Mode 삭제에 ~15분이 걸립니다.
- S3 model-cache bucket은 RETAIN 정책으로 가중치가 보존됩니다.

---

## Related

- [vLLM 문서](https://docs.vllm.ai)
- [Higress 문서](https://higress.cn/en/docs/latest/overview/what-is-higress/)
- [Amazon EKS Auto Mode](https://docs.aws.amazon.com/eks/latest/userguide/automode.html)
- [Claude Code — LLM Gateway 설정](https://code.claude.com/docs/en/llm-gateway)
