import RAPIER from "@dimforge/rapier3d-compat";
import { z } from "zod";
import { initPhysics } from "../physics/rapier";

/**
 * Midair: two RC cars drive at each other off facing kickers and collide in the air. Y up; ramp A (car A drives +X)
 * on the left, ramp B (car B drives −X) on the right; Z is sideways. Each "launch lane" is a ramp plus its car's
 * start, sharing one lateral offset. The cars are the same raycast-vehicle proxy as the stunt level, coasting at a
 * fixed speed from fixed release times; everything after release is Rapier.
 */

/**
 * Simple suspension for the raycast-vehicle car proxy (documented assumption, not measured): deliberately soft and
 * heavily damped, so it rides near the bottom of its travel and acts as a damped, nearly rigid wheel contact. Stiffer,
 * realistic springs made outcomes chaotic between neighboring settings and timesteps in a sweep.
 */
export const SUSPENSION = { restLength: 0.04, stiffness: 40, compression: 4, relaxation: 5, maxTravel: 0.035 } as const;

const finite = (min: number, max: number) => z.number().finite().min(min).max(max);
const RampSchema = z
  .object({
    /** X of the ramp's lip (its high, launching edge). */
    lipX: finite(-5, 5),
    length: finite(0.3, 3),
    pitchDeg: finite(3, 40),
    /** Lateral position of the lane (ramp and its car together). */
    laneZ: finite(-2, 2),
  })
  .strict();
export const MidairSceneSchema = z
  .object({
    kind: z.literal("midair"),
    rampA: RampSchema,
    rampB: RampSchema,
    rampWidth: finite(0.2, 1.5),
    /** Distance from each car's front bumper to its ramp's base at release. */
    runUpA: finite(0.05, 3),
    runUpB: finite(0.05, 3),
    car: z.object({ length: finite(0.1, 1), width: finite(0.05, 0.6), height: finite(0.02, 0.3), wheelRadius: finite(0.01, 0.15), massKg: finite(0.2, 20) }).strict(),
    /** Fixed approach speed, both cars, released at t = 0. */
    speed: finite(1, 20),
    geometrySource: z.enum(["argon_inferred", "manual_fit"]),
    assumptions: z.array(z.string().max(400)).max(16),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.rampA.lipX >= s.rampB.lipX) ctx.addIssue({ code: "custom", message: "Ramp A's lip must be left of ramp B's lip (they face each other across a gap)." });
  });
export type MidairScene = z.infer<typeof MidairSceneSchema>;

/** The level's only control: "Move one launch lane" — one lateral offset for ramp A or B and its car, together. */
export const LANE_RULE = { maxOffsetM: 1.0, stepM: 0.01 } as const;
export const LaneMoveSchema = z.object({ lane: z.enum(["A", "B"]), offsetM: z.number().finite() }).strict();
export type LaneMove = z.infer<typeof LaneMoveSchema>;
export class LaneRuleError extends Error {}

/** Shared validator for player moves, model proposals and witnesses. Returns the candidate scene. */
export function applyLaneMove(baseline: MidairScene, move: LaneMove): MidairScene {
  const m = LaneMoveSchema.parse(move);
  if (Math.abs(m.offsetM) > LANE_RULE.maxOffsetM + 1e-9) throw new LaneRuleError(`A lane can move at most ${LANE_RULE.maxOffsetM} m sideways.`);
  const snapped = Math.round(m.offsetM / LANE_RULE.stepM) * LANE_RULE.stepM;
  if (Math.abs(snapped - m.offsetM) > 1e-6) throw new LaneRuleError(`Lane offsets are set in ${LANE_RULE.stepM * 100} cm steps.`);
  const key = m.lane === "A" ? "rampA" : "rampB";
  return MidairSceneSchema.parse({ ...baseline, [key]: { ...baseline[key], laneZ: +(baseline[key].laneZ + snapped).toFixed(3) } });
}

