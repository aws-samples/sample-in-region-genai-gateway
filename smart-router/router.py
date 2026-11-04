"""
Smart Router — In-Region GenAI Gateway
Routes `general` alias requests to the best scenario alias based on
content analysis (MIME type > text rules > default=coding).

Architecture:
  Client → (general) → SmartRouter → Higress gateway (scenario alias: coding/math/video/...)
  Client → (coding/math/...) → SmartRouter passes the alias through to the gateway
"""
import asyncio
import json
import os
import re
import httpx
import logging
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("smart-router")

app = FastAPI(title="In-Region Smart Router")

# Upstream gateway base URL — the Higress AI Gateway's internal NLB on 443.
# e.g. https://internal-nlb:443
GATEWAY_BASE = os.environ.get("GATEWAY_BASE_URL", "").rstrip("/")

# TLS verification for the upstream gateway endpoint. Defaults to enabled (secure).
# Set VERIFY_TLS=false ONLY for internal VPC traffic terminating on a self-signed
# certificate (e.g. an internal ALB without an ACM-issued public cert), where the
# network path is already constrained to the VPC CIDR by security groups.
VERIFY_TLS = os.environ.get("VERIFY_TLS", "true").lower() not in ("false", "0", "no")

# Down-convert modern Anthropic Messages payloads so legacy backends accept them.
# Claude Code 2.x (verified against claude-cli/2.1.167) sends fields that the
# in-region (Seoul) Bedrock fallback — Claude 3.5 Sonnet 2024-06-20 — rejects with
# "Malformed input request", which silently kills the vLLM→Bedrock fallback. The
# self-hosted vLLM models are OpenAI-compatible and don't use these fields either,
# so stripping unconditionally is lossless on both the warm (vLLM) and cold
# (Bedrock) paths. Set STRIP_LEGACY_FIELDS=false to disable (e.g. once the Bedrock
# fallback target is a Claude 4.x model that supports them natively).
STRIP_LEGACY_FIELDS = os.environ.get("STRIP_LEGACY_FIELDS", "true").lower() not in ("false", "0", "no")
# Top-level keys 2.x adds that Bedrock Claude 3.5 v1 rejects (invalid enum /
# extraneous key). `thinking:{type:adaptive}`, context management edits, output cfg.
_LEGACY_TOP_LEVEL_FIELDS = ("thinking", "context_management", "output_config")

# ── Bedrock-direct fallback (gateway bypass) ────────────────────────────────────
# The gateway (Higress) translates Anthropic /v1/messages → vLLM natively, but its
# ai-proxy 2.0.0 Bedrock path mis-signs SigV4 for /v1/messages (it double-translates
# Anthropic→OpenAI-Chat→Bedrock-Converse — see higress#3809). So when the warm vLLM
# alias is unavailable (cold start = NLB has zero healthy targets → connection error;
# or a 4xx/5xx from the gateway, e.g. context-window overflow), we bypass the gateway
# entirely and call Bedrock's NATIVE Anthropic Messages endpoint directly via boto3.
# Bedrock accepts the Anthropic Messages body verbatim (model stripped, anthropic_version
# added) and returns native Anthropic JSON / streaming events — verified against
# claude-3-5-sonnet-20240620 incl. tool_use + streaming. Credentials come from the ECS
# task role's standard chain (no static keys). Only the /v1/messages path falls back —
# /v1/chat/completions is left to the gateway (no native Bedrock Anthropic equivalent).
BEDROCK_FALLBACK_MODEL_ID = os.environ.get("BEDROCK_FALLBACK_MODEL_ID", "")
# Secondary fallback model for a cascading in-region fallback. When the primary on-demand
# target is momentarily saturated and answers `ServiceUnavailableException: Too many
# connections` (a transient SERVER-side capacity throttle, distinct from the RPM quota —
# verified: account RPM use ~4/min « the 50/min quota, yet the throttle still fires), the
# router transparently retries on this secondary model. The two fallback models (Haiku 3
# primary, Sonnet 3.5 secondary — see config/models.ts) have SEPARATE on-demand capacity
# pools (RPM quotas 400 vs 50 — an 8× difference), so when one is saturated the other often
# has headroom. Primary is Haiku because the Seoul Sonnet 3.5 pool is heavily throttled
# (~93% vs Haiku ~43%, measured 2026-06-14): with Sonnet primary a cold Claude Code request
# spent 16–93 s (sometimes timing out) on retry backoff; with Haiku primary, 4–6 s, 5/5.
# This trades answer quality for availability — exactly the cold-start use case: give a
# best-effort in-region answer NOW while the warm vLLM model spins up, rather than failing.
# Both are Seoul IN_REGION on-demand (data residency). Empty → no cascade (primary only).
BEDROCK_FALLBACK_MODEL_ID_SECONDARY = os.environ.get("BEDROCK_FALLBACK_MODEL_ID_SECONDARY", "")
BEDROCK_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "")
FALLBACK_ENABLED = bool(BEDROCK_FALLBACK_MODEL_ID)
# Gateway response codes that should trigger the Bedrock-direct fallback. 4xx covers
# context-window overflow (the case the previous gateway could not handle); 5xx covers a cold/sick
# vLLM upstream surfaced by the gateway as a server error (the overflow case the
# previous gateway could not handle). 2xx/3xx pass through.
_FALLBACK_STATUS_MIN = 400
_ANTHROPIC_VERSION = "bedrock-2023-05-31"

# ── Cold-vLLM pre-flight (skip the gateway when the target alias is scaled to zero) ──
# When a vLLM alias is scaled to zero, its internal NLB still exists but has zero
# healthy targets. Routing such a request THROUGH the gateway (Higress) makes Envoy
# hang ~40s on the dead upstream before surfacing a 503 — only THEN would the reactive
# fallback above kick in, so a cold request costs ~41s end-to-end. To make the cold
# path fast, the router probes the alias's vLLM NLB /health DIRECTLY (the same in-VPC
# path the gateway uses to reach vLLM) with a short timeout BEFORE calling the gateway:
#   cold (connection refused/timeout, or non-200) → bypass the gateway, go straight to
#                                                    the Bedrock-direct fallback (~2s)
#   warm (HTTP 200)                               → flow through the gateway normally
#                                                    (its 600s read timeout is preserved
#                                                     for long agentic generations)
#   no endpoint mapped for the alias              → skip the probe, use the gateway
# The reactive fallback (gateway connection error / >= 400) is kept as a safety net.
# Disabled automatically when VLLM_ENDPOINTS is empty (e.g. the public-repo default) or
# explicitly via PREFLIGHT_VLLM_HEALTH=false.
try:
    VLLM_ENDPOINTS = json.loads(os.environ.get("VLLM_ENDPOINTS", "") or "{}")
    if not isinstance(VLLM_ENDPOINTS, dict):
        VLLM_ENDPOINTS = {}
