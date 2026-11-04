#!/usr/bin/env ts-node
/**
 * emit-higress-config.ts — print the Higress provider/route config as POST-ready JSON.
 *
 * Single source of truth for the apply step: `scripts/apply-higress.sh` shells out to
 * this so the payload shaping lives ONLY in `buildHigressConfig()` (config/higress-config.ts)
 * — the bash applier never re-implements the REST body shape.
 *
 * Inputs are read from the ENVIRONMENT (never argv) so secrets stay out of the
 * process arg list / shell history:
 *   VLLM_ENDPOINTS   (required)  JSON map  { "<alias>": "http://<nlb-dns>:8000", ... }
 *   BEDROCK_CREDS    (optional)  JSON      { "accessKeyId": "...", "secretAccessKey": "..." }
 *                                When present, the bedrock providers carry the AK/SK in
 *                                rawConfigs; when absent, creds are omitted (synth/dry-run).
 *   GATEWAY_API_KEY  (optional)  string    the consumer key-auth token.
 *                                When present, a single `genai-gw` key-auth consumer is
 *                                emitted and every route gets authConfig.allowedConsumers;
 *                                when absent, no consumer / no route auth (plaintext-free).
 *
 * Output: a single JSON object { "consumers": [...], "providers": [...], "routes": [...] }.
 */
import { buildHigressConfigDefault } from './higress-config';
import { VLLM_MODELS } from './models';

function fail(msg: string): never {
  process.stderr.write(`emit-higress-config: ${msg}\n`);
  process.exit(1);
}

const rawEndpoints = process.env.VLLM_ENDPOINTS;
if (!rawEndpoints) {
  fail('VLLM_ENDPOINTS env var is required (JSON map of alias -> NLB endpoint).');
}

let vllmEndpoints: Record<string, string>;
try {
  vllmEndpoints = JSON.parse(rawEndpoints);
} catch (e) {
  fail(`VLLM_ENDPOINTS is not valid JSON: ${(e as Error).message}`);
}

let bedrockCredentials: { accessKey: string; secretKey: string } | undefined;
const rawCreds = process.env.BEDROCK_CREDS;
if (rawCreds) {
  try {
    const c = JSON.parse(rawCreds);
    if (!c.accessKeyId || !c.secretAccessKey) {
      fail('BEDROCK_CREDS must contain "accessKeyId" and "secretAccessKey".');
    }
    bedrockCredentials = { accessKey: c.accessKeyId, secretKey: c.secretAccessKey };
  } catch (e) {
    fail(`BEDROCK_CREDS is not valid JSON: ${(e as Error).message}`);
  }
}

// Consumer key-auth token. Empty/unset → no consumer, no route authConfig.
const consumerApiKey = process.env.GATEWAY_API_KEY || undefined;

const cfg = buildHigressConfigDefault(Object.values(VLLM_MODELS), vllmEndpoints, {
  bedrockCredentials,
  consumerApiKey,
});
process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