/** Ramp geometry in world coordinates (shared by physics and renderer). */
export function rampGeometry(scene: MidairScene, which: "A" | "B") {
  const r = which === "A" ? scene.rampA : scene.rampB;
  const dir = which === "A" ? 1 : -1;
  const a = (r.pitchDeg * Math.PI) / 180;
  const baseX = r.lipX - dir * r.length * Math.cos(a);
  return { dir, a, baseX, lipX: r.lipX, lipY: r.length * Math.sin(a), z: r.laneZ, length: r.length };
}
export function carStart(scene: MidairScene, which: "A" | "B") {
  const g = rampGeometry(scene, which);
  const runUp = which === "A" ? scene.runUpA : scene.runUpB;
  return { x: g.baseX - g.dir * (runUp + scene.car.length / 2), z: g.z, dir: g.dir };
}

export interface CarPose {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  wheels: number[];
}
export interface MidairFrame {
  t: number;
  cars: [CarPose, CarPose];
}
export interface CarVerdict {
  car: "A" | "B";
  /** Crossed the gap centerline with all wheels off the ground. */
  crossedAirborne: boolean;
  maxAirtime: number;
  landedAt: number | null;
  rolledAt: number | null;
}
export type MidairOutcome = "both_landed" | "midair_collision" | "ground_collision" | "rollover" | "no_jump" | "unsettled";
export interface MidairResult {
  frames: MidairFrame[];
  success: boolean;
  outcome: MidairOutcome;
  decidedAt: number;
  collision: { t: number; airborne: boolean } | null;
  cars: [CarVerdict, CarVerdict];
  reason: string;
  duration: number;
}

/** Strict landing tolerances (documented; also shown in the UI). */
export const MIDAIR_LANDING = { maxTiltDeg: 25, maxSpin: 1.5, maxVerticalSpeed: 0.3, holdSeconds: 0.75, minAirtime: 0.2 } as const;

const quatZ = (a: number) => ({ x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) });