except (ValueError, TypeError):
    VLLM_ENDPOINTS = {}
PREFLIGHT_VLLM_HEALTH = (
    os.environ.get("PREFLIGHT_VLLM_HEALTH", "true").lower() not in ("false", "0", "no")
    and bool(VLLM_ENDPOINTS)
)
_PREFLIGHT_TIMEOUT = httpx.Timeout(float(os.environ.get("PREFLIGHT_TIMEOUT", "2.0")))

# ── warm vLLM max_tokens clamp ──────────────────────────────────────────────────
# vLLM enforces `input_tokens + max_tokens <= maxModelLen` STRICTLY: a request that
# overshoots is rejected with HTTP 400 (`This model's maximum context length is N
# tokens. However, you requested M output tokens and your prompt contains K input
# tokens, for a total of M+K`). Claude Code sends a large fixed `max_tokens` (observed
# 32000) on every turn — which exceeds the maxModelLen of the smaller scenario models
# (e.g. coding=Qwen3.5-27B maxModelLen 32768: 32000 out + ~769 in = 32769 > 32768).
# So a WARM alias 400s the request, the reactive safety-net falls back to Bedrock, and
# the user sees a Bedrock answer (Haiku) even though the GPU is up — the warm path is
# silently bypassed. (Bedrock itself clamps max_tokens leniently, which is why the cold
# path never surfaced this.) To keep warm requests ON vLLM, clamp max_tokens to fit the
# target alias's context window BEFORE the gateway POST:
#     max_tokens = min(requested, maxModelLen - INPUT_RESERVE)
# INPUT_RESERVE is a conservative fixed headroom for the input prompt (avoids depending
# on a tokenizer to count input tokens precisely). The common case Claude Code hits is a
# short prompt + a huge max_tokens, which this fixes; a genuinely long prompt that still
# overflows (rare, and worst on small-window models like ocr=8192) falls through to the
# reactive Bedrock fallback as before (the safety net is preserved). The clamp is applied
# to the body that is sent on BOTH the warm (vLLM) and any subsequent Bedrock-fallback
# path — a smaller max_tokens is harmless to Bedrock, so a single common clamp is simplest
# and safe. Disabled (no-op) for any alias not present in the VLLM_MAX_MODEL_LEN map.
try:
    VLLM_MAX_MODEL_LEN = json.loads(os.environ.get("VLLM_MAX_MODEL_LEN", "") or "{}")
    if not isinstance(VLLM_MAX_MODEL_LEN, dict):
        VLLM_MAX_MODEL_LEN = {}
except (ValueError, TypeError):
    VLLM_MAX_MODEL_LEN = {}
# Fixed headroom reserved for the input prompt (+ safety margin) when clamping. The clamp
# floor keeps a usable output budget even on small-window models. Tunable via env.
_VLLM_INPUT_TOKEN_RESERVE = int(os.environ.get("VLLM_INPUT_TOKEN_RESERVE", "8192"))
# Never clamp below this — guarantees a minimally useful generation even if the reserve
# would otherwise eat the whole window (e.g. ocr maxModelLen 8192 - reserve 8192 = 0).
_VLLM_MIN_OUTPUT_TOKENS = int(os.environ.get("VLLM_MIN_OUTPUT_TOKENS", "1024"))

# ── warm vLLM max_tokens clamp — STAGE 2: ITERATIVE re-clamp on a context-overflow 400 ──
# The preemptive clamp above (_clamp_max_tokens) uses a FIXED input reserve (8192) — a guess.
# When the real input prompt EXCEEDS that reserve (Claude Code's system prompt + tools +
# accumulated multi-turn context routinely lands at 8k–24k+), `input + clamped_output` STILL
# overflows the window, the warm alias 400s, and the request silently falls back to Bedrock
# (Haiku) even though the GPU is warm. Tuning the reserve up is just a bigger guess that breaks
# at the next input size.
#
# ⚠️ WHY WE DON'T TRUST THE 400 BODY'S INPUT COUNT (measured 2026-06-14, live): vLLM's 400
# says "your prompt contains at least N input tokens (parameter=input_tokens, value=N)", but N
# is NOT the measured input — it is the LOWER BOUND `window - requested_max_tokens + 1`. Proof:
# a 16k-token AND a 22k-token prompt BOTH reported `value=8193` when max_tokens was clamped to
# 24576 (8193 = 32768 - 24576 + 1); re-clamping to `window - 8193 - margin` and retrying ONCE
# still 400'd because the true input far exceeded 8193. (The original incident's "769" was
# likewise 32768 - 32000 + 1, not the real input — it only looked like ground truth because the
# real input happened to be small.) So a single precise re-clamp from the reported value is
# impossible — the value carries no usable input information.
#
# THE PRINCIPLED FIX — iterative halving, tokenizer-free: on a context-overflow 400, HALVE
# max_tokens and retry the gateway; repeat until it succeeds or hits the output floor. Each
# 400 is a fast validation reject (~50ms, no generation), so a few retries cost <300ms. A
# failed attempt at max_tokens=M proves `input > window - M`, so halving monotonically opens
# room for the input until `input + max_tokens <= window` holds — for ANY input that can
# physically fit, with no tokenizer and no reliance on the unreliable reported count. Only an
# input so large that even the floor output won't fit (input ≈ window — rare, worst on small
# models like ocr=8192) falls through to the Bedrock safety net. The preemptive clamp stays as
# a cheap first-stage filter for the common short-prompt + huge-max_tokens case (no round-trip);
# the iterative retry is the correctness guarantee for everything the guess misses.
# Disable via VLLM_RECLAMP_RETRY=false; bound the loop with VLLM_RECLAMP_MAX_RETRIES.
VLLM_RECLAMP_RETRY = os.environ.get("VLLM_RECLAMP_RETRY", "true").lower() not in ("false", "0", "no")
# Max gateway retries on repeated context-overflow 400s. Halving 24576 down to the 1024 floor
# is ~5 steps, so 6 reaches the floor with headroom; each step is a ~50ms validation reject.
_VLLM_RECLAMP_MAX_RETRIES = int(os.environ.get("VLLM_RECLAMP_MAX_RETRIES", "6"))
# A context-overflow 400 is identified by these phrases (vLLM / OpenAI-serving wording). Kept
# deliberately broad across the "context length" / "input tokens" variants so the retry fires
# regardless of the exact value shape — but specific enough that a NON-overflow 400 (malformed
# body, auth, bad tool schema, etc.) does NOT match → no retry → straight to Bedrock as before.
_VLLM_OVERFLOW_RE = re.compile(
    r"maximum context length|context length is|input tokens|reduce the length|"
    r"please reduce the length of (?:the )?messages",
    re.IGNORECASE,
)


