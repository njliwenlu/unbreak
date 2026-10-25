import { MidairSceneSchema, type MidairScene } from "./midair";

/** The licensed source recording (CC BY). Served read-only by the midair server from a local path. */
export const MIDAIR_SOURCE = {
  file: "rc-midair-crash-source-speed.mp4",
  slowMoFile: "rc-midair-crash-preview.mp4",
  url: "/api/midair/media/rc-midair-crash-source-speed.mp4",
  slowMoUrl: "/api/midair/media/rc-midair-crash-preview.mp4",
  title: "Head on, mid air, off ramps, crashes and collisions, Traxxas RC slash vs rustler, slow motion",
  author: "billisa",
  origin: "https://www.youtube.com/watch?v=kZ_n8cPitD8",
  license: "CC BY (YouTube Creative Commons Attribution)",
  attribution: "“Head on, mid air, off ramps, crashes and collisions, Traxxas RC slash vs rustler, slow motion” by billisa (YouTube), CC BY. Excerpt, unmodified apart from trimming; no endorsement implied.",
  timingNote: "Source-speed excerpt; capture timing is not verified as real time. The slow-motion excerpt is for visual inspection only.",
} as const;

/** Assumed absolute scale: the footage has no measured length reference. */
export const ASSUMED_CAR_LENGTH_M = 0.45;
/** Calibrated (not measured) approach speed: the lowest robust lone-car mid-gap airborne crossing was 6 m/s. */
export const CALIBRATED_SPEED_MS = 7;

const CAR = { length: ASSUMED_CAR_LENGTH_M, width: 0.25, height: 0.1, wheelRadius: 0.06, massKg: 3 };

/**
 * Build a scene from proportions in CAR LENGTHS (the unit both a person and Argon can read off a frame).
 * Lip positions are measured from the gap center.
 */
export function sceneFromProportions(p: { gapCL: number; rampA: { lengthCL: number; pitchDeg: number }; rampB: { lengthCL: number; pitchDeg: number }; runUpACL: number; runUpBCL: number }, source: MidairScene["geometrySource"], assumptions: string[]): MidairScene {
  const u = ASSUMED_CAR_LENGTH_M;
  return MidairSceneSchema.parse({
    kind: "midair",
    rampA: { lipX: +(-(p.gapCL * u) / 2).toFixed(3), length: +(p.rampA.lengthCL * u).toFixed(3), pitchDeg: +p.rampA.pitchDeg.toFixed(1), laneZ: 0 },
    rampB: { lipX: +((p.gapCL * u) / 2).toFixed(3), length: +(p.rampB.lengthCL * u).toFixed(3), pitchDeg: +p.rampB.pitchDeg.toFixed(1), laneZ: 0 },
    rampWidth: 0.6,
    runUpA: +(p.runUpACL * u).toFixed(3),
    runUpB: +(p.runUpBCL * u).toFixed(3),
    car: CAR,
    speed: CALIBRATED_SPEED_MS,
    geometrySource: source,
    assumptions: [
      `Absolute scale assumed: car length ${u} m (the cars are Traxxas 1/10 models per the video title; not measured).`,
      `Approach speed ${CALIBRATED_SPEED_MS} m/s for both cars is CALIBRATED, not measured: it is in the range where each car alone crosses the gap mid-point in the air (as in the footage). Clip timing is not used.`,
      "Both cars released at the same instant; ramps 0.6 m wide; same raycast-vehicle car proxy as the stunt level (soft, heavily damped suspension; no motor).",
      "Cars drive straight along their lanes; real drivers steer — not modeled.",
      ...assumptions,
    ],
  });
}

/** Hand-measured on frame 0 of the source-speed clip (pixels → car lengths at ~95 px per car). Reference only. */
export const MIDAIR_MANUAL_FIT: MidairScene = sceneFromProportions(
  { gapCL: 2.7, rampA: { lengthCL: 2.36, pitchDeg: 19.6 }, rampB: { lengthCL: 2.67, pitchDeg: 16 }, runUpACL: 1.0, runUpBCL: 1.0 },
  "manual_fit",
  ["Geometry hand-measured on frame 0 (perspective ignored). Not inferred by Argon."],
);