export async function simulateMidair(input: MidairScene, opts: { dt?: number; duration?: number } = {}): Promise<MidairResult> {
  const scene = MidairSceneSchema.parse(input);
  const dt = opts.dt ?? 1 / 480;
  const duration = opts.duration ?? 4;
  await initPhysics();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = dt;
  world.numSolverIterations = 12;
  const events = new RAPIER.EventQueue(true);
  const labels = new Map<number, string>();
  const fixed = (d: RAPIER.ColliderDesc, l: string) => labels.set(world.createCollider(d.setFriction(0.8).setRestitution(0.1)).handle, l);
  try {
    fixed(RAPIER.ColliderDesc.cuboid(60, 0.05, 60).setTranslation(0, -0.05, 0), "road");
    for (const which of ["A", "B"] as const) {
      const g = rampGeometry(scene, which);
      const t = 0.03;
      const cx = g.baseX + g.dir * ((g.length / 2) * Math.cos(g.a) + (t / 2) * Math.sin(g.a));
      const cy = (g.length / 2) * Math.sin(g.a) - (t / 2) * Math.cos(g.a);
      fixed(RAPIER.ColliderDesc.cuboid(g.length / 2, t / 2, scene.rampWidth / 2).setTranslation(cx, cy, g.z).setRotation(quatZ(g.dir * g.a)), `ramp${which}`);
    }
    const { car } = scene;
    const cars = (["A", "B"] as const).map((which) => {
      const s = carStart(scene, which);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(s.x, car.wheelRadius + SUSPENSION.restLength + car.height / 2, s.z)
          .setLinvel(s.dir * scene.speed, 0, 0)
          .setCcdEnabled(true)
          .setCanSleep(false),
      );
      if (s.dir < 0) body.setRotation({ x: 0, y: 1, z: 0, w: 0 }, true);
      const c = world.createCollider(RAPIER.ColliderDesc.cuboid(car.length / 2, car.height / 2, car.width / 2).setMass(car.massKg).setFriction(0.6).setRestitution(0.1).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), body);
      labels.set(c.handle, `car${which}`);
      const v = world.createVehicleController(body);
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          v.addWheel({ x: sx * (car.length / 2 - car.wheelRadius), y: -car.height / 2 + 0.015, z: sz * (car.width / 2 - car.wheelRadius * 0.5) }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: -1 }, SUSPENSION.restLength, car.wheelRadius);
          const k = v.numWheels() - 1;
          v.setWheelSuspensionStiffness(k, SUSPENSION.stiffness);
          v.setWheelSuspensionCompression(k, SUSPENSION.compression);
          v.setWheelSuspensionRelaxation(k, SUSPENSION.relaxation);
          v.setWheelMaxSuspensionTravel(k, SUSPENSION.maxTravel);
          v.setWheelFrictionSlip(k, 0.05);
        }
      return { which, body, v, dir: s.dir, crossed: false, airSince: null as number | null, maxAir: 0, stable: 0, landedAt: null as number | null, rolledAt: null as number | null, airborne: false };
    });
    const gA = rampGeometry(scene, "A"), gB = rampGeometry(scene, "B");
    const mid = (gA.lipX + gB.lipX) / 2;
    const cosTilt = Math.cos((MIDAIR_LANDING.maxTiltDeg * Math.PI) / 180);
    const frames: MidairFrame[] = [];
    const pose = (c: (typeof cars)[number]): CarPose => ({ position: { ...c.body.translation() }, rotation: { ...c.body.rotation() }, wheels: [0, 1, 2, 3].map((i) => +(c.v.wheelSuspensionLength(i) ?? SUSPENSION.restLength).toFixed(4)) });
    const captureEvery = Math.max(1, Math.round(1 / 60 / dt));
    frames.push({ t: 0, cars: [pose(cars[0]!), pose(cars[1]!)] });
    let collision: MidairResult["collision"] = null;
    let decided: { outcome: MidairOutcome; t: number; reason: string } | null = null;
    const steps = Math.round(duration / dt);
    for (let step = 1; step <= steps && !decided; step++) {
      const time = step * dt;
      for (const c of cars) c.v.updateVehicle(dt);
      world.step(events);
      events.drainCollisionEvents((h1, h2, started) => {
        const p = labels.get(h1), q = labels.get(h2);
        if (started && !collision && ((p === "carA" && q === "carB") || (p === "carB" && q === "carA"))) collision = { t: time, airborne: cars.every((c) => c.airborne) };
      });
      for (const c of cars) {
        const p = c.body.translation(), q = c.body.rotation(), w = c.body.angvel(), lv = c.body.linvel();
        const up = 1 - 2 * (q.x * q.x + q.z * q.z);
        const down = [0, 1, 2, 3].filter((i) => c.v.wheelIsInContact(i)).length;
        c.airborne = down === 0 && p.y > car.wheelRadius + car.height;
        c.airSince = c.airborne ? c.airSince ?? time : null;
        if (c.airSince !== null) c.maxAir = Math.max(c.maxAir, time - c.airSince);
        const side = c.dir * (p.x - mid);
        if (c.airborne && side > 0 && side < 0.1) c.crossed = true;
        if (up < 0 && c.rolledAt === null) c.rolledAt = time;
        const farLip = c.dir > 0 ? gB.lipX : gA.lipX;
        const ok = c.crossed && c.dir * (p.x - farLip) > -0.05 && up > cosTilt && down === 4 && Math.hypot(w.x, w.y, w.z) < MIDAIR_LANDING.maxSpin && Math.abs(lv.y) < MIDAIR_LANDING.maxVerticalSpeed;
        c.stable = ok ? c.stable + dt : 0;
        if (c.stable >= MIDAIR_LANDING.holdSeconds && c.landedAt === null) c.landedAt = time;
      }
      const col = collision as MidairResult["collision"];
      if (col) decided = { outcome: col.airborne ? "midair_collision" : "ground_collision", t: col.t, reason: col.airborne ? "the cars collided in mid-air" : "the cars collided" };
      else if (cars.some((c) => c.rolledAt !== null)) {
        const c = cars.find((x) => x.rolledAt !== null)!;
        decided = { outcome: "rollover", t: c.rolledAt!, reason: `car ${c.which} rolled over` };
      } else if (cars.every((c) => c.landedAt !== null && c.maxAir >= MIDAIR_LANDING.minAirtime)) decided = { outcome: "both_landed", t: Math.max(...cars.map((c) => c.landedAt!)), reason: "both cars jumped, passed each other and landed upright" };
      if (step % captureEvery === 0 || decided) frames.push({ t: time, cars: [pose(cars[0]!), pose(cars[1]!)] });
    }
    // A little playback after the decision so the replay shows the consequence.
    const end = decided?.t ?? duration;
    const tail = Math.min(duration, end + 0.8);
    for (let step = Math.round(end / dt) + 1; step <= Math.round(tail / dt); step++) {
      for (const c of cars) c.v.updateVehicle(dt);
      world.step(events);
      if (step % captureEvery === 0) frames.push({ t: step * dt, cars: [pose(cars[0]!), pose(cars[1]!)] });
    }
    const verdicts = cars.map((c) => ({ car: c.which, crossedAirborne: c.crossed, maxAirtime: +c.maxAir.toFixed(3), landedAt: c.landedAt, rolledAt: c.rolledAt })) as [CarVerdict, CarVerdict];
    const final =
      decided ??
      (cars.some((c) => !c.crossed)
        ? { outcome: "no_jump" as const, t: duration, reason: `car ${cars.find((c) => !c.crossed)!.which} never crossed the gap in the air` }
        : { outcome: "unsettled" as const, t: duration, reason: "a car never landed upright and stable" });
    return { frames, success: final.outcome === "both_landed", outcome: final.outcome, decidedAt: final.t, collision, cars: verdicts, reason: final.reason, duration: tail };
  } finally {
    events.free();
    world.free();
  }
}

