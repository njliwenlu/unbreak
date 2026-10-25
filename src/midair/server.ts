import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import express from "express";
import { z } from "zod";
import { argonConfigFromEnv } from "../server/config";
import { parseMockCriticFaults } from "../server/mockFaults";
import { MIDAIR_MANUAL_FIT, MIDAIR_SOURCE, sceneFromProportions } from "./level";
import { applyLaneMove, findLaneWitness, LANE_RULE, LaneMoveSchema, MIDAIR_LANDING, simulateMidair, type LaneMove, type MidairResult, type MidairScene } from "./midair";

/**
 * Midair level server. Argon reconstructs the scene from the licensed (CC BY) source video; the server accepts it only
 * if physics reproduces an airborne collision. The critic sees the video plus synchronized side + top-down renders of
 * the current attempt and proposes one legal lane move; physics decides. A hand fit exists only as a separately
 * labeled reference and is never substituted for a rejected Argon result.
 */

const MEDIA_DIR = process.env.MIDAIR_MEDIA_DIR ?? path.resolve(process.cwd(), "demo/media/rc-free");
const MAX_ROUNDS = 3;
const MAX_FAILURES = 2;

export const MIDAIR_RECONSTRUCT_INSTRUCTION = "You reconstruct bounded physical hypotheses from actual video evidence. Output JSON only.";
export const MIDAIR_RECONSTRUCT_PROMPT = [
  "This is a real recording (side view) of two RC cars driving toward each other off two facing kicker ramps.",
  "Support ONLY: two straight kicker ramps on a flat road whose high lips face each other across a gap, one car approaching each ramp from the outside, both cars driving toward the gap. Otherwise return unsupported or insufficient_evidence with scene=null.",
  "Measure on the FIRST frame, in units of ONE CAR LENGTH (use the car bodies as the ruler): gapCL = horizontal distance between the two ramp lips; for the LEFT ramp (A) and RIGHT ramp (B): lengthCL along the ramp surface and pitchDeg (incline angle); runUpACL / runUpBCL = distance from each car's front bumper to the low end (base) of its ramp.",
  "Report what happens: did the cars touch each other, roughly when (video seconds), and were both cars airborne at that moment.",
  "observations: 2-10 timestamped visual facts supporting the geometry and the outcome. Do not propose any change. Do not invent objects. JSON only.",
].join("\n");
export const MIDAIR_CRITIQUE_INSTRUCTION =
  "You compare a REAL recording of two RC cars colliding off facing ramps with an ACTUAL physics-simulation contact sheet of the current attempt: the top row is a SIDE view and the bottom row a TOP-DOWN view at the same simulation times. The only legal control is 'Move one launch lane': choose lane A or B and ONE lateral offset in meters within the request's bounds; that ramp and its car move sideways together. Speeds, release times, cars and everything else are fixed. Explain source evidence (cite video timestamps) separately from rendered evidence (cite the sheet's times and which view). Return move=null if no supported change exists. Never claim success: the server's physics decides. JSON only.";

