import { VllmModelConfig, BedrockModelConfig, BEDROCK_MODELS } from './models';

/**
 * Higress AI gateway configuration generator. Given the vLLM model lineup, the
 * Bedrock fallback models, and the per-alias NLB endpoint map, it emits provider +
 * route objects that are POST-ready for the higress-console REST API
 * (`POST /v1/ai/providers`, `POST /v1/ai/routes`) — so the applier is a thin
 * `curl -d` loop with no reshaping.
 *
 * ── Why a generator, not declarative CRDs ─────────────────────────────────────
 * Higress AI provider/route config is NOT expressible as a single user-authorable
 * CRD; the console backend compiles each route into a ConfigMap + EnvoyFilter +
 * WasmPlugin. So provider/route config is applied imperatively post-deploy against
 * the in-cluster console Service (ClusterIP higress-console.higress-system:8080).
 * This module produces exactly the request bodies that API expects.
 *
 * ── Fallback is owned by SmartRouter, NOT Higress ────────────────────────────
 * vLLM routes here carry NO cross-provider `fallbackConfig`. Higress ai-proxy 2.0.0
 * cannot sign Bedrock's `/v1/messages` (SigV4 scope error — Bedrock has no native
 * Anthropic Messages support, higress#3809), so a gateway-level vLLM→Bedrock fallback
 * hop would produce a broken Bedrock call. Instead, fallback lives in SmartRouter:
 * on a vLLM failure it calls Bedrock's native `/v1/messages` directly (boto3,
 * gateway-bypassed). Higress just surfaces the vLLM error and SmartRouter takes over.
 *
 * ── headerControl strips the consumer key before the upstream call ────────────
 * key-auth authenticates with `x-api-key` but does NOT strip it; left in place it
 * collides with the `Authorization`/SigV4 the upstream adds (Bedrock's Anthropic
 * endpoint rejects "both x-api-key and Authorization"). Every route gets
 * `headerControl.request.remove:[x-api-key]` — harmless for vLLM (ignores stray
 * keys), required for any Bedrock-bound hop. Schema confirmed by live-console probe.
 *
 * ── Shapes are LIVE-CONSOLE ground truth, not guesses ─────────────────────────
 * Every field shape below was confirmed against the running S0-PoC console
 * (all-in-one, console build 2026-05-21) by POSTing candidate bodies and reading
 * them back (2026-06-08). The non-obvious contract that this reflects:
 *  - A provider is keyed by `name` (top-level). There is no client-set `id`
 *    (the console derives `rawConfigs.id` from `name`). DELETE is by name.
 *  - All provider-type-specific config lives INSIDE `rawConfigs`:
 *      • openai  → rawConfigs.openaiCustomUrl (full chat-completions path)
 *      • bedrock → rawConfigs.{awsRegion, awsAccessKey, awsSecretKey}
 *                  (top-level aws* fields are rejected: "Missing Bedrock specific
 *                   configurations.")
 *      • the model-name rewrite → rawConfigs.modelMapping
 *  - API tokens go in the TOP-LEVEL `tokens` array (a top-level `apiTokens` is
 *    silently dropped; the console normalizes `tokens` → `rawConfigs.apiTokens`).
 *  - A route's per-alias match is `modelPredicates:[{matchType:"EQUAL",matchValue}]`;
 *    `upstreams[]` carry only {provider, weight}. The alias→upstream-model rewrite
 *    is done by the PROVIDER's modelMapping, mirroring the validated poc-route
 *    (whose upstreams carried no modelMapping).
 *  - POST is upsert-safe: re-POSTing an existing name returns 201, not a conflict,
 *    so the applier can run repeatedly (S2 still prefers GET→PUT-or-POST for
 *    cross-version robustness).
 *
 * ── Still inferred [I] → verify at S6 (S0 mock ignored model name) ────────────
 *  - Multi-alias routing actually selecting the right provider by EQUAL predicate.
 *  - PROVIDER-level modelMapping {"*": upstreamModel} actually rewriting the model
 *    before the upstream call (the S0 mock echoed any model, so the rewrite path
 *    is structurally correct but unexercised at runtime).
 */

