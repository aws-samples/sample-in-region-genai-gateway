import {
  buildHigressConfig,
  buildHigressConfigDefault,
  vllmProviderName,
  bedrockProviderName,
  CONSUMER_NAME,
  CONSUMER_KEY_HEADER,
} from '../config/higress-config';
import { VLLM_MODELS, BEDROCK_MODELS, VllmModelConfig } from '../config/models';

const vllmList = Object.values(VLLM_MODELS);
const endpoints: Record<string, string> = Object.fromEntries(
  vllmList.map((m) => [m.alias, `http://internal-${m.alias}.elb.amazonaws.com:8000`]),
);

describe('buildHigressConfig — providers', () => {
  const cfg = buildHigressConfig(vllmList, BEDROCK_MODELS, endpoints);

  test('one provider per vLLM model + one per Bedrock model', () => {
    expect(cfg.providers).toHaveLength(vllmList.length + BEDROCK_MODELS.length);
  });

  test('vLLM providers are openai type with the full chat-completions URL in rawConfigs', () => {
    for (const m of vllmList) {
      const p = cfg.providers.find((x) => x.name === vllmProviderName(m.alias));
      expect(p).toBeDefined();
      expect(p!.type).toBe('openai');
      expect(p!.protocol).toBe('openai/v1');
      // Live-console contract: endpoint + modelMapping live INSIDE rawConfigs.
      expect(p!.rawConfigs.openaiCustomUrl).toBe(`${endpoints[m.alias]}/v1/chat/completions`);
      // alias→servingName rewrite (gateway rewrites the client model name to the vLLM serving name)
      expect(p!.rawConfigs.modelMapping).toEqual({ '*': m.servingName });
      // Tokens are TOP-LEVEL (console normalizes to rawConfigs.apiTokens).
      expect(p!.tokens).toEqual(['fake-key']);
    }
  });

  test('Bedrock providers are bedrock type mapping wildcard → bedrock model id in rawConfigs', () => {
    for (const b of BEDROCK_MODELS) {
      const p = cfg.providers.find((x) => x.name === bedrockProviderName(b.modelName));
      expect(p).toBeDefined();
      expect(p!.type).toBe('bedrock');
      expect(p!.rawConfigs.awsRegion).toBe(b.awsRegion ?? 'ap-northeast-2');
      expect(p!.rawConfigs.modelMapping).toEqual({ '*': b.bedrockModelId });
      // bedrock providers carry no top-level openai token.
      expect(p!.tokens).toBeUndefined();
    }
  });

  test('no plaintext credentials unless explicitly injected (S3 Secrets Manager)', () => {
    for (const p of cfg.providers) {
      expect(p.rawConfigs.awsAccessKey).toBeUndefined();
      expect(p.rawConfigs.awsSecretKey).toBeUndefined();
    }
    const withCreds = buildHigressConfig(vllmList, BEDROCK_MODELS, endpoints, {
      bedrockCredentials: { accessKey: 'AKIA_TEST', secretKey: 'SECRET_TEST' },
    });
    for (const p of withCreds.providers.filter((x) => x.type === 'bedrock')) {
      expect(p.rawConfigs.awsAccessKey).toBe('AKIA_TEST');
      expect(p.rawConfigs.awsSecretKey).toBe('SECRET_TEST');
    }
  });
});

describe('buildHigressConfig — routes', () => {
  const cfg = buildHigressConfig(vllmList, BEDROCK_MODELS, endpoints);

  test('one route per alias (incl. extraAliases) + one per Bedrock model', () => {
    const totalVllmAliases = vllmList.reduce((n, m) => n + 1 + (m.extraAliases?.length ?? 0), 0);
    expect(cfg.routes).toHaveLength(totalVllmAliases + BEDROCK_MODELS.length);
  });

  test('each vLLM route matches its alias by EQUAL and points at its provider', () => {
    for (const m of vllmList) {
      const aliases = [m.alias, ...(m.extraAliases ?? [])];
      for (const alias of aliases) {
        const r = cfg.routes.find((x) => x.name === `${alias}-route`)!;
        expect(r).toBeDefined();
        expect(r.modelPredicates).toEqual([{ matchType: 'EQUAL', matchValue: alias }]);
        expect(r.upstreams).toEqual([{ provider: vllmProviderName(m.alias), weight: 100 }]);
      }
    }
  });

  test('NO route carries fallbackConfig — SmartRouter owns vLLM-failure → Bedrock fallback now', () => {
    for (const r of cfg.routes) {
      // fallbackConfig was removed (higress#3809: ai-proxy 2.0.0 can't sign Bedrock /v1/messages).
      expect((r as unknown as Record<string, unknown>).fallbackConfig).toBeUndefined();
    }
  });

  test('Bedrock direct routes point at their provider (clients may name a Bedrock model)', () => {
    for (const b of BEDROCK_MODELS) {
      const r = cfg.routes.find((x) => x.name === `${b.modelName}-route`)!;
      expect(r).toBeDefined();
      expect(r.upstreams).toEqual([{ provider: bedrockProviderName(b.modelName), weight: 100 }]);
    }
  });

  test('EVERY route strips x-api-key via headerControl (blocker#1 fix — avoids Bedrock auth collision)', () => {
    for (const r of cfg.routes) {
      expect(r.headerControl).toEqual({ enabled: true, request: { remove: [CONSUMER_KEY_HEADER] } });
    }
  });

  test('all routes share the catch-all path predicate + S0 proxyNextUpstream default', () => {
    for (const r of cfg.routes) {
      expect(r.pathPredicate).toEqual({ matchType: 'PRE', matchValue: '/', caseSensitive: true });
      expect(r.proxyNextUpstream).toEqual({
        enabled: true,
        attempts: 3,
        timeout: 120,
        conditions: ['error', 'timeout', 'non_idempotent'],
      });
    }
  });
});