def _is_context_overflow(text: str) -> bool:
    """True if a gateway 400 body is a vLLM context-length overflow (worth a re-clamp retry)."""
    return bool(text) and bool(_VLLM_OVERFLOW_RE.search(text))


def _halve_max_tokens(current: int) -> int:
    """Next max_tokens for an iterative re-clamp: half of current, floored. Returns 0 when it
    cannot be reduced any further (already at/below the floor) — caller then gives up to Bedrock.
    """
    nxt = current // 2
    if nxt < _VLLM_MIN_OUTPUT_TOKENS:
        nxt = _VLLM_MIN_OUTPUT_TOKENS
    return nxt if nxt < current else 0

# ── Bedrock-direct fallback: throttle resilience ────────────────────────────────
# Under a concurrent agentic burst (Claude Code fires many parallel sub-requests),
# the cold path funnels them all at the single on-demand Bedrock target, which can
# answer with a transient `ServiceUnavailableException: Too many connections`. The
# default botocore "standard" retry mode then backs off internally; on the STREAMING
# path that backoff happens INSIDE invoke_model_with_response_stream — before the first
# SSE byte — so the router emits zero bytes for the duration and the fronting ALB fires
# a 504 once its (60s) idle timeout elapses. Three independent guards harden this:
#   1. `adaptive` retry mode — client-side rate-limiting that smooths a throttle storm
#      instead of hammering with fixed backoff (set max_attempts a bit higher than the
#      standard 4 so a brief throttle is ridden out rather than surfaced).
#   2. a bounded concurrency Semaphore (below) — serializes the burst so we never open
#      more simultaneous Bedrock connections than the on-demand target tolerates.
#   3. streaming keepalive (_bedrock_fallback) — emits SSE pings while the first byte is
#      pending so the ALB idle timer never fires, regardless of throttle/slow-start.
_BEDROCK_MAX_ATTEMPTS = int(os.environ.get("BEDROCK_MAX_ATTEMPTS", "8"))
# Cap on simultaneous in-flight Bedrock-direct calls. Keep small: the on-demand target's
# "Too many connections" ceiling is low, and serializing a burst is cheaper than letting
# all of it throttle-and-retry. Built lazily (needs a running loop).
_BEDROCK_MAX_CONCURRENCY = int(os.environ.get("BEDROCK_MAX_CONCURRENCY", "3"))
# Seconds between SSE keepalive frames while the first Bedrock event is still pending.
# Must be comfortably below the ALB idle timeout (60s default) so the idle timer resets.
_BEDROCK_KEEPALIVE_SECS = float(os.environ.get("BEDROCK_KEEPALIVE_SECS", "10"))

# ── Fault injection (TEST ONLY — default OFF) ────────────────────────────────────
# A real transient `Too many connections` throttle cannot be forced on demand (it's
# server-side, load/timing dependent), so the Sonnet 3.5 → Haiku 3 cascade is otherwise
# only exercisable by chance under a burst. When BEDROCK_FAULT_INJECTION is enabled, a
# request carrying the `x-genai-gw-test-throttle-primary` header makes the router raise a
# SYNTHETIC throttle on the primary model — shaped exactly like the real Bedrock
# ServiceUnavailableException so it flows through the SAME _is_throttle classifier and
# cascade path — forcing a deterministic, live cascade to the secondary (Haiku 3). The
# secondary attempt is a REAL Bedrock call, so a passing test proves the end-to-end cascade.
# This is gated behind an env flag that defaults OFF: on a production deploy the header is
# ignored entirely (no test surface). Enable only for the system-test harness's S-cascade.
BEDROCK_FAULT_INJECTION = os.environ.get("BEDROCK_FAULT_INJECTION", "false").lower() in ("true", "1", "yes")
# Request header that triggers the synthetic primary throttle (only honored when the env
# flag above is set). Value "1"/"true"/"yes" → primary (chain index 0) raises a synthetic
# ServiceUnavailableException, cascading to the secondary.
_FAULT_THROTTLE_HEADER = "x-genai-gw-test-throttle-primary"
if BEDROCK_FAULT_INJECTION:
    logger.warning(
        "BEDROCK_FAULT_INJECTION is ENABLED — requests with the "
        f"'{_FAULT_THROTTLE_HEADER}' header will force a synthetic primary throttle. "
        "This is a TEST-ONLY surface; disable on production deploys."
    )

_bedrock_runtime = None
_bedrock_semaphore = None


def _get_bedrock_semaphore() -> "asyncio.Semaphore":
    """Lazily build the fallback concurrency limiter (bound to the running loop)."""
    global _bedrock_semaphore
    if _bedrock_semaphore is None:
        _bedrock_semaphore = asyncio.Semaphore(_BEDROCK_MAX_CONCURRENCY)
    return _bedrock_semaphore


def _get_bedrock_client():
    """Lazily build a boto3 bedrock-runtime client (task-role credential chain).

    `adaptive` retries + a connection pool sized to the concurrency cap make the client
    resilient to the transient `Too many connections` throttle (see the throttle-resilience
    note above). read_timeout is generous (long agentic generations); connect_timeout is
    short so a genuinely unreachable endpoint fails fast.
    """
    global _bedrock_runtime
    if _bedrock_runtime is None:
        import boto3  # imported lazily so the module loads even without the dep
        from botocore.config import Config

        _bedrock_runtime = boto3.client(
            "bedrock-runtime",
            region_name=BEDROCK_REGION or None,
            config=Config(
                retries={"mode": "adaptive", "max_attempts": _BEDROCK_MAX_ATTEMPTS},
                connect_timeout=10,
                read_timeout=600,
                max_pool_connections=max(10, _BEDROCK_MAX_CONCURRENCY * 2),
            ),
        )
    return _bedrock_runtime


