import express from "express";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MIDAIR_MANUAL_FIT as M } from "../src/midair/level";
import { applyLaneMove, LaneRuleError, MidairSceneSchema, simulateMidair } from "../src/midair/midair";
import { createMidairRouter, type MidairJob, type MidairProvider } from "../src/midair/server";

describe("midair physics (two raycast cars, actual ramps)", () => {
  test("the baseline reproduces an airborne car–car collision at both timesteps", async () => {
    for (const dt of [1 / 480, 1 / 960]) {
      const r = await simulateMidair(M, { dt });
      expect(r.outcome).toBe("midair_collision");
      expect(r.collision?.airborne).toBe(true);
      expect(r.decidedAt).toBeCloseTo(0.42, 1);
    }
  });
  test("moving one launch lane 0.45–0.9 m lands both cars; 0.40 rolls over on the other ramp's edge", async () => {
    for (const offsetM of [0.45, 0.6, 0.9, -0.6])
      for (const dt of [1 / 480, 1 / 960]) {
        const r = await simulateMidair(applyLaneMove(M, { lane: "B", offsetM }), { dt });
        expect(r.outcome, `${offsetM} @ ${dt}`).toBe("both_landed");
        for (const c of r.cars) {
          expect(c.crossedAirborne).toBe(true);
          expect(c.maxAirtime).toBeGreaterThan(0.2);
        }
      }
    expect((await simulateMidair(applyLaneMove(M, { lane: "B", offsetM: 0.4 }))).outcome).toBe("rollover");
    expect((await simulateMidair(applyLaneMove(M, { lane: "A", offsetM: 0.6 }))).success).toBe(true);
  });
  test("no win without a real jump: too slow to cross the gap in the air is not a landing", async () => {
    const slow = MidairSceneSchema.parse({ ...M, speed: 3, rampB: { ...M.rampB, laneZ: 0.8 } });
    const r = await simulateMidair(slow);
    expect(r.success).toBe(false);
    expect(r.cars.some((c) => !c.crossedAirborne)).toBe(true);
  });
  test("one shared validator: one lane, the ramp and its car together, bounded, 1 cm grid", () => {
    const s = applyLaneMove(M, { lane: "B", offsetM: 0.6 });
    expect(s.rampB.laneZ).toBe(0.6);
    expect(s.rampA).toEqual(M.rampA);
    expect({ ...s, rampB: M.rampB }).toEqual(M);
    for (const bad of [1.01, -1.2, 0.605]) expect(() => applyLaneMove(M, { lane: "B", offsetM: bad })).toThrow(LaneRuleError);
  });
});