/**
 * Deterministic sweep for a hidden witness: each lane, offsets in 5 cm steps. A candidate qualifies only if it wins
 * at dt 1/480 and 1/960 and both 5 cm neighbors win. Labeled as search, never as model reasoning.
 */
export async function findLaneWitness(baseline: MidairScene) {
  const step = 0.05;
  let evaluated = 0;
  const cache = new Map<string, boolean>();
  const wins = async (m: LaneMove, dt = 1 / 480) => {
    const key = `${m.lane}${m.offsetM}${dt}`;
    if (!cache.has(key)) {
      evaluated++;
      let ok = false;
      try {
        ok = (await simulateMidair(applyLaneMove(baseline, m), { dt })).success;
      } catch {
        ok = false;
      }
      cache.set(key, ok);
      await new Promise((r) => setTimeout(r, 0));
    }
    return cache.get(key)!;
  };
  for (const lane of ["B", "A"] as const)
    for (let k = 1; k * step <= LANE_RULE.maxOffsetM - step + 1e-9; k++)
      for (const sign of [1, -1]) {
        const offsetM = +(sign * k * step).toFixed(2);
        const m = { lane, offsetM };
        if (!(await wins(m))) continue;
        const n1 = { lane, offsetM: +(offsetM - step).toFixed(2) }, n2 = { lane, offsetM: +(offsetM + step).toFixed(2) };
        if ((await wins(n1)) && (await wins(n2)) && (await wins(m, 1 / 960))) return { witness: { ...m, method: "deterministic_lane_sweep" as const, checks: ["dt 1/480", "dt 1/960", "±5 cm neighbors"] }, evaluated };
      }
  return { witness: null, evaluated };
}
