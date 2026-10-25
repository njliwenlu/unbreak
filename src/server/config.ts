import { GoogleGenAI } from "@google/genai";

/** Server-side Gemini configuration. The key never leaves the server. */
export interface ArgonConfig {
  apiKey: string | undefined;
  model: string;
  /** Frames per second sampled from the clip. */
  videoFps: number;
  fileProcessingTimeoutMs: number;
  inferenceTimeoutMs: number;
}

export function argonConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ArgonConfig {
  return {
    apiKey: env.GEMINI_API_KEY || undefined,
    model: env.ARGON_MODEL || "gemini-4-argon",
    videoFps: clampNumber(env.ARGON_VIDEO_FPS, 8, 1, 30),
    fileProcessingTimeoutMs: clampNumber(env.ARGON_FILE_TIMEOUT_MS, 180_000, 10_000, 900_000),
    inferenceTimeoutMs: clampNumber(env.ARGON_INFERENCE_TIMEOUT_MS, 240_000, 10_000, 900_000),
  };
}

function clampNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** One tiny text-only request with the configured key and model (used by scripts/check-model.ts). */
export async function checkModelAccess(config: ArgonConfig): Promise<{ ok: true; ms: number; outputText: string | null } | { ok: false; ms: number; error: string }> {
  if (!config.apiKey) return { ok: false, ms: 0, error: "GEMINI_API_KEY is not set." };
  const ai = new GoogleGenAI({ apiKey: config.apiKey });
  const t0 = Date.now();
  try {
    const interaction = await ai.interactions.create({ model: config.model, input: "Reply with exactly: OK" }, { timeout_ms: 60_000 });
    return { ok: true, ms: Date.now() - t0, outputText: interaction.output_text ?? null };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: `Gemini API error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