def _to_bedrock_body(body: dict) -> str:
    """Convert an (already sanitized) Anthropic Messages body to a Bedrock invoke body.

    Bedrock's native Anthropic endpoint takes the same body with `model` removed and
    `anthropic_version` set to the Bedrock value. `stream` is a transport concern, not a
    body field on Bedrock, so it is stripped here. Everything else (system, tools,
    tool_choice, messages, max_tokens) is accepted verbatim.
    """
    out = {k: v for k, v in body.items() if k not in ("model", "stream", "anthropic_version")}
    out["anthropic_version"] = _ANTHROPIC_VERSION
    out.setdefault("max_tokens", 4096)
    return json.dumps(out)


# Botocore error codes that mean "this on-demand model pool is momentarily saturated" —
# transient and worth retrying on the SECONDARY model (which has a separate pool). The
# `Too many connections` capacity throttle surfaces as ServiceUnavailableException; the
# RPM-quota limiter surfaces as ThrottlingException. Both are retryable on a different pool.
_THROTTLE_ERROR_CODES = ("ServiceUnavailableException", "ThrottlingException", "TooManyRequestsException")


def _is_throttle(exc: Exception) -> bool:
    """True if exc is a transient Bedrock capacity/throttle error (retry on secondary)."""
    code = getattr(exc, "response", {}).get("Error", {}).get("Code") if hasattr(exc, "response") else None
    return code in _THROTTLE_ERROR_CODES or type(exc).__name__ in _THROTTLE_ERROR_CODES


def _synthetic_throttle(model_id: str) -> Exception:
    """Build a synthetic throttle exception identical in shape to a real Bedrock one.

    TEST-ONLY (see BEDROCK_FAULT_INJECTION). Returns a botocore ClientError whose
    Error.Code is `ServiceUnavailableException` — the exact wire shape Bedrock raises on a
    `Too many connections` capacity throttle — so it is classified by the SAME _is_throttle
    path and drives the SAME cascade as a real throttle. We do not special-case the synthetic
    error anywhere; it is indistinguishable to the cascade logic from the real one.
    """
    try:
        from botocore.exceptions import ClientError
        return ClientError(
            {"Error": {"Code": "ServiceUnavailableException",
                       "Message": "Too many connections, please wait before trying again. "
                                  "(synthetic — BEDROCK_FAULT_INJECTION)"}},
            operation_name="InvokeModel",
        )
    except Exception:  # botocore missing (shouldn't happen) — fall back to a named class
        exc = Exception("synthetic ServiceUnavailableException")
        exc.__class__.__name__ = "ServiceUnavailableException"  # type: ignore[attr-defined]
        return exc


def _fallback_model_chain() -> list:
    """Ordered list of Bedrock model IDs to try: primary, then secondary if configured.

    The secondary is attempted ONLY when the primary fails with a transient throttle (see
    _is_throttle) — a cascading in-region fallback for the cold-start best-effort path.
    """
    chain = [BEDROCK_FALLBACK_MODEL_ID]
    if BEDROCK_FALLBACK_MODEL_ID_SECONDARY:
        chain.append(BEDROCK_FALLBACK_MODEL_ID_SECONDARY)
    return chain


