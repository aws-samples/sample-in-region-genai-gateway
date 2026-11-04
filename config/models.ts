export interface VllmModelConfig {
  /** HuggingFace model ID */
  modelId: string;
  /** K8s serving name — used as Deployment name and NLB service name */
  servingName: string;
  /** Scenario alias — primary client-facing model name (e.g. 'coding', 'ocr') */
  alias: string;
  /** EC2 instance type for Karpenter NodePool selection */
  instanceType: string;
  /** Number of GPUs per replica */
  gpuCount: number;
  /** vLLM --tensor-parallel-size (defaults to gpuCount) */
  tensorParallelSize?: number;
  /** Max model context length */
  maxModelLen: number;
  /** vLLM Docker image tag */
  vllmImageTag: string;
  /** Enable vision/multimodal inputs */
  enableVision: boolean;
  /** Enable audio inputs (Phi-4 Multimodal only) */
  enableAudio?: boolean;
  /** 0 = scale-to-zero, 1 = always-on */
  minReplicas: number;
  maxReplicas: number;
  /** Mount EFS model cache at /model-cache */
  efsEnabled: boolean;
  /** Additional client-facing aliases beyond the primary alias */
  extraAliases?: string[];
  /** Extra vLLM CLI flags appended after the standard args */
  extraArgs?: string[];
  /** Shell commands to run in an initContainer before vLLM starts */
  initCommands?: string[];
  /** Override liveness probe initialDelaySeconds (default: 180) */
  livenessInitialDelaySecs?: number;
  /** Override liveness probe failureThreshold (default: 5) */
  livenessFailureThreshold?: number;
}

/** Scenario model lineup. Benchmark figures are illustrative — verify against the current model card before relying on them. */
export const VLLM_MODELS: Record<string, VllmModelConfig> = {
  coding: {
    // Qwen3.5-27B: SWE-bench 72.0%, LCB v6 80.7%
    modelId: 'Qwen/Qwen3.5-27B',
    servingName: 'qwen35-27b',
    alias: 'coding',
    instanceType: 'g5.12xlarge',
    gpuCount: 4,
    tensorParallelSize: 4,
    maxModelLen: 32768,
    vllmImageTag: 'v0.20.2',
    enableVision: true,
    minReplicas: 0,
    maxReplicas: 3,
    efsEnabled: true,
    // Tool calling: vLLM rejects `tool_choice:"auto"` with 400 unless both flags are set.
    // Qwen3.5-27B emits XML-style tool calls (<tool_call><function=...><parameter=...>),
    // so the matching vLLM parser is `qwen3_xml` (verified against the live v0.20.2 parser
    // registry and observed output — `hermes` expects JSON-in-<tool_call> and silently
    // leaks the XML as plain text). Without these, warm tool-use requests 400 at vLLM and
    // the SmartRouter reactive safety-net answers them via Bedrock — correct but not
    // vLLM-direct. (No --reasoning-parser: keeps the response shape identical to the warm
    // non-stream/stream paths already validated.)
    extraArgs: ['--enable-auto-tool-choice', '--tool-call-parser', 'qwen3_xml'],
  },
  video: {
    // Qwen3.5-27B: MMMU 85.0, native video understanding — separate instance for fault isolation
    modelId: 'Qwen/Qwen3.5-27B',
    servingName: 'qwen35-27b-video',
    alias: 'video',
    instanceType: 'g5.12xlarge',
    gpuCount: 4,
    tensorParallelSize: 4,
    maxModelLen: 32768,
    vllmImageTag: 'v0.20.2',
    enableVision: true,
    minReplicas: 0,
    maxReplicas: 2,
    efsEnabled: true,
    // Same Qwen3.5-27B as `coding` — enable qwen3_xml tool calling here too for parity.
    extraArgs: ['--enable-auto-tool-choice', '--tool-call-parser', 'qwen3_xml'],
  },
  ocr: {
    // InternVL3-14B: DocVQA 94.1, OCRBench 875 — document/diagram OCR
    modelId: 'OpenGVLab/InternVL3-14B',
    servingName: 'internvl3-14b',
    alias: 'ocr',
    instanceType: 'g5.12xlarge',
    gpuCount: 4,
    tensorParallelSize: 4,
    maxModelLen: 8192,
    vllmImageTag: 'v0.20.2',
    enableVision: true,
    minReplicas: 0,
    maxReplicas: 2,
    efsEnabled: true,
  },
  longcontext: {
    // LLaMA 4 Scout 17B-16E: 10M context, MoE 17B active / 109B total params
    // HF gate approved 2026-05-01. g6e.48xlarge: 8x L40S (48GB each = 384GB total)
    // --enforce-eager: disables CUDA graph capture to avoid >20min startup at maxModelLen=131072
    modelId: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
    servingName: 'llama4-scout',
    alias: 'longcontext',
    instanceType: 'g6e.48xlarge',
    gpuCount: 8,
    tensorParallelSize: 8,
    maxModelLen: 131072,
    vllmImageTag: 'v0.20.2',
    enableVision: true,
    minReplicas: 0,
    maxReplicas: 1,
    efsEnabled: true,
    // I7 fix: 900s grace + 3×60s = 960s total. WarmupMachine timeout raised to 50min (3000s).
    // Previous: 900 + 20×60 = 2100s ≈ 35min matched actual boot time → TIMED_OUT at 25min cap.
    livenessInitialDelaySecs: 2400,
    livenessFailureThreshold: 3,
    extraArgs: ['--enforce-eager', '--safetensors-load-strategy=prefetch'],
  },
  math: {
    // Gemma 4 31B: AIME 2026 89.2%, GPQA 84.3% — math/reasoning
    // extraArgs: max_tokens_per_mm_item=2496 (vision budget) > default max_num_batched_tokens=2048
    modelId: 'google/gemma-4-31b-it',
    servingName: 'gemma4-31b',
    alias: 'math',
    instanceType: 'g6e.12xlarge',
    gpuCount: 4,
    tensorParallelSize: 4,
    maxModelLen: 32768,
    vllmImageTag: 'v0.20.2',
    enableVision: false,
    minReplicas: 0,
    maxReplicas: 2,
    efsEnabled: true,
    extraArgs: ['--max-num-batched-tokens', '4096'],
  },
  audio: {
    // Phi-4 Multimodal: unified audio+image+video — meeting transcription
    // initCommands: scipy required by Phi-4 modeling code, not bundled in vllm:latest
    modelId: 'microsoft/Phi-4-multimodal-instruct',
    servingName: 'phi4-multimodal',
    alias: 'audio',
    instanceType: 'g5.xlarge',
    gpuCount: 1,
    maxModelLen: 16384,
    vllmImageTag: 'v0.20.2',
    enableVision: true,
    enableAudio: true,
    minReplicas: 0,
    maxReplicas: 2,
    efsEnabled: true,
    initCommands: ['pip install scipy --quiet'],
  },
};