export const MidairReconstructionSchema = z
  .object({
    verdict: z.enum(["supported", "unsupported", "insufficient_evidence"]),
    reason: z.string().min(1).max(2000),
    scene: z
      .object({
        gapCL: z.number().finite().min(0.5).max(10),
        rampA: z.object({ lengthCL: z.number().finite().min(0.8).max(8), pitchDeg: z.number().finite().min(3).max(40) }).strict(),
        rampB: z.object({ lengthCL: z.number().finite().min(0.8).max(8), pitchDeg: z.number().finite().min(3).max(40) }).strict(),
        runUpACL: z.number().finite().min(0.1).max(6),
        runUpBCL: z.number().finite().min(0.1).max(6),
        carsTouched: z.boolean(),
        collisionVideoSeconds: z.number().finite().min(0).max(60).nullable(),
        bothAirborneAtCollision: z.boolean(),
        observations: z.array(z.object({ timeSeconds: z.number().finite().min(0).max(60), description: z.string().min(1).max(300) }).strict()).min(2).max(10),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const MidairCritiqueSchema = z
  .object({
    assessment: z.string().min(1).max(2000),
    sourceEvidence: z.string().min(1).max(2000),
    renderEvidence: z.string().min(1).max(2000),
    move: LaneMoveSchema.extend({ reason: z.string().min(1).max(600) }).strict().nullable(),
  })
  .strict();

type Source = { name: string; uri: string; mimeType: string };
export interface MidairProvider {
  configured: boolean;
  model: string;
  instructions: { reconstruct: string; critique: string } | null;
  upload(filePath: string, mime: string, active: () => boolean): Promise<Source>;
  remove(source: Source): Promise<void>;
  reconstruct(source: Source): Promise<string>;
  critique(input: { source?: Source; payload: string; jpegBase64: string }): Promise<string>;
}

function liveProvider(): MidairProvider {
  const config = argonConfigFromEnv();
  const ai = config.apiKey ? new GoogleGenAI({ apiKey: config.apiKey }) : undefined;
  const need = () => {
    if (!ai) throw new Error("Set GEMINI_API_KEY on the server to use live Argon.");
    return ai;
  };
  const video = (s: Source) => ({ type: "video" as const, uri: s.uri, mime_type: s.mimeType, processing: { type: "static" as const, fps: config.videoFps } });
  const request = async (input: Parameters<GoogleGenAI["interactions"]["create"]>[0]["input"], schema: z.ZodType, instruction: string) => {
    const out = await need().interactions.create(
      { model: config.model, input, system_instruction: instruction, response_format: { type: "text", mime_type: "application/json", schema: z.toJSONSchema(schema) as Record<string, unknown> } },
      { timeout_ms: config.inferenceTimeoutMs },
    );
    if (!out.output_text) throw new Error("Argon returned no JSON text.");
    return out.output_text;
  };
  return {
    configured: Boolean(ai),
    model: config.model,
    instructions: { reconstruct: MIDAIR_RECONSTRUCT_INSTRUCTION, critique: MIDAIR_CRITIQUE_INSTRUCTION },
    async upload(filePath, mime, active) {
      let file = await need().files.upload({ file: filePath, config: { mimeType: mime } });
      if (!file.name) throw new Error("Google upload returned no file name.");
      const name = file.name, start = Date.now();
      try {
        while (file.state !== "ACTIVE") {
          if (!active()) throw new Error("Cancelled");
          if (file.state === "FAILED" || Date.now() - start > config.fileProcessingTimeoutMs) throw new Error("Video processing failed or timed out.");
          await new Promise((r) => setTimeout(r, 1000));
          file = await need().files.get({ name });
        }
        if (!file.uri) throw new Error("Processed video has no URI.");
        return { name, uri: file.uri, mimeType: mime };
      } catch (e) {
        await need().files.delete({ name }).catch(() => {});
        throw e;
      }
    },
    async remove(s) {
      await need().files.delete({ name: s.name });
    },
    reconstruct: (s) => request([video(s), { type: "text", text: MIDAIR_RECONSTRUCT_PROMPT }], MidairReconstructionSchema, MIDAIR_RECONSTRUCT_INSTRUCTION),
    critique: ({ source, payload, jpegBase64 }) => request([...(source ? [video(source)] : []), { type: "image", data: jpegBase64, mime_type: "image/jpeg" }, { type: "text", text: payload }], MidairCritiqueSchema, MIDAIR_CRITIQUE_INSTRUCTION),
  };
}

export const MOCK_MIDAIR_MODEL = "MOCK critic (ARGON_MOCK, scripted, no model call)";
/** TEST ONLY: scripted, inspects nothing; cannot reconstruct video. Round 1: lane B +0.30 (physics: rollover); round 2: +0.60. */
export function mockMidairProvider(opts: { criticMs?: number; faults?: string } = {}): MidairProvider {
  const faults = parseMockCriticFaults(opts.faults);
  let calls = 0;
  const refuse = async (): Promise<never> => {
    throw new Error("Mock mode cannot reconstruct video: that needs a real API key.");
  };
  return {
    configured: true,
    model: MOCK_MIDAIR_MODEL,
    instructions: null,
    upload: refuse,
    remove: async () => {},
    reconstruct: refuse,
    async critique({ payload }) {
      await new Promise((r) => setTimeout(r, opts.criticMs ?? 900));
      const fault = faults[calls++];
      if (fault === "timeout") throw new Error("MOCK INJECTED FAULT: timed out waiting for the critic.");
      if (fault === "model_error") throw new Error("MOCK INJECTED FAULT: Gemini API error (HTTP 503).");
      if (fault === "invalid_critique") return '{"assessment":"MOCK INJECTED FAULT: malformed critique"}';
      const round = (JSON.parse(payload) as { priorAttempts: unknown[] }).priorAttempts.length + 1;
      return JSON.stringify({
        assessment: round === 1 ? "MOCK CRITIQUE: scripted. Claims 30 cm WILL separate them; only physics decides." : `MOCK CRITIQUE: scripted round ${round}; nothing inspected.`,
        sourceEvidence: "MOCK: the recording was not inspected.",
        renderEvidence: "MOCK: the sheet was received but not inspected.",
        move: round === 1 ? { lane: "B", offsetM: 0.3, reason: "MOCK: scripted" } : round === 2 ? { lane: "B", offsetM: 0.6, reason: "MOCK: scripted" } : null,
      });
    },
  };
}

type Summary = Omit<MidairResult, "frames">;
export interface MidairAttempt {
  round: number;
  from: LaneMove | null;
  assessment: string;
  sourceEvidence: string;
  renderEvidence: string;
  move: (LaneMove & { reason: string }) | null;
  result: Summary;
  success: boolean;
  elapsedMs: number;
}
export interface MidairJob {
  id: string;
  geometrySource: MidairScene["geometrySource"];
  model: string;
  status: "analyzing" | "ready" | "repairing" | "unsupported" | "error" | "cancelled";
  stage: string;
  baseline?: MidairScene;
  baselineResult?: Summary;
  /** Argon proportions vs the hand fit (diagnostic only). */
  comparison?: { field: string; argon: number; manual: number }[];
  observations?: { timeSeconds: number; description: string }[];
  reportedCollision?: { carsTouched: boolean; collisionVideoSeconds: number | null; bothAirborneAtCollision: boolean };
  verification: { status: "pending" | "searching" | "verified" | "none_found"; method?: string; evaluated?: number };
  attempts: MidairAttempt[];
  failures: number;
  failedAttempts: { round: number; error: string; at: string }[];
  timings: { uploadMs?: number; reconstructMs?: number; critiqueMs: number[] };
  error?: string;
  createdAt: string;
}

const strip = (r: MidairResult): Summary => {
  const { frames: _f, ...rest } = r;
  return rest;
};
const describe = (error: unknown) =>
  error instanceof z.ZodError
    ? `The model's output failed validation: ${error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`
    : error instanceof SyntaxError
      ? `The model's output was not valid JSON: ${error.message}`
      : error instanceof Error
        ? error.message
        : "Operation failed";

interface Rec {
  job: MidairJob;
  witness: (LaneMove & { method: string; checks: string[] }) | null;
  source?: Source;
  /** A playtest run borrows its parent's uploaded video; only the owner deletes it. */
  ownsSource: boolean;
  token: number;
  pending: boolean;
  dir: string;
  expires: number;
}

export function createMidairRouter(deps: { provider?: MidairProvider; runRoot?: string; ttlMs?: number; mediaDir?: string } = {}): express.Router {
  const api = deps.provider ?? liveProvider();
  const mediaDir = deps.mediaDir ?? MEDIA_DIR;
  const root = deps.runRoot ?? path.join(process.cwd(), "runs");
  const router = express.Router();
  const records = new Map<string, Rec>();
  const archive = async (r: Rec, name: string, data: unknown) => {
    await mkdir(r.dir, { recursive: true });
    await writeFile(path.join(r.dir, name), typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2));
  };
  const clean = async (r: Rec) => {
    if (!r.source) return;
    const s = r.source;
    r.source = undefined;
    if (r.ownsSource) await api.remove(s).catch(() => {});
  };
  const expire = () => {
    for (const [id, r] of records)
      if (r.expires < Date.now() && !r.pending) {
        void clean(r);
        records.delete(id);
      }
  };
  const make = (geometrySource: MidairScene["geometrySource"]): Rec => {
    expire();
    if (records.size >= 20) throw new Error("Too many active runs. Cancel an earlier run first.");
    const id = randomUUID();
    const r: Rec = {
      job: { id, geometrySource, model: api.model, status: "analyzing", stage: "Preparing", verification: { status: "pending" }, attempts: [], failures: 0, failedAttempts: [], timings: { critiqueMs: [] }, createdAt: new Date().toISOString() },
      witness: null,
      ownsSource: true,
      token: 0,
      pending: false,
      dir: path.join(root, `midair-${id}`),
      expires: Date.now() + (deps.ttlMs ?? 3_600_000),
    };
    records.set(id, r);
    return r;
  };
  const run = (r: Rec, work: (active: () => boolean) => Promise<void>) => {
    r.pending = true;
    const token = ++r.token;
    const active = () => r.token === token && r.job.status !== "cancelled";
    void (async () => {
      try {
        await work(active);
      } catch (error) {
        if (active()) {
          r.job.error = describe(error);
          r.job.failures++;
          if (r.job.baseline) r.job.failedAttempts.push({ round: r.job.attempts.length + 1, error: r.job.error, at: new Date().toISOString() });
          await archive(r, `error-${r.job.failures}.json`, { error: r.job.error }).catch(() => {});
          r.job.status = r.job.baseline ? "ready" : "error";
          r.job.stage = "Failed";
        }
      } finally {
        // Only the current operation may clear the busy flag; a cancelled/superseded one never touches a newer run.
        if (r.token === token || r.job.status === "cancelled") r.pending = false;
        if (!active()) await clean(r);
        await archive(r, "job.json", r.job).catch(() => {});
      }
    })();
  };
  /** Accept a baseline only if physics reproduces the recorded failure: an airborne car–car collision. */
  const accept = async (r: Rec, scene: MidairScene) => {
    const result = await simulateMidair(scene);
    const half = await simulateMidair(scene, { dt: 1 / 960 });
    await archive(r, "baseline.json", { scene, result: strip(result), halfStep: strip(half) });
    if (result.outcome !== "midair_collision" || half.outcome !== "midair_collision")
      return `With this reconstruction physics gives "${result.reason}" (half timestep: "${half.reason}"), but the recording shows an airborne collision. The reconstruction does not reproduce the recorded failure.`;
    r.job.baseline = scene;
    r.job.baselineResult = strip(result);
    // Hidden witness (deterministic search, labeled; never sent to the critic).
    r.job.verification = { status: "searching" };
    void findLaneWitness(scene).then(({ witness, evaluated }) => {
      r.witness = witness;
      r.job.verification = witness ? { status: "verified", method: witness.method, evaluated } : { status: "none_found", evaluated };
    });
    return null;
  };

  router.get("/health", (_req, res) => res.json({ configured: api.configured, model: api.model, source: MIDAIR_SOURCE, mediaAvailable: existsSync(path.join(mediaDir, MIDAIR_SOURCE.file)) }));
  router.get("/media/:file", (req, res) => {
    if (req.params.file !== MIDAIR_SOURCE.file && req.params.file !== MIDAIR_SOURCE.slowMoFile) return void res.status(404).end();
    const file = path.join(mediaDir, req.params.file);
    if (!existsSync(file)) return void res.status(404).end();
    res.sendFile(file, { headers: { "Cache-Control": "no-cache" } });
  });

  /** Reference hand fit (labeled manual_fit). Works offline; never used as a fallback for a rejected Argon run. */
  router.post("/jobs/manual", async (_req, res) => {
    try {
      const r = make("manual_fit");
      const problem = await accept(r, MIDAIR_MANUAL_FIT);
      if (problem) throw new Error(problem);
      Object.assign(r.job, { status: "ready", stage: "Hand fit ready (reference, not Argon)" });
      await archive(r, "manifest.json", { version: "midair-v1", geometrySource: "manual_fit", source: MIDAIR_SOURCE, model: api.model });
      res.json(r.job);
    } catch (error) {
      res.status(400).json({ error: describe(error) });
    }
  });

  router.post("/jobs/reconstruct", (_req, res) => {
    if (!api.configured) return void res.status(503).json({ error: "Set GEMINI_API_KEY on the server to reconstruct the recording with Argon." });
    if (!existsSync(path.join(mediaDir, MIDAIR_SOURCE.file))) return void res.status(503).json({ error: "The licensed source clip is not available on this server." });
    let r: Rec;
    try {
      r = make("argon_inferred");
    } catch (error) {
      return void res.status(429).json({ error: describe(error) });
    }
    run(r, async (active) => {
      await archive(r, "manifest.json", { version: "midair-v1", geometrySource: "argon_inferred", source: MIDAIR_SOURCE, model: api.model });
      r.job.stage = "Uploading the recording to the Gemini Files API";
      const t0 = Date.now();
      r.source = await api.upload(path.join(mediaDir, MIDAIR_SOURCE.file), "video/mp4", active);
      r.job.timings.uploadMs = Date.now() - t0;
      if (!active()) return;
      r.job.stage = "Argon is reconstructing the scene from the recording";
      await archive(r, "reconstruction-request.json", { model: api.model, systemInstruction: api.instructions?.reconstruct ?? null, prompt: MIDAIR_RECONSTRUCT_PROMPT, video: MIDAIR_SOURCE.file });
      const t1 = Date.now();
      const raw = await api.reconstruct(r.source);
      r.job.timings.reconstructMs = Date.now() - t1;
      if (!active()) return;
      await archive(r, "reconstruction-response.json", raw);
      const parsed = MidairReconstructionSchema.parse(JSON.parse(raw));
      if (parsed.verdict !== "supported" || !parsed.scene) {
        Object.assign(r.job, { status: "unsupported", stage: parsed.reason });
        return;
      }
      const g = parsed.scene;
      r.job.observations = g.observations;
      r.job.reportedCollision = { carsTouched: g.carsTouched, collisionVideoSeconds: g.collisionVideoSeconds, bothAirborneAtCollision: g.bothAirborneAtCollision };
      const scene = sceneFromProportions(g, "argon_inferred", [`Proportions inferred by ${api.model} from the recording, in car lengths.`]);
      const u = scene.car.length;
      r.job.comparison = [
        { field: "gap (car lengths)", argon: g.gapCL, manual: +((MIDAIR_MANUAL_FIT.rampB.lipX - MIDAIR_MANUAL_FIT.rampA.lipX) / u).toFixed(2) },
        { field: "ramp A length", argon: g.rampA.lengthCL, manual: +(MIDAIR_MANUAL_FIT.rampA.length / u).toFixed(2) },
        { field: "ramp A pitch (°)", argon: g.rampA.pitchDeg, manual: MIDAIR_MANUAL_FIT.rampA.pitchDeg },
        { field: "ramp B length", argon: g.rampB.lengthCL, manual: +(MIDAIR_MANUAL_FIT.rampB.length / u).toFixed(2) },
        { field: "ramp B pitch (°)", argon: g.rampB.pitchDeg, manual: MIDAIR_MANUAL_FIT.rampB.pitchDeg },
        { field: "run-up A", argon: g.runUpACL, manual: +(MIDAIR_MANUAL_FIT.runUpA / u).toFixed(2) },
        { field: "run-up B", argon: g.runUpBCL, manual: +(MIDAIR_MANUAL_FIT.runUpB / u).toFixed(2) },
      ];
      if (!g.carsTouched || !g.bothAirborneAtCollision) {
        Object.assign(r.job, { status: "unsupported", stage: "Argon does not report an airborne collision, which the recording shows; the reconstruction is not used." });
        return;
      }
      const problem = await accept(r, scene);
      if (!active()) return;
      if (problem) {
        Object.assign(r.job, { status: "unsupported", stage: problem });
        return;
      }
      Object.assign(r.job, { status: "ready", stage: `Reconstructed by ${api.model}; physics reproduces the airborne collision` });
    });
    res.status(202).json({ id: r.job.id });
  });

  router.get("/jobs/:id", (req, res) => {
    expire();
    const r = records.get(req.params.id);
    if (!r) return void res.status(404).json({ error: "Run not found or expired." });
    res.json(r.job);
  });
  /**
   * A fresh AI playtest run on an accepted scene (same server-owned baseline, provenance and reconstruction record;
   * no re-inference). Each "Ask Argon" gets its own run, so Stop can cancel it on the server and a restart never
   * waits for, or receives, a stopped run's late result.
   */
  router.post("/jobs/:id/playtest", (req, res) => {
    const parent = records.get(req.params.id);
    if (!parent || !parent.job.baseline || parent.job.status === "cancelled") return void res.status(404).json({ error: "Accepted scene not found." });
    if (!api.configured) return void res.status(503).json({ error: "Set GEMINI_API_KEY for the live Argon loop." });
    let r: Rec;
    try {
      r = make(parent.job.geometrySource);
    } catch (error) {
      return void res.status(429).json({ error: describe(error) });
    }
    const { baseline, baselineResult, comparison, observations, reportedCollision, verification } = parent.job;
    Object.assign(r.job, { status: "ready", stage: "Ready for Argon", baseline, baselineResult, comparison, observations, reportedCollision, verification });
    r.source = parent.source;
    r.ownsSource = false;
    void archive(r, "manifest.json", { version: "midair-v1", playtestOf: parent.job.id, geometrySource: r.job.geometrySource, source: MIDAIR_SOURCE, model: api.model, baseline }).catch(() => {});
    res.json(r.job);
  });

  router.get("/jobs/:id/solution", (req, res) => {
    const r = records.get(req.params.id);
    if (!r) return void res.status(404).json({ error: "Run not found." });
    if (!r.witness) return void res.status(409).json({ error: r.job.verification.status === "searching" ? "Still searching for a verified solution." : "No verified solution was found within the search budget." });
    res.json({ jobId: r.job.id, witness: r.witness });
  });
  router.delete("/jobs/:id", (req, res) => {
    const r = records.get(req.params.id);
    if (r) {
      r.token++;
      Object.assign(r.job, { status: "cancelled", stage: "Cancelled" });
      if (!r.pending) void clean(r);
      r.expires = Date.now();
    }
    res.sendStatus(204);
  });

  const RepairSchema = z
    .object({
      jpegBase64: z.string().max(6_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
      times: z.array(z.number().finite().min(0).max(10)).min(2).max(16),
      currentMove: LaneMoveSchema.nullable(),
    })
    .strict();

  router.post("/jobs/:id/repair", (req, res) => {
    const r = records.get(req.params.id);
    const parsed = RepairSchema.safeParse(req.body);
    if (!r) return void res.status(404).json({ error: "Run not found." });
    if (!parsed.success) return void res.status(400).json({ error: "Invalid render or repair request." });
    if (!api.configured) return void res.status(503).json({ error: "Set GEMINI_API_KEY for the live Argon loop." });
    if (r.pending || r.job.status !== "ready" || !r.job.baseline) return void res.status(409).json({ error: "Run is not ready." });
    if (r.job.attempts.length >= MAX_ROUNDS || r.job.failures >= MAX_FAILURES) return void res.status(409).json({ error: "Repair limit reached. Start a new run." });
    const baseline = r.job.baseline;
    const body = parsed.data;
    let current: MidairScene;
    try {
      current = body.currentMove ? applyLaneMove(baseline, body.currentMove) : baseline;
    } catch (error) {
      return void res.status(400).json({ error: `The current attempt breaks the rule: ${describe(error)}` });
    }
    const image = Buffer.from(body.jpegBase64, "base64");
    if (image[0] !== 0xff || image[1] !== 0xd8) return void res.status(400).json({ error: "Contact sheet must be a JPEG." });
    Object.assign(r.job, { status: "repairing", error: undefined, stage: `${api.model} is comparing the recording with the side and top-down renders` });
    run(r, async (active) => {
      const start = Date.now();
      const round = r.job.attempts.length + 1;
      const name = `round-${round}-attempt-${r.job.failures}`;
      await archive(r, `${name}.jpg`, image);
      let source = api.model === MOCK_MIDAIR_MODEL ? undefined : r.source;
      if (api.model !== MOCK_MIDAIR_MODEL && !source) {
        source = r.source = await api.upload(path.join(mediaDir, MIDAIR_SOURCE.file), "video/mp4", active);
        r.ownsSource = true;
      }
      if (!active()) return;
      const currentResult = await simulateMidair(current);
      const payload = JSON.stringify({
        goal: "Both cars jump, cross the gap in the air without touching each other, and land upright and stable.",
        geometrySource: r.job.geometrySource,
        control: { name: "Move one launch lane", lane: ["A", "B"], offsetMeters: { min: -LANE_RULE.maxOffsetM, max: LANE_RULE.maxOffsetM, step: LANE_RULE.stepM }, meaning: "The chosen ramp and its car's start move sideways together by this offset from the baseline. Nothing else changes.", laneA: "left ramp, car drives +x", laneB: "right ramp, car drives -x" },
        success: `No car–car contact; each car crosses the gap center with all wheels off the ground (airtime ≥ ${MIDAIR_LANDING.minAirtime} s) and ends past the far lip upright (≤ ${MIDAIR_LANDING.maxTiltDeg}°), all wheels down, spin < ${MIDAIR_LANDING.maxSpin} rad/s, held ${MIDAIR_LANDING.holdSeconds} s.`,
        sheet: "Top row: side view (x right, y up). Bottom row: top-down view (x right, z down) at the same simulation times.",
        baseline,
        current,
        currentMove: body.currentMove,
        currentResult: strip(currentResult),
        frameTimes: body.times,
        priorAttempts: r.job.attempts.map((a) => ({ move: a.move, outcome: a.result.outcome, reason: a.result.reason })),
      });
      await archive(r, `${name}-request.json`, { model: api.model, systemInstruction: api.instructions?.critique ?? null, geometrySource: r.job.geometrySource, currentMove: body.currentMove, payload: JSON.parse(payload), image: `${name}.jpg` });
      const t0 = Date.now();
      const raw = await api.critique({ source, payload, jpegBase64: body.jpegBase64 });
      r.job.timings.critiqueMs.push(Date.now() - t0);
      if (!active()) return;
      await archive(r, `${name}-response.json`, raw);
      const critique = MidairCritiqueSchema.parse(JSON.parse(raw));
      let scene = current;
      if (critique.move) {
        try {
          scene = applyLaneMove(baseline, { lane: critique.move.lane, offsetM: critique.move.offsetM });
        } catch (error) {
          throw new Error(`The proposed move breaks the rule: ${describe(error)}`);
        }
      }
      const result = await simulateMidair(scene);
      if (!active()) return;
      const entry: MidairAttempt = { round, from: body.currentMove, assessment: critique.assessment, sourceEvidence: critique.sourceEvidence, renderEvidence: critique.renderEvidence, move: critique.move, result: strip(result), success: result.success, elapsedMs: Date.now() - start };
      await archive(r, `${name}-result.json`, entry);
      if (!active()) return;
      r.pending = false;
      r.job.attempts.push(entry);
      Object.assign(r.job, { status: "ready", stage: entry.success ? "Verified repair" : critique.move ? "Proposal did not work" : "No change proposed" });
    });
    res.status(202).json({ id: r.job.id });
  });

  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
  });
  setInterval(expire, 60_000).unref();
  return router;
}