async def _bedrock_fallback(body: dict, is_stream: bool, fault_throttle_primary: bool = False) -> Response:
    """Call Bedrock's native Anthropic endpoint directly and adapt to FastAPI.

    `fault_throttle_primary` is TEST-ONLY (see BEDROCK_FAULT_INJECTION): when set, the
    primary model (chain index 0) raises a synthetic throttle instead of calling Bedrock,
    deterministically forcing the cascade to the secondary so S-cascade can verify the real
    end-to-end cascade live. It is always False on a production deploy (env flag defaults OFF).

    boto3 is synchronous; run the blocking call in a thread so the event loop is not
    starved. For streaming, each chunk's bytes are already a native Anthropic event
    (message_start / content_block_delta / ...) — re-emit them as Anthropic SSE frames
    (`event:` + `data:`) exactly as Claude Code expects.

    A bounded Semaphore serializes concurrent fallbacks so an agentic burst never opens
    more simultaneous Bedrock connections than the on-demand target tolerates (avoids the
    `Too many connections` throttle at the source). On the streaming path, the generator
    emits SSE keepalive pings while the first Bedrock event is still pending — so the
    fronting ALB's idle timer never elapses during a slow start or an internal retry
    backoff (the original 504-after-60s churn). See the throttle-resilience note above.

    When a secondary model is configured, a transient throttle on the primary cascades to
    the secondary (separate on-demand pool) — best-effort in-region availability for the
    cold-start path (see BEDROCK_FALLBACK_MODEL_ID_SECONDARY).
    """
    invoke_body = _to_bedrock_body(body)
    client = _get_bedrock_client()
    sem = _get_bedrock_semaphore()
    chain = _fallback_model_chain()
    logger.info(
        f"vLLM upstream unavailable → Bedrock-direct fallback "
        f"(models={chain}, stream={is_stream})"
    )

    if not is_stream:
        async with sem:
            last_exc = None
            for idx, model_id in enumerate(chain):
                try:
                    # TEST-ONLY: force a synthetic throttle on the primary so the cascade
                    # to the secondary is deterministic and live-verifiable (env-gated OFF).
                    if fault_throttle_primary and idx == 0:
                        raise _synthetic_throttle(model_id)
                    resp = await asyncio.to_thread(
                        client.invoke_model,
                        modelId=model_id,
                        body=invoke_body,
                    )
                    payload = resp["body"].read()  # native Anthropic Message JSON
                    if idx > 0:
                        logger.warning(f"primary throttled → answered via secondary {model_id}")
                    return Response(
                        content=payload,
                        status_code=200,
                        media_type="application/json",
                        headers={"x-genai-gw-fallback": "bedrock-direct", "x-genai-gw-fallback-model": model_id},
                    )
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
                    # Cascade to the secondary model ONLY on a transient throttle; any other
                    # error (malformed request, etc.) is terminal and re-raised below.
                    if _is_throttle(exc) and idx + 1 < len(chain):
                        logger.warning(f"{model_id} throttled ({type(exc).__name__}) → cascading to {chain[idx+1]}")
                        continue
                    raise
            raise last_exc

    # Streaming: boto3 EventStream → Anthropic SSE. We materialize the synchronous
    # EventStream into queued SSE frames on a worker thread, then drain them async.
    queue: "asyncio.Queue[bytes | None]" = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def _pump():
        try:
            # Cascade across the model chain: on a transient throttle from one model, retry
            # the next. The cascade happens BEFORE any frame is queued for a given attempt,
            # so a throttled primary never leaks a partial stream — we only start emitting a
            # model's events once its EventStream opens successfully.
            last_exc = None
            for idx, model_id in enumerate(chain):
                try:
                    # TEST-ONLY: force a synthetic throttle on the primary (env-gated OFF)
                    # so the streaming cascade to the secondary is deterministic. Raised
                    # BEFORE any frame is queued → no partial-stream leak from the primary.
                    if fault_throttle_primary and idx == 0:
                        raise _synthetic_throttle(model_id)
                    resp = client.invoke_model_with_response_stream(
                        modelId=model_id,
                        body=invoke_body,
                    )
                    if idx > 0:
                        logger.warning(f"primary throttled → streaming via secondary {model_id}")
                    for ev in resp["body"]:
                        chunk = ev.get("chunk")
                        if not chunk:
                            continue
                        raw = chunk["bytes"]  # native Anthropic event JSON
                        evt = json.loads(raw).get("type", "message")
                        frame = f"event: {evt}\n".encode() + b"data: " + raw + b"\n\n"
                        loop.call_soon_threadsafe(queue.put_nowait, frame)
                    return  # stream completed cleanly
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
                    if _is_throttle(exc) and idx + 1 < len(chain):
                        logger.warning(f"{model_id} throttled ({type(exc).__name__}) → cascading stream to {chain[idx+1]}")
                        continue
                    raise
            if last_exc:
                raise last_exc
        except Exception as exc:  # surface as an Anthropic-style error SSE frame
            logger.exception("Bedrock-direct streaming fallback failed")
            err = json.dumps(
                {"type": "error", "error": {"type": "api_error", "message": str(exc)}}
            ).encode()
            loop.call_soon_threadsafe(
                queue.put_nowait, b"event: error\n" + b"data: " + err + b"\n\n"
            )
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    async def stream_gen():
        # Acquire the concurrency slot WITH keepalives: under a burst that exceeds the cap,
        # a request can wait here for a slot — emit SSE pings while waiting so a queued
        # request never goes silent long enough to trip the ALB idle timeout. (wait_for
        # cancels the pending acquire() cleanly on timeout in Python 3.12, no permit leak.)
        while True:
            try:
                await asyncio.wait_for(sem.acquire(), timeout=_BEDROCK_KEEPALIVE_SECS)
                break
            except asyncio.TimeoutError:
                yield b": keepalive\n\n"
        try:
            # Kick the blocking EventStream pump onto a worker thread WITHOUT awaiting it,
            # so frames flow out of the queue as they are produced (true streaming).
            loop.run_in_executor(None, _pump)
            while True:
                try:
                    # Wait for the next real frame, but wake every keepalive interval to
                    # emit an SSE comment ping. Bedrock can take tens of seconds before the
                    # first event under load (or while botocore retries a throttle inside
                    # invoke_model_with_response_stream) — these pings keep bytes flowing so
                    # the ALB idle timeout (60s) never trips a 504. SSE comment lines
                    # (`: ...`) are ignored by Anthropic SSE clients, so they're invisible
                    # to Claude Code.
                    frame = await asyncio.wait_for(queue.get(), timeout=_BEDROCK_KEEPALIVE_SECS)
                except asyncio.TimeoutError:
                    yield b": keepalive\n\n"
                    continue
                if frame is None:
                    break
                yield frame
        finally:
            sem.release()

    return StreamingResponse(
        stream_gen(),
        media_type="text/event-stream",
        headers={"x-genai-gw-fallback": "bedrock-direct"},
    )

# ── Scenario detection ────────────────────────────────────────────────────────

# Keywords that strongly suggest math/reasoning tasks
_MATH_PATTERNS = re.compile(
    r"\b(방정식|적분|미분|행렬|증명|수열|확률|통계|편미분|최적화|"
    r"equation|integral|derivative|matrix|proof|sequence|probability|"
    r"statistics|optimization|theorem|calculate|compute|solve)\b",
    re.IGNORECASE,
)

# Keywords that suggest coding tasks
_CODE_PATTERNS = re.compile(
    r"\b(함수|코드|구현|알고리즘|디버그|클래스|모듈|API|SDK|리팩터|테스트|"
    r"function|implement|algorithm|debug|class|module|refactor|test|"
    r"code|script|program|bug|error|exception|deploy|build|compile)\b",
    re.IGNORECASE,
)

# Keywords that suggest OCR / document tasks
_OCR_PATTERNS = re.compile(
    r"\b(도면|설계도|청사진|문서|OCR|텍스트 추출|표 인식|"
    r"drawing|blueprint|document|diagram|extract text|table recognition)\b",
    re.IGNORECASE,
)

LONG_CONTEXT_CHARS = 60_000  # ~16K tokens — route to longcontext model


def _has_audio(content: list) -> bool:
    for block in content:
        if isinstance(block, dict):
            src = block.get("source", {})
            mt = src.get("media_type", "")
            if mt.startswith("audio/"):
                return True
    return False


def _has_video(content: list) -> bool:
    for block in content:
        if isinstance(block, dict):
            src = block.get("source", {})
            mt = src.get("media_type", "")
            if mt.startswith("video/"):
                return True
            # Anthropic video block type
            if block.get("type") == "video":
                return True
    return False


def _extract_text(messages: list) -> str:
    parts = []
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
    return " ".join(parts)


def _all_content_blocks(messages: list) -> list:
    blocks = []
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, list):
            blocks.extend(content)
    return blocks