/** Bedrock ON_DEMAND Seoul (data residency) — Fallback + Claude Code CLI compat */
export interface BedrockModelConfig {
  /** Client-facing alias exposed to clients (model field) */
  modelName: string;
  /** Bedrock model ID — Seoul IN_REGION only */
  bedrockModelId: string;
  awsRegion?: string;
}

// Order matters for the SmartRouter cold-fallback cascade: BEDROCK_MODELS[0] is the
// PRIMARY fallback target, [1] is the SECONDARY (cascaded to on a primary throttle). The
// Higress provider/route generator (higress-config.ts) iterates the list order-independently,
// so this order ONLY affects which Bedrock model the cold path tries first.
//
// DEFAULT = QUALITY-FIRST: Sonnet 3.5 PRIMARY, Haiku 3 SECONDARY. This gateway's whole reason
// for existing is accuracy/quality (it self-hosts Qwen to recover ~82% of frontier coding) —
// not speed. So the cold fallback, too, defaults to the higher-quality model first, and only
// cascades to Haiku 3 when Sonnet throttles. This is the opposite of optimizing the cold path
// for raw latency, and it is a deliberate product choice.
//
// ⚠️ KNOWN TRADE-OFF (measured Seoul on-demand, 2026-06-14): the Sonnet 3.5 pool was ~93%
// throttled (`Too many connections`) vs Haiku 3 ~43% (a separate pool, RPM 400 vs 50). With
// Sonnet primary, a cold Claude Code request can spend 16–93 s (occasionally timing out) on
// botocore adaptive-retry backoff before answering or cascading; with Haiku primary it was
// 4–6 s. We accept the slower cold start for higher quality by default. A customer who values
// cold-start LATENCY over quality can flip the order at deploy time WITHOUT editing source:
//   cdk deploy ... -c coldFallbackOrder=availability   (→ Haiku primary, Sonnet secondary)
// (default is `quality`). The cold path is best-effort anyway — for production-grade speed AND
// quality, warm up the vLLM alias so the self-hosted model serves directly. Revisit the
// default if the Seoul pools' relative capacity changes.
export const BEDROCK_MODELS: BedrockModelConfig[] = [
  {
    // PRIMARY cold-fallback target (DEFAULT = quality-first). Higher quality than Haiku; the
    // Seoul on-demand pool is more throttled, accepted as the default trade-off (see note).
    modelName: 'claude-3-5-sonnet-20241022',
    bedrockModelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    awsRegion: 'ap-northeast-2',
  },
  {
    // SECONDARY — cascaded to only when the primary (Sonnet) throttles. Faster/less-throttled
    // pool, so it is also the PRIMARY when deployed with `-c coldFallbackOrder=availability`.
    // EOL 2026-09-10 — replace with Haiku 3.5 when Seoul IN_REGION available.
    modelName: 'claude-3-haiku-20240307',
    bedrockModelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    awsRegion: 'ap-northeast-2',
  },
];

export const DEFAULT_VLLM_IMAGE = 'vllm/vllm-openai';
// Pinned, NOT `latest`. v0.10.2 is too old for qwen3.5/gemma4/llama4 architectures
// (need v0.20.0+); v0.20.2 is the version validated end-to-end against Mountpoint-for-S3
// model caching. `latest` is a floating tag: a newer huggingface_hub baked into a later
// `latest` image switched to a download path that RENAMEs staged files, which S3 FUSE
// rejects (ENOSYS / Errno 38) — the init container then crash-loops forever while its GPU
// node keeps billing. Pin the tag so deploys stay reproducible; bump deliberately after
// re-validating S3 model download.
export const DEFAULT_VLLM_TAG = 'v0.20.2';