describe('buildHigressConfig — parity with buildProxyConfig inputs', () => {
  test('placeholder endpoint when alias missing from the endpoint map', () => {
    const cfg = buildHigressConfig(vllmList, BEDROCK_MODELS, {});
    const p = cfg.providers.find((x) => x.name === vllmProviderName('coding'))!;
    expect(p.rawConfigs.openaiCustomUrl).toBe('http://placeholder-coding.internal:8000/v1/chat/completions');
  });

  test('no Bedrock models → only vLLM routes, all still well-formed (no fallback anywhere)', () => {
    const cfg = buildHigressConfig(vllmList, [], endpoints);
    expect(cfg.routes.length).toBe(vllmList.reduce((n, m) => n + 1 + (m.extraAliases?.length ?? 0), 0));
    for (const r of cfg.routes) {
      expect((r as unknown as Record<string, unknown>).fallbackConfig).toBeUndefined();
      expect(r.headerControl).toEqual({ enabled: true, request: { remove: [CONSUMER_KEY_HEADER] } });
    }
  });

  test('buildHigressConfigDefault uses the repo BEDROCK_MODELS', () => {
    const cfg = buildHigressConfigDefault(vllmList, endpoints);
    expect(cfg.providers.filter((p) => p.type === 'bedrock')).toHaveLength(BEDROCK_MODELS.length);
  });

  test('extraAliases each get their own route resolving to the same servingName', () => {
    const withExtra: VllmModelConfig[] = [
      { ...vllmList[0], alias: 'primaryX', extraAliases: ['altA', 'altB'], servingName: 'srv-x' },
    ];
    const cfg = buildHigressConfig(withExtra, BEDROCK_MODELS, { primaryX: 'http://x:8000' });
    expect(cfg.routes.filter((r) => r.upstreams[0].provider === vllmProviderName('primaryX'))).toHaveLength(3);
    expect(cfg.providers.find((p) => p.name === vllmProviderName('primaryX'))!.rawConfigs.modelMapping).toEqual({
      '*': 'srv-x',
    });
  });
});

describe('buildHigressConfig — S4 key-auth consumer', () => {
  test('no consumerApiKey → zero consumers and NO route authConfig (plaintext-free synth)', () => {
    const cfg = buildHigressConfig(vllmList, BEDROCK_MODELS, endpoints);
    expect(cfg.consumers).toEqual([]);
    for (const r of cfg.routes) {
      expect(r.authConfig).toBeUndefined();
    }
  });

  test('with consumerApiKey → ONE key-auth consumer (HEADER x-api-key) carrying the token', () => {
    const cfg = buildHigressConfig(vllmList, BEDROCK_MODELS, endpoints, { consumerApiKey: 'tok-secret-123' });
    expect(cfg.consumers).toHaveLength(1);
    const c = cfg.consumers[0];
    expect(c.name).toBe(CONSUMER_NAME);
    expect(c.credentials).toEqual([
      { type: 'key-auth', source: 'HEADER', key: CONSUMER_KEY_HEADER, values: ['tok-secret-123'] },
    ]);
    // x-api-key is the Anthropic SDK auth header (NOT Authorization/Bearer).
    expect(CONSUMER_KEY_HEADER).toBe('x-api-key');
  });

  test('with consumerApiKey → EVERY route (vLLM, extraAlias, Bedrock, fallback) allows only the consumer', () => {
    const cfg = buildHigressConfig(vllmList, BEDROCK_MODELS, endpoints, { consumerApiKey: 'tok' });
    expect(cfg.routes.length).toBeGreaterThan(0);
    for (const r of cfg.routes) {
      expect(r.authConfig).toEqual({
        enabled: true,
        allowedCredentialTypes: null,
        allowedConsumers: [CONSUMER_NAME],
      });
    }
  });

  test('the token NEVER appears anywhere except the consumer credential values', () => {
    const cfg = buildHigressConfig(vllmList, BEDROCK_MODELS, endpoints, { consumerApiKey: 'SENTINEL_TOKEN' });
    // Strip the one legitimate occurrence, then assert the token is absent everywhere else.
    const withoutConsumers = JSON.stringify({ providers: cfg.providers, routes: cfg.routes });
    expect(withoutConsumers).not.toContain('SENTINEL_TOKEN');
  });
});