def detect_scenario(body: dict) -> str:
    messages = body.get("messages", [])
    blocks = _all_content_blocks(messages)

    # Multimodal signals are definitive
    if _has_audio(blocks):
        return "audio"
    if _has_video(blocks):
        return "video"

    text = _extract_text(messages)

    # Long document → longcontext
    if len(text) > LONG_CONTEXT_CHARS:
        return "longcontext"

    # Count signal strength for math vs coding vs ocr
    math_score = len(_MATH_PATTERNS.findall(text))
    code_score = len(_CODE_PATTERNS.findall(text))
    ocr_score = len(_OCR_PATTERNS.findall(text))

    scores = {"math": math_score, "coding": code_score, "ocr": ocr_score}
    best = max(scores, key=scores.get)

    if scores[best] > 0:
        return best

    # Default: coding (Qwen3.5-27B — best general-purpose)
    return "coding"


# ── Proxy helpers ─────────────────────────────────────────────────────────────

_TIMEOUT = httpx.Timeout(600.0, connect=10.0)
# TLS verification is on by default; disabled only when VERIFY_TLS=false is set for
# internal VPC traffic terminating on a self-signed certificate (see VERIFY_TLS above).
if not VERIFY_TLS:
    logger.warning(
        "TLS certificate verification is DISABLED (VERIFY_TLS=false). "
        "Only use this for internal VPC traffic with a self-signed upstream certificate."
    )
_CLIENT = httpx.AsyncClient(timeout=_TIMEOUT, verify=VERIFY_TLS)


async def _vllm_alias_is_warm(scenario: str) -> bool:
    """Probe the scenario alias's vLLM NLB /health directly with a short timeout.

    Returns True only when the alias is mapped AND its vLLM NLB answers /health with a
    2xx quickly. A cold alias (scaled to zero) has zero healthy NLB targets, so the probe
    fails fast (connection refused/reset or timeout) and we return False → the caller skips
    the gateway and goes straight to the Bedrock-direct fallback, turning a ~41s cold hang
    into ~2s. The vLLM endpoints are plain http on :8000 (internal NLB), so this probe does
    not depend on the gateway's TLS. Any unexpected error is treated as "not warm" but the
    request still has the reactive gateway fallback as a backstop.
    """
    base = VLLM_ENDPOINTS.get(scenario)
    if not base:
        return False  # alias not mapped → caller falls through to the gateway
    try:
        resp = await _CLIENT.get(f"{base.rstrip('/')}/health", timeout=_PREFLIGHT_TIMEOUT)
        return resp.status_code < 400
    except Exception as exc:  # noqa: BLE001 — connection refused/timeout = cold, expected
        logger.info(f"vLLM pre-flight: alias '{scenario}' cold ({exc!r})")
        return False


def _strip_cache_control(obj):
    """Recursively remove `cache_control` blocks (prompt caching) in place.

    Bedrock Claude 3.5 Sonnet 2024-06-20 returns "did not allow prompt caching"
    when cache_control is present. Claude Code attaches it to system blocks and
    large message content blocks. vLLM ignores it. Safe to drop on both paths.
    """
    if isinstance(obj, dict):
        obj.pop("cache_control", None)
        for v in obj.values():
            _strip_cache_control(v)
    elif isinstance(obj, list):
        for v in obj:
            _strip_cache_control(v)


def _sanitize_for_legacy_backend(body: dict) -> dict:
    """Down-convert a modern Anthropic Messages body for legacy backends.

    Verified minimal transform (against claude-cli/2.1.167 + Bedrock Claude 3.5
    Sonnet 2024-06-20) that turns a 400 "Malformed input request" into 200:
      1. drop top-level thinking / context_management / output_config
      2. convert mid-conversation messages[].role == "system" -> "user"
         (Bedrock allows only user/assistant in the messages array; the real
         system prompt already rides as the top-level `system` param)
      3. recursively strip cache_control (prompt caching unsupported)
    Top-level system / tools / metadata are kept — Bedrock accepts them.
    Returns the same dict (mutated in place) for convenience.
    """
    if not STRIP_LEGACY_FIELDS:
        return body
    for field in _LEGACY_TOP_LEVEL_FIELDS:
        body.pop(field, None)
    for msg in body.get("messages", []):
        if isinstance(msg, dict) and msg.get("role") == "system":
            msg["role"] = "user"
    _strip_cache_control(body)
    return body


def _rewrite_body(body: dict, scenario: str) -> dict:
    """Replace model field with detected scenario alias."""
    rewritten = dict(body)
    rewritten["model"] = scenario
    return rewritten


def _clamp_max_tokens(body: dict, scenario: str) -> dict:
    """Clamp body['max_tokens'] to fit the target alias's vLLM context window.

    vLLM rejects (HTTP 400) any request where input_tokens + max_tokens exceeds the
    model's maxModelLen. Claude Code sends a large fixed max_tokens (e.g. 32000) that
    overflows the smaller scenario models, so a WARM alias 400s and the request silently
    falls back to Bedrock. Clamp to `maxModelLen - INPUT_RESERVE` (floored at
    _VLLM_MIN_OUTPUT_TOKENS) so the common short-prompt + huge-max_tokens case stays on
    vLLM. No-op when the alias has no mapped maxModelLen (VLLM_MAX_MODEL_LEN empty/absent)
    or when the requested value already fits. Mutates and returns body for convenience.

    See the VLLM_MAX_MODEL_LEN note above for why a single clamp on the shared body is
    safe for the Bedrock-fallback path too (a smaller max_tokens is harmless to Bedrock).
    """
    max_len = VLLM_MAX_MODEL_LEN.get(scenario)
    if not max_len:  # alias not mapped or 0 → clamp disabled (safe no-op)
        return body
    requested = body.get("max_tokens")
    if not isinstance(requested, int):
        return body
    ceiling = max(_VLLM_MIN_OUTPUT_TOKENS, int(max_len) - _VLLM_INPUT_TOKEN_RESERVE)
    if requested > ceiling:
        body["max_tokens"] = ceiling
        logger.info(
            f"max_tokens clamped {requested}→{ceiling} "
            f"(alias={scenario}, maxModelLen={max_len}, reserve={_VLLM_INPUT_TOKEN_RESERVE})"
        )
    return body


def _gateway_retry_headers(request: Request, payload: bytes) -> dict:
    headers = dict(request.headers)
    headers.pop("host", None)
    headers.pop("content-length", None)
    headers["content-length"] = str(len(payload))
    return headers