describe("midair server", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });
  const recon = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      verdict: "supported",
      reason: "two facing ramps",
      scene: { gapCL: 2.7, rampA: { lengthCL: 2.36, pitchDeg: 19.6 }, rampB: { lengthCL: 2.67, pitchDeg: 16 }, runUpACL: 1, runUpBCL: 1, carsTouched: true, collisionVideoSeconds: 1.75, bothAirborneAtCollision: true, observations: [{ timeSeconds: 0, description: "start" }, { timeSeconds: 1.75, description: "collide" }], ...over },
    });
  const critique = (move: unknown) => JSON.stringify({ assessment: "test", sourceEvidence: "video 1.75 s", renderEvidence: "top-down t=0.42", move });
  async function setup(over: Partial<MidairProvider> = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), "midair-test-"));
    const provider: MidairProvider = {
      configured: true,
      model: "fake-argon",
      instructions: { reconstruct: "TEST RECON", critique: "TEST CRITIQUE" },
      upload: async () => ({ name: "files/x", uri: "gs://x", mimeType: "video/mp4" }),
      remove: async () => {},
      reconstruct: async () => recon(),
      critique: async () => critique({ lane: "B", offsetM: 0.6, reason: "separate lanes" }),
      ...over,
    };
    const app = express();
    app.use(express.json({ limit: "8mb" }));
    app.use("/m", createMidairRouter({ provider, runRoot: dir, mediaDir: path.resolve("demo/media/rc-free") }));
    const server = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    cleanup.push(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/m`;
    const get = async (id: string) => (await (await fetch(`${url}/jobs/${id}`)).json()) as MidairJob;
    const settle = async (id: string) => {
      for (let i = 0; i < 600; i++) {
        const j = await get(id);
        if (j.status !== "analyzing" && j.status !== "repairing" && j.verification.status !== "searching") return j;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("timeout");
    };
    return { url, dir, get, settle };
  }
  const haveClip = async () => !!(await import("node:fs")).existsSync("demo/media/rc-free/rc-midair-crash-source-speed.mp4");

  test("an Argon reconstruction is accepted only if physics reproduces the airborne collision; labeled argon_inferred", async () => {
    if (!(await haveClip())) return;
    const s = await setup();
    const { id } = (await (await fetch(`${s.url}/jobs/reconstruct`, { method: "POST" })).json()) as { id: string };
    const j = await s.settle(id);
    expect(j.status).toBe("ready");
    expect(j.geometrySource).toBe("argon_inferred");
    expect(j.baseline?.geometrySource).toBe("argon_inferred");
    expect(j.baselineResult?.outcome).toBe("midair_collision");
    expect(j.comparison?.length).toBe(7);
    expect(JSON.stringify(j)).not.toMatch(/witness/);
    const req = JSON.parse(await readFile(path.join(s.dir, `midair-${id}`, "reconstruction-request.json"), "utf8"));
    expect(req.systemInstruction).toBe("TEST RECON");
  });

  test("a reconstruction that does not reproduce the collision is rejected — the hand fit is never substituted", async () => {
    if (!(await haveClip())) return;
    const s = await setup({ reconstruct: async () => recon({ gapCL: 9 }) });
    const { id } = (await (await fetch(`${s.url}/jobs/reconstruct`, { method: "POST" })).json()) as { id: string };
    const j = await s.settle(id);
    expect(j.status).toBe("unsupported");
    expect(j.stage).toMatch(/does not reproduce the recorded failure/);
    expect(j.baseline).toBeUndefined();
    const s2 = await setup({ reconstruct: async () => recon({ bothAirborneAtCollision: false }) });
    const r2 = (await (await fetch(`${s2.url}/jobs/reconstruct`, { method: "POST" })).json()) as { id: string };
    expect((await s2.settle(r2.id)).baseline).toBeUndefined();
  });

  test("critique: physics verifies a legal proposal; illegal ones are failed requests; exact instruction and bounds archived, no witness", async () => {
    const s = await setup();
    const job = (await (await fetch(`${s.url}/jobs/manual`, { method: "POST" })).json()) as MidairJob;
    expect(job.geometrySource).toBe("manual_fit");
    await s.settle(job.id);
    const post = (currentMove: unknown) => fetch(`${s.url}/jobs/${job.id}/repair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jpegBase64: "/9j/2Q==", times: [0.1, 0.4], currentMove }) });
    expect((await post({ lane: "B", offsetM: 1.5 })).status).toBe(400);
    expect((await post(null)).status).toBe(202);
    const done = await s.settle(job.id);
    expect(done.attempts[0]).toMatchObject({ success: true, move: { lane: "B", offsetM: 0.6 } });
    const req = JSON.parse(await readFile(path.join(s.dir, `midair-${job.id}`, "round-1-attempt-0-request.json"), "utf8"));
    expect(req.systemInstruction).toBe("TEST CRITIQUE");
    expect(req.payload.control).toMatchObject({ name: "Move one launch lane", offsetMeters: { min: -1, max: 1, step: 0.01 } });
    expect(JSON.stringify(req.payload)).not.toMatch(/witness|solution|lane_sweep/);

    const bad = await setup({ critique: async () => critique({ lane: "B", offsetM: 2, reason: "too far" }) });
    const j2 = (await (await fetch(`${bad.url}/jobs/manual`, { method: "POST" })).json()) as MidairJob;
    await fetch(`${bad.url}/jobs/${j2.id}/repair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jpegBase64: "/9j/2Q==", times: [0.1, 0.4], currentMove: null }) });
    const d2 = await bad.settle(j2.id);
    expect(d2.attempts).toHaveLength(0);
    expect(d2.failedAttempts[0]!.error).toMatch(/proposed move breaks the rule/);
  });

  test("Stop: a cancelled playtest run never appends a late result, clears its busy state, and a fresh run starts at once", async () => {
    let release!: (v: string) => void;
    let calls = 0;
    const s = await setup({ critique: () => (++calls === 1 ? new Promise((r) => (release = r)) : Promise.resolve(critique({ lane: "B", offsetM: 0.6, reason: "ok" }))) });
    const job = (await (await fetch(`${s.url}/jobs/manual`, { method: "POST" })).json()) as MidairJob;
    await s.settle(job.id);
    const playtest = async () => (await (await fetch(`${s.url}/jobs/${job.id}/playtest`, { method: "POST" })).json()) as MidairJob;
    const repair = (id: string) => fetch(`${s.url}/jobs/${id}/repair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jpegBase64: "/9j/2Q==", times: [0.1, 0.4], currentMove: null }) });
    const first = await playtest();
    expect((await repair(first.id)).status).toBe(202);
    await new Promise((r) => setTimeout(r, 300));
    await fetch(`${s.url}/jobs/${first.id}`, { method: "DELETE" });
    const second = await playtest();
    expect((await repair(second.id)).status).toBe(202);
    expect((await s.settle(second.id)).attempts[0]?.success).toBe(true);
    release(critique({ lane: "A", offsetM: 0.8, reason: "late" }));
    await new Promise((r) => setTimeout(r, 400));
    const late = await fetch(`${s.url}/jobs/${first.id}`);
    expect(late.status).toBe(404); // cancelled, no longer busy, so it expired
    expect((await s.get(second.id)).attempts).toHaveLength(1);
  });
});