/** Provider-type-specific config — the `rawConfigs` envelope the console requires. */
export interface HigressProviderRawConfigs {
  /** openai-only: OpenAI-compatible base — MUST include the full chat-completions path. */
  openaiCustomUrl?: string;
  /** bedrock-only: in-region (Seoul) for data residency. */
  awsRegion?: string;
  /** bedrock-only: static AK — injected at apply-time from Secrets Manager (S3). NEVER hardcode. */
  awsAccessKey?: string;
  /** bedrock-only: static SK — injected at apply-time from Secrets Manager (S3). NEVER hardcode. */
  awsSecretKey?: string;
  /**
   * Rewrites the incoming model name before the upstream call (ai-proxy semantics).
   *  - vLLM:    `{ '*': servingName }`  (any incoming model → the vLLM serving name)
   *  - Bedrock: `{ '*': bedrockModelId }`
   */
  modelMapping?: Record<string, string>;
}

/** A Higress AI provider, POST-ready for `POST /v1/ai/providers`. */
export interface HigressProvider {
  /** Stable provider name; routes reference it via `upstreams[].provider`. DELETE is by this. */
  name: string;
  /** 'openai' for vLLM (OpenAI-compatible), 'bedrock' for Amazon Bedrock. */
  type: 'openai' | 'bedrock';
  /** openai request protocol. Console defaults this; we set it explicitly for clarity. */
  protocol?: 'openai/v1';
  /** Upstream API keys (top-level). vLLM needs no real auth → a dummy keeps the field non-empty. */
  tokens?: string[];
  /** Everything type-specific. */
  rawConfigs: HigressProviderRawConfigs;
}

/** Predicate shape used by routes (path + model match). */
export interface MatchPredicate {
  matchType: 'PRE' | 'EQUAL';
  matchValue: string;
  caseSensitive?: boolean;
}

/**
 * Per-route authorization (S4 key-auth). Setting this stamps the route (and its
 * `.fallback.internal` child) into the compiled `key-auth` WasmPlugin's matchRules
 * with `allow:[...allowedConsumers]` — confirmed against the live S0 console:
 * an unauthenticated request → 401, an authenticated-but-unlisted consumer → 403.
 */
export interface RouteAuthConfig {
  enabled: boolean;
  /** null = any key-auth credential type allowed (the only type Higress ships today). */
  allowedCredentialTypes?: string[] | null;
  /** Consumer names permitted on this route. */
  allowedConsumers: string[];
}

/** A Higress AI route, POST-ready for `POST /v1/ai/routes`. */
export interface HigressRoute {
  name: string;
  /** URL path match. All gateway traffic shares one path → catch-all PRE '/'. */
  pathPredicate: MatchPredicate;
  /** Model-name match — this is what differentiates the per-alias routes. */
  modelPredicates: MatchPredicate[];
  upstreams: Array<{ provider: string; weight: number }>;
  /**
   * Request authentication (S4). Present on EVERY route when a consumer is supplied
   * so the gateway rejects unauthenticated traffic; absent (undefined) when no
   * consumer is configured (e.g. synth/dry-run before the key is known).
   */
  authConfig?: RouteAuthConfig;
  /**
   * Request/response header rewrites applied at the route. We use it to REMOVE the
   * `x-api-key` consumer key after key-auth has consumed it, so it never reaches the
   * upstream and collides with the upstream's own `Authorization` header. Stamped on
   * EVERY route (harmless for vLLM, required for Bedrock-bound hops). Live-console
   * schema: `{enabled, request:{add,set,remove:[...]}, response:{...}}`.
   */
  headerControl: {
    enabled: boolean;
    request: { remove: string[] };
  };
  /** Per-upstream connection retry (S0 default). */
  proxyNextUpstream: {
    enabled: boolean;
    attempts: number;
    timeout: number;
    conditions: string[];
  };
}