async def _retry_with_reclamp(
    request: Request, body: dict, scenario: str, overflow_text: str, is_stream: bool
):
    """Iteratively HALVE max_tokens on a vLLM context-overflow 400 and retry the gateway.

    The warm path's first attempt 400'd; `overflow_text` is that 400 body. vLLM's reported
    input-token count is unreliable (it's `window - max_tokens + 1`, not the real input — see
    the STAGE 2 note), so we do NOT trust it. Instead we treat each 400 as "max_tokens still
    too big for this input" and halve it, retrying until the gateway accepts (input + max_tokens
    fits) or we hit the output floor. Each 400 is a fast validation reject (no generation), so a
    handful of retries cost <300ms. Returns a FastAPI Response/StreamingResponse on the first
    accepted retry, or None when: the 400 isn't a context overflow, max_tokens is missing/can't
    be reduced, or every retry down to the floor still 400s (input ≈ window) — in which case the
    caller falls through to the Bedrock-direct safety net as before.

    `url`/`params` are rebuilt per attempt; only max_tokens changes between attempts.
    """
    if not VLLM_RECLAMP_RETRY:
        return None
    if not _is_context_overflow(overflow_text):
        return None  # non-overflow 400 (malformed/auth/etc.) → defer to Bedrock, no retry
    current = body.get("max_tokens")
    if not isinstance(current, int):
        return None  # nothing to clamp → Bedrock
    url = f"{GATEWAY_BASE}{request.url.path}"
    params = dict(request.query_params)

    for attempt in range(1, _VLLM_RECLAMP_MAX_RETRIES + 1):
        nxt = _halve_max_tokens(current)
        if nxt == 0:
            logger.warning(
                f"re-clamp hit output floor ({_VLLM_MIN_OUTPUT_TOKENS}) and still overflowed "
                f"(alias={scenario}) → Bedrock-direct fallback"
            )
            return None  # input ≈ window — only Bedrock's lenient clamp can take it
        retry_body = dict(body)
        retry_body["max_tokens"] = nxt
        payload = json.dumps(retry_body).encode()
        headers = _gateway_retry_headers(request, payload)
        logger.info(
            f"vLLM 400 context overflow → re-clamp max_tokens {current}→{nxt} "
            f"(alias={scenario}, attempt {attempt}/{_VLLM_RECLAMP_MAX_RETRIES}) — retrying gateway"
        )

        if is_stream:
            try:
                req = _CLIENT.build_request("POST", url, content=payload, headers=headers, params=params)
                resp = await _CLIENT.send(req, stream=True)
            except httpx.TransportError as exc:
                logger.warning(f"re-clamp retry connection error ({exc!r}) → Bedrock-direct fallback")
                return None
            if resp.status_code < _FALLBACK_STATUS_MIN:
                async def stream_gen(r=resp):
                    try:
                        async for chunk in r.aiter_bytes():
                            yield chunk
                    finally:
                        await r.aclose()
                return StreamingResponse(stream_gen(), media_type="text/event-stream")
            # still an error — read body to decide whether to keep halving
            try:
                overflow_text = (await resp.aread()).decode("utf-8", "replace") if resp.status_code == 400 else ""
            except Exception:  # noqa: BLE001
                overflow_text = ""
            await resp.aclose()
        else:
            try:
                resp = await _CLIENT.post(url, content=payload, headers=headers, params=params)
            except httpx.TransportError as exc:
                logger.warning(f"re-clamp retry connection error ({exc!r}) → Bedrock-direct fallback")
                return None
            if resp.status_code < _FALLBACK_STATUS_MIN:
                return Response(content=resp.content, status_code=resp.status_code, headers=dict(resp.headers))
            overflow_text = resp.text if resp.status_code == 400 else ""

        # Retry still errored. Keep halving ONLY if it's still a context overflow; any other
        # 400/5xx is terminal → Bedrock. Carry `nxt` forward as the new ceiling to halve from.
        if resp.status_code != 400 or not _is_context_overflow(overflow_text):
            logger.warning(f"re-clamp retry returned {resp.status_code} (non-overflow) → Bedrock-direct fallback")
            return None
        current = nxt

    logger.warning(
        f"re-clamp exhausted {_VLLM_RECLAMP_MAX_RETRIES} retries still overflowing "
        f"(alias={scenario}) → Bedrock-direct fallback"
    )
    return None


async def _proxy(request: Request, body: dict, scenario: str, allow_fallback: bool = False) -> Response:
    """Proxy to the gateway (vLLM via Higress), with optional Bedrock-direct fallback.

    When `allow_fallback` is set (only on /v1/messages, where Bedrock has a native
    Anthropic endpoint), a connection error to the gateway (cold vLLM = zero healthy
    NLB targets) or a gateway response with status >= 400 (e.g. context-window overflow)
    triggers `_bedrock_fallback`, which bypasses the gateway and calls Bedrock directly.
    """
    # Clamp max_tokens to fit the target alias's vLLM context window BEFORE the gateway
    # POST, so a warm alias accepts a large Claude-Code max_tokens (e.g. 32000) instead of
    # 400-ing and silently falling back to Bedrock. No-op for unmapped aliases. The clamped
    # body is also what the Bedrock-fallback path uses, which is safe (see _clamp_max_tokens).
    _clamp_max_tokens(body, scenario)

    path = request.url.path
    url = f"{GATEWAY_BASE}{path}"

    headers = dict(request.headers)
    headers.pop("host", None)
    headers.pop("content-length", None)

    payload = json.dumps(body).encode()
    headers["content-length"] = str(len(payload))

    is_stream = body.get("stream", False)
    do_fallback = allow_fallback and FALLBACK_ENABLED

    # TEST-ONLY: honor the synthetic-throttle header only when fault injection is enabled
    # (env flag defaults OFF → header ignored on production deploys). Forces the primary
    # Bedrock model to throttle so the Sonnet→Haiku cascade is deterministically exercised.
    fault_throttle = (
        BEDROCK_FAULT_INJECTION
        and str(request.headers.get(_FAULT_THROTTLE_HEADER, "")).lower() in ("1", "true", "yes")
    )
    if fault_throttle:
        logger.warning(f"[fault-injection] synthetic primary throttle requested via {_FAULT_THROTTLE_HEADER}")

    # Cold-vLLM pre-flight: when the fallback is available and the target alias is mapped,
    # probe its vLLM NLB /health directly first. If it's cold (scaled to zero), skip the
    # gateway entirely and go straight to Bedrock — avoids Envoy's ~40s hang on a dead
    # upstream. Warm aliases fall through to the gateway as before; unmapped aliases (e.g.
    # an explicit Bedrock model) are never probed. The reactive fallback below still guards
    # against a gateway error on the warm path.
    if do_fallback and PREFLIGHT_VLLM_HEALTH and VLLM_ENDPOINTS.get(scenario):
        if not await _vllm_alias_is_warm(scenario):
            logger.info(f"vLLM pre-flight: '{scenario}' cold → Bedrock-direct (gateway bypassed)")
            return await _bedrock_fallback(body, is_stream=is_stream, fault_throttle_primary=fault_throttle)

    if is_stream:
        # Use send(stream=True) so we can inspect the gateway's status code BEFORE
        # streaming its body — letting us fall back on a >= 400 without leaking a
        # partial gateway error to the client.
        if do_fallback:
            try:
                req = _CLIENT.build_request(
                    "POST", url, content=payload,
                    headers=headers, params=dict(request.query_params),
                )
                resp = await _CLIENT.send(req, stream=True)
            except httpx.TransportError as exc:
                logger.warning(f"gateway connection error ({exc!r}) → Bedrock-direct fallback")
                return await _bedrock_fallback(body, is_stream=True, fault_throttle_primary=fault_throttle)
            if resp.status_code >= _FALLBACK_STATUS_MIN:
                # Read the gateway's 400 body BEFORE closing — a vLLM context-length overflow
                # names the EXACT input token count, which lets us re-clamp max_tokens precisely
                # and retry the gateway ONCE (keeps a warm alias on vLLM instead of bailing to
                # Bedrock). On a non-overflow 400 (or a failed retry) this is a no-op and we fall
                # through to the Bedrock-direct safety net exactly as before.
                overflow_text = ""
                if resp.status_code == 400:
                    try:
                        overflow_text = (await resp.aread()).decode("utf-8", "replace")
                    except Exception:  # noqa: BLE001 — body unreadable → skip retry, use fallback
                        overflow_text = ""
                await resp.aclose()
                logger.warning(f"gateway returned {resp.status_code} → re-clamp retry / Bedrock-direct fallback")
                if resp.status_code == 400:
                    retried = await _retry_with_reclamp(request, body, scenario, overflow_text, is_stream=True)
                    if retried is not None:
                        return retried
                return await _bedrock_fallback(body, is_stream=True, fault_throttle_primary=fault_throttle)

            async def stream_gen():
                try:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
                finally:
                    await resp.aclose()

            return StreamingResponse(stream_gen(), media_type="text/event-stream")

        async def stream_gen():
            async with _CLIENT.stream(
                "POST", url, content=payload,
                headers=headers, params=dict(request.query_params),
            ) as resp:
                async for chunk in resp.aiter_bytes():
                    yield chunk

        return StreamingResponse(stream_gen(), media_type="text/event-stream")
    else:
        if do_fallback:
            try:
                resp = await _CLIENT.post(
                    url, content=payload, headers=headers,
                    params=dict(request.query_params),
                )
            except httpx.TransportError as exc:
                logger.warning(f"gateway connection error ({exc!r}) → Bedrock-direct fallback")
                return await _bedrock_fallback(body, is_stream=False, fault_throttle_primary=fault_throttle)
            if resp.status_code >= _FALLBACK_STATUS_MIN:
                # vLLM context-length 400 → re-clamp max_tokens from the 400's ground-truth
                # input count and retry the gateway once before bailing to Bedrock (see the
                # streaming branch / _retry_with_reclamp). Non-overflow 400 or failed retry →
                # Bedrock-direct fallback as before. resp.content is already buffered here.
                logger.warning(f"gateway returned {resp.status_code} → re-clamp retry / Bedrock-direct fallback")
                if resp.status_code == 400:
                    overflow_text = resp.text
                    retried = await _retry_with_reclamp(request, body, scenario, overflow_text, is_stream=False)
                    if retried is not None:
                        return retried
                return await _bedrock_fallback(body, is_stream=False, fault_throttle_primary=fault_throttle)
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                headers=dict(resp.headers),
            )

        resp = await _CLIENT.post(
            url, content=payload, headers=headers,
            params=dict(request.query_params),
        )
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=dict(resp.headers),
        )


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health/liveliness")
async def health():
    return {"status": "ok"}


@app.post("/v1/messages")
async def messages(request: Request):
    body = await request.json()

    # Down-convert modern 2.x fields so a cold vLLM alias can fall back to the
    # legacy Bedrock Sonnet without a 400. Lossless for warm vLLM too. Applied
    # on every alias (general AND direct) — any of them can hit the fallback.
    _sanitize_for_legacy_backend(body)

    # /v1/messages is the Anthropic-native path → Bedrock-direct fallback is allowed
    # here (Bedrock has a native Anthropic Messages endpoint; /v1/chat/completions
    # does not, so that route never falls back).
    model = body.get("model", "")
    if model != "general":
        # Non-general aliases pass straight through to the gateway
        return await _proxy(request, body, model, allow_fallback=True)

    scenario = detect_scenario(body)
    logger.info(f"general → {scenario} (model hint: {body.get('model')})")
    return await _proxy(request, _rewrite_body(body, scenario), scenario, allow_fallback=True)


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()

    # No Bedrock-direct fallback here: Bedrock has no native OpenAI chat endpoint, and
    # adding an OpenAI<->Anthropic translation would re-introduce the very gateway
    # complexity this migration removes. /v1/chat/completions stays gateway-only.
    model = body.get("model", "")
    if model != "general":
        return await _proxy(request, body, model)

    scenario = detect_scenario(body)
    logger.info(f"general → {scenario}")
    return await _proxy(request, _rewrite_body(body, scenario), scenario)


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def passthrough(request: Request, path: str):
    """All other endpoints (e.g. /v1/models) pass through to the gateway."""
    url = f"{GATEWAY_BASE}/{path}"
    headers = dict(request.headers)
    headers.pop("host", None)

    body = await request.body()
    resp = await _CLIENT.request(
        request.method, url, content=body,
        headers=headers, params=dict(request.query_params),
    )
    return Response(content=resp.content, status_code=resp.status_code, headers=dict(resp.headers))