/** A key-auth credential — one entry per source. */
export interface HigressCredential {
  type: 'key-auth';
  /**
   * Where the gateway looks for the token (live-console enum — only these 3 validate):
   *  - 'HEADER': in the `key` header (e.g. `x-api-key`).
   *  - 'BEARER': in `Authorization: Bearer <token>` (`key` MUST be null).
   *  - 'QUERY' : in the `key` query parameter.
   */
  source: 'HEADER' | 'BEARER' | 'QUERY';
  /** Header/query-param name. MUST be null for BEARER. */
  key: string | null;
  /** Accepted token value(s). */
  values: string[];
}

/** A Higress consumer, POST-ready for `POST /v1/consumers`. */
export interface HigressConsumer {
  name: string;
  credentials: HigressCredential[];
}

export interface HigressConfig {
  /** Key-auth consumers (S4). Empty when no API key is supplied (synth/dry-run). */
  consumers: HigressConsumer[];
  providers: HigressProvider[];
  routes: HigressRoute[];
}

export interface BuildHigressConfigOptions {
  /** Bedrock static creds — supplied at apply-time from Secrets Manager (S3). */
  bedrockCredentials?: { accessKey: string; secretKey: string };
  /**
   * Gateway consumer API key — supplied at apply-time from Secrets Manager (S4).
   * When present: a single `genai-gw` consumer (HEADER x-api-key) is emitted and
   * every route gets `authConfig.allowedConsumers:['genai-gw']`. When absent:
   * no consumer and no route authConfig (so synth/dry-run carry no plaintext key).
   * Sent as the `x-api-key` header — the Anthropic SDK's auth header that Claude
   * Code emits and SmartRouter passes through untouched.
   */
  consumerApiKey?: string;
}

/** The single key-auth consumer name; routes allow exactly this one. */
export const CONSUMER_NAME = 'genai-gw';
/** Header carrying the consumer key — the Anthropic SDK's `x-api-key`. */
export const CONSUMER_KEY_HEADER = 'x-api-key';

/** Provider name helpers — deterministic so routes can reference them. */
export const vllmProviderName = (alias: string): string => `vllm-${alias}`;
export const bedrockProviderName = (modelName: string): string => `bedrock-${modelName}`;

/**
 * Build the Higress provider + route config from the existing model lineup.
 *
 * Routing topology (per-alias, one route per scenario alias):
 *  - one route per vLLM alias (incl. extraAliases): model==alias → vLLM provider.
 *    No fallbackConfig — SmartRouter owns the vLLM-failure → Bedrock fallback now.
 *  - one route per Bedrock model: direct (for clients that name a Bedrock model).
 *
 * Providers are deduped: one vLLM provider per model (keyed by primary alias; the
 * provider's modelMapping makes any extraAlias resolve to the same servingName),
 * one Bedrock provider per Bedrock model.
 */
export function buildHigressConfig(
  vllmModels: VllmModelConfig[],
  bedrockModels: BedrockModelConfig[],
  vllmEndpoints: Record<string, string>,
  opts: BuildHigressConfigOptions = {},
): HigressConfig {
  const consumers: HigressConsumer[] = [];
  const providers: HigressProvider[] = [];
  const routes: HigressRoute[] = [];

  // ── S4: key-auth consumer + per-route authConfig ──
  // When an API key is supplied (apply-time, from Secrets Manager), emit ONE consumer
  // and stamp the SAME authConfig onto every route so the gateway rejects unauth'd
  // traffic. Absent → no consumer, no authConfig (synth/dry-run stays plaintext-free).
  let routeAuthConfig: RouteAuthConfig | undefined;
  if (opts.consumerApiKey) {
    consumers.push({
      name: CONSUMER_NAME,
      credentials: [{ type: 'key-auth', source: 'HEADER', key: CONSUMER_KEY_HEADER, values: [opts.consumerApiKey] }],
    });
    routeAuthConfig = { enabled: true, allowedCredentialTypes: null, allowedConsumers: [CONSUMER_NAME] };
  }

  // ── Bedrock providers + direct routes ──
  for (const m of bedrockModels) {
    providers.push({
      name: bedrockProviderName(m.modelName),
      type: 'bedrock',
      rawConfigs: {
        awsRegion: m.awsRegion ?? 'ap-northeast-2',
        // Any incoming model name (direct alias OR a fallback hop) → this Bedrock id.
        modelMapping: { '*': m.bedrockModelId },
        ...(opts.bedrockCredentials
          ? { awsAccessKey: opts.bedrockCredentials.accessKey, awsSecretKey: opts.bedrockCredentials.secretKey }
          : {}),
      },
    });
    routes.push({
      name: `${m.modelName}-route`,
      pathPredicate: { matchType: 'PRE', matchValue: '/', caseSensitive: true },
      modelPredicates: [{ matchType: 'EQUAL', matchValue: m.modelName }],
      upstreams: [{ provider: bedrockProviderName(m.modelName), weight: 100 }],
      ...(routeAuthConfig ? { authConfig: routeAuthConfig } : {}),
      headerControl: defaultHeaderControl(),
      proxyNextUpstream: defaultProxyNextUpstream(),
    });
  }

  // ── vLLM providers + per-alias routes (with Bedrock fallback) ──
  for (const model of vllmModels) {
    const endpoint = vllmEndpoints[model.alias] ?? `http://placeholder-${model.alias}.internal:8000`;
    providers.push({
      name: vllmProviderName(model.alias),
      type: 'openai',
      protocol: 'openai/v1',
      // Dummy token (top-level). vLLM needs no real auth, but the openai provider
      // wants a non-empty token; the console normalizes this into rawConfigs.apiTokens.
      tokens: ['fake-key'],
      rawConfigs: {
        openaiCustomUrl: `${endpoint}/v1/chat/completions`,
        // Rewrite whatever alias the route matched to the vLLM served-model-name.
        modelMapping: { '*': model.servingName },
      },
    });

    const aliases = [model.alias, ...(model.extraAliases ?? [])];
    for (const alias of aliases) {
      routes.push({
        name: `${alias}-route`,
        pathPredicate: { matchType: 'PRE', matchValue: '/', caseSensitive: true },
        modelPredicates: [{ matchType: 'EQUAL', matchValue: alias }],
        upstreams: [{ provider: vllmProviderName(model.alias), weight: 100 }],
        // No fallbackConfig — SmartRouter owns vLLM-failure → Bedrock fallback now
        // (Higress ai-proxy 2.0.0 cannot sign Bedrock /v1/messages, higress#3809).
        ...(routeAuthConfig ? { authConfig: routeAuthConfig } : {}),
        headerControl: defaultHeaderControl(),
        proxyNextUpstream: defaultProxyNextUpstream(),
      });
    }
  }

  return { consumers, providers, routes };
}

/** S0-validated route default for transient connection retries. */
function defaultProxyNextUpstream() {
  return { enabled: true, attempts: 3, timeout: 120, conditions: ['error', 'timeout', 'non_idempotent'] };
}

/**
 * Strip the `x-api-key` consumer key after key-auth consumes it, so it never
 * collides with the upstream's own `Authorization` header (blocker#1 fix, proven
 * live then codified here). Same on every route.
 */
function defaultHeaderControl() {
  return { enabled: true, request: { remove: [CONSUMER_KEY_HEADER] } };
}

/** Convenience: build with the repo's standard Bedrock model list. */
export function buildHigressConfigDefault(
  vllmModels: VllmModelConfig[],
  vllmEndpoints: Record<string, string>,
  opts: BuildHigressConfigOptions = {},
): HigressConfig {
  return buildHigressConfig(vllmModels, BEDROCK_MODELS, vllmEndpoints, opts);
}
