import { useEffect, useRef, useState } from "react";
import { MIDAIR_SOURCE } from "./level";
import { applyLaneMove, LANE_RULE, simulateMidair, type LaneMove, type MidairResult, type MidairScene } from "./midair";
import { MidairRenderer } from "./midairRenderer";
import type { MidairJob } from "./server";
import "./midair.css";

const API = "/api/midair";
async function json<T>(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { ...init, signal });
  const data = res.status === 204 ? ({} as T) : ((await res.json()) as T & { error?: string });
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data;
}
const OUTCOME: Record<MidairResult["outcome"], string> = {
  both_landed: "Made it work. Both cars jumped, passed and landed upright.",
  midair_collision: "Mid-air collision.",
  ground_collision: "The cars collided.",
  rollover: "Rollover.",
  no_jump: "A car never made the jump.",
  unsettled: "No clean landing.",
};
/** Synchronized sheet times: approach, launch, the crossing/collision, after, decision. */
export function sheetTimes(r: MidairResult): number[] {
  const c = r.collision?.t ?? Math.min(...r.cars.map((x) => x.landedAt ?? r.decidedAt)) - 0.9;
  return [...new Set([0.12, Math.max(0.15, c - 0.15), c, c + 0.2, r.decidedAt].map((t) => +Math.max(0, Math.min(r.duration, t)).toFixed(2)))].sort((a, b) => a - b);
}

interface Card { id: number; loop: number; scene: MidairScene; n: number; attempt: number; image: string; times: number[]; sent: LaneMove | null; state: "waiting" | "done" | "failed"; text?: string; evidence?: string; proposed?: (LaneMove & { reason: string }) | null; outcome?: string; success?: boolean; ms?: number; error?: string }

/** Midair: the real clip, its reconstruction, one control ("Move one launch lane"), physics, and Argon. */
export function MidairScreen() {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<MidairRenderer | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const jobRef = useRef<string | null>(null);
  const [health, setHealth] = useState<{ configured: boolean; model: string } | null>(null);
  const [job, setJob] = useState<MidairJob | null>(null);
  const [busy, setBusy] = useState("");
  const [lane, setLane] = useState<"A" | "B">("B");
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<"cinematic" | "top" | "side">("cinematic");
  const [run, setRun] = useState<{ move: LaneMove | null; scene: MidairScene; result: MidairResult } | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [aiState, setAiState] = useState<"idle" | "running" | "done">("idle");
  const [aiMsg, setAiMsg] = useState("");
  const aiCtrl = useRef<AbortController | null>(null);
  const aiLoop = useRef(0);
  const aiRun = useRef<string | null>(null);
  const [replayOf, setReplayOf] = useState<{ lane: "A" | "B"; offsetM: number; sameScene: boolean } | null>(null);
  const nextCard = useRef(0);
  /** The user chose to continue with the hand-fitted scene instead of recreating it from the video. */
  const [choseHandFit, setChoseHandFit] = useState(false);
  /** Shown once after a reconstruction is accepted and its crash has auto-played. */
  const [ready, setReady] = useState(false);
  const [viewer, setViewer] = useState<Card | null>(null);
  const baseline = job?.baseline ?? null;
  const move: LaneMove | null = offset === 0 ? null : { lane, offsetM: offset };
  const mock = health?.model.startsWith("MOCK") ?? false;

  const drop = () => {
    if (jobRef.current) void fetch(`${API}/jobs/${jobRef.current}`, { method: "DELETE" }).catch(() => {});
    jobRef.current = null;
  };
  const startJob = async (kind: "manual" | "reconstruct") => {
    const token = ++generation.current;
    aiLoop.current++;
    aiCtrl.current?.abort();
    if (aiRun.current) void fetch(`${API}/jobs/${aiRun.current}`, { method: "DELETE" }).catch(() => {});
    aiRun.current = null;
    setAiState("idle");
    setCards([]);
    setError("");
    setReady(false);
    setBusy(kind === "manual" ? "Loading the hand-fitted reference…" : "Argon is reconstructing the scene from the recording…");
    try {
      if (kind === "manual") {
        const j = await json<MidairJob>(`${API}/jobs/manual`, { method: "POST" });
        if (generation.current !== token || !alive.current) return void fetch(`${API}/jobs/${j.id}`, { method: "DELETE" });
        drop();
        jobRef.current = j.id;
        setJob(j);
      } else {
        const { id } = await json<{ id: string }>(`${API}/jobs/reconstruct`, { method: "POST" });
        let j: MidairJob;
        do {
          await new Promise((r) => setTimeout(r, 1000));
          j = await json<MidairJob>(`${API}/jobs/${id}`);
          if (generation.current !== token || !alive.current) return void fetch(`${API}/jobs/${id}`, { method: "DELETE" });
          setBusy(j.stage);
        } while (j.status === "analyzing");
        if (!j.baseline) {
          void fetch(`${API}/jobs/${id}`, { method: "DELETE" });
          throw new Error(`Argon reconstruction rejected: ${j.error ?? j.stage}. The displayed scene is unchanged.`);
        }
        drop();
        jobRef.current = id;
        setJob(j);
        // Show the recreated crash once, so the next step (let Argon fix it) is obvious.
        const crash = await simulateMidair(j.baseline);
        if (generation.current !== token || !alive.current) return;
        setOffset(0);
        setReplayOf(null);
        setView("cinematic");
        setRun({ move: null, scene: j.baseline, result: crash });
        setTime(0);
        setPlaying(true);
        setReady(true);
        return;
      }
      setRun(null);
      setOffset(0);
    } catch (e) {
      if (generation.current === token && alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (generation.current === token && alive.current) setBusy("");
    }
  };

  useEffect(() => {
    alive.current = true;
    if (host.current) renderer.current = new MidairRenderer(host.current);
    void json<{ configured: boolean; model: string }>(`${API}/health`).then((h) => alive.current && setHealth(h)).catch(() => {});
    void startJob("manual");
    return () => {
      alive.current = false;
      generation.current++;
      aiLoop.current++;
      aiCtrl.current?.abort();
      if (aiRun.current) void fetch(`${API}/jobs/${aiRun.current}`, { method: "DELETE" }).catch(() => {});
      drop();
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, []);
  // Poll verification state of the job (witness search runs server-side).
  useEffect(() => {
    if (!job || job.verification.status !== "searching") return;
    const t = setTimeout(() => void json<MidairJob>(`${API}/jobs/${job.id}`).then((j) => alive.current && jobRef.current === j.id && setJob(j)).catch(() => {}), 800);
    return () => clearTimeout(t);
  }, [job]);

  const editScene = baseline ? (move ? safeMove(baseline, move) : baseline) : null;
  useEffect(() => {
    const r = renderer.current;
    if (!r || !baseline) return;
    r.load(run ? run.scene : editScene ?? baseline, baseline);
  }, [baseline, run, lane, offset]);
  useEffect(() => renderer.current?.setView(view), [view]);
  useEffect(() => {
    if (!run) return;
    const f = run.result.frames;
    renderer.current?.setFrame(f.reduce((a, b) => (Math.abs(b.t - time) < Math.abs(a.t - time) ? b : a)));
  }, [time, run]);
  useEffect(() => {
    if (!playing || !run) return;
    const end = run.result.frames.at(-1)!.t;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * 0.5;
      last = now;
      setTime((t) => (t + dt >= end ? (setPlaying(false), end) : t + dt));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, run]);

  // Lane drag: in the top-down view, dragging on the road moves the selected launch lane sideways. Listeners are
  // bound once per canvas and read current state through refs, so a drag survives the rerenders it causes.
  const live = useRef({ view, offset, baseline: baseline as MidairScene | null, edit: (_o: number) => {} });
  live.current = { view, offset, baseline, edit };
  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    let start: { z: number; offset: number; id: number } | null = null;
    const down = (e: PointerEvent) => {
      const s = live.current;
      if (s.view !== "top" || !s.baseline || e.button !== 0) return;
      const z = r.roadZ(e.clientX, e.clientY);
      if (z === null) return;
      start = { z, offset: s.offset, id: e.pointerId };
      r.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const moveH = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const z = r.roadZ(e.clientX, e.clientY);
      if (z !== null) live.current.edit(start.offset + (z - start.z));
    };
    const up = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      if (r.canvas.hasPointerCapture(e.pointerId)) r.canvas.releasePointerCapture(e.pointerId);
      start = null;
    };
    r.canvas.addEventListener("pointerdown", down);
    r.canvas.addEventListener("pointermove", moveH);
    r.canvas.addEventListener("pointerup", up);
    r.canvas.addEventListener("pointercancel", up);
    return () => {
      r.canvas.removeEventListener("pointerdown", down);
      r.canvas.removeEventListener("pointermove", moveH);
      r.canvas.removeEventListener("pointerup", up);
      r.canvas.removeEventListener("pointercancel", up);
    };
  }, []);

  function edit(o: number) {
    if (busy) return;
    generation.current++;
    setReplayOf(null);
    setRun(null);
    setPlaying(false);
    setOffset(Math.max(-LANE_RULE.maxOffsetM, Math.min(LANE_RULE.maxOffsetM, Math.round(o / LANE_RULE.stepM) * LANE_RULE.stepM)));
  }
  async function launch() {
    if (!baseline || busy) return;
    const token = ++generation.current;
    setError("");
    try {
      const scene = move ? applyLaneMove(baseline, move) : baseline;
      const result = await simulateMidair(scene);
      if (generation.current !== token || !alive.current) return;
      setReplayOf(null);
      setReady(false);
      if (move && view === "cinematic") setView("top");
      setRun({ move, scene, result });
      setTime(0);
      setPlaying(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function reset() {
    if (busy) return;
    generation.current++;
    setReplayOf(null);
    setRun(null);
    setPlaying(false);
    setOffset(0);
  }

  /**
   * Each Ask runs on its own server playtest run (copied from the accepted scene). A loop token owns every UI update;
   * Stop aborts the browser side AND cancels the run on the server, so a restart is immediate and a stopped run's late
   * result can neither append an attempt nor touch the new loop's cards.
   */
  async function askArgon() {
    const r = renderer.current;
    if (!job || !baseline || !r) return;
    const loop = ++aiLoop.current;
    const owns = () => alive.current && aiLoop.current === loop;
    stopServerRun();
    aiCtrl.current?.abort();
    const ctrl = new AbortController();
    aiCtrl.current = ctrl;
    const { signal } = ctrl;
    const sceneOfLoop = baseline;
    setCards([]);
    setReady(false);
    setAiState("running");
    setAiMsg("Starting a fresh Argon run on this scene…");
    const attempts = new Map<number, number>();
    try {
      const play = await json<MidairJob>(`${API}/jobs/${job.id}/playtest`, { method: "POST" }, signal);
      if (!owns()) return void fetch(`${API}/jobs/${play.id}`, { method: "DELETE" }).catch(() => {});
      aiRun.current = play.id;
      let current = run?.move ?? move;
      // Deterministic: re-simulating the attempt on this loop's scene gives exactly what the player saw.
      let result = await simulateMidair(current ? applyLaneMove(sceneOfLoop, current) : sceneOfLoop);
      for (let n = 1; n <= 3; n++) {
        if (!owns()) return;
        const scene = current ? applyLaneMove(sceneOfLoop, current) : sceneOfLoop;
        const sheet = r.captureSheet(scene, result.frames, sheetTimes(result));
        r.load(run ? run.scene : editScene ?? sceneOfLoop, sceneOfLoop);
        const id = nextCard.current++;
        const attempt = attempts.get(n) ?? 1;
        attempts.set(n, attempt + 1);
        setCards((cs) => [...cs, { id, loop, scene: sceneOfLoop, n, attempt, image: `data:image/jpeg;base64,${sheet.jpegBase64}`, times: sheet.times, sent: current, state: "waiting" }]);
        setAiMsg(`Round ${n}: ${mock ? "the scripted mock critic" : job.model} is comparing the recording with the side and top-down renders…`);
        const before = (await json<MidairJob>(`${API}/jobs/${play.id}`, {}, signal)).failures;
        await json(`${API}/jobs/${play.id}/repair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...sheet, currentMove: current }) }, signal);
        let next: MidairJob;
        do {
          await new Promise<void>((res, rej) => {
            const t = setTimeout(res, 500);
            signal.addEventListener("abort", () => (clearTimeout(t), rej(new DOMException("Stopped", "AbortError"))), { once: true });
          });
          next = await json<MidairJob>(`${API}/jobs/${play.id}`, {}, signal);
        } while (next.status === "repairing");
        if (!owns()) return;
        const update = (patch: Partial<Card>) => setCards((cs) => cs.map((c) => (c.id === id && c.loop === loop ? { ...c, ...patch } : c)));
        if (next.failures > before) {
          update({ state: "failed", error: next.error });
          if (next.failures >= 2) return void (setAiMsg("Two critic requests failed; stopped."), setAiState("done"));
          n--;
          continue;
        }
        const a = next.attempts.at(-1)!;
        update({ state: "done", text: a.assessment, evidence: `${a.sourceEvidence} — ${a.renderEvidence}`, proposed: a.move, outcome: a.result.outcome, success: a.success, ms: a.elapsedMs });
        if (a.success) return void (setAiMsg(`Physics verified Argon's change in round ${n}.`), setAiState("done"));
        if (!a.move || (current && a.move.lane === current.lane && a.move.offsetM === current.offsetM)) return void (setAiMsg(a.move ? "Same proposal again; stopped." : "No change proposed; stopped."), setAiState("done"));
        current = { lane: a.move.lane, offsetM: a.move.offsetM };
        result = await simulateMidair(applyLaneMove(sceneOfLoop, current));
      }
      setAiMsg("Three rounds used without a verified fix.");
      setAiState("done");
    } catch (e) {
      if (!owns() || (e instanceof DOMException && e.name === "AbortError")) return;
      setAiMsg(e instanceof Error ? e.message : String(e));
      setAiState("done");
    }
  }
  function stopServerRun() {
    if (aiRun.current) void fetch(`${API}/jobs/${aiRun.current}`, { method: "DELETE" }).catch(() => {});
    aiRun.current = null;
  }
  function stopArgon() {
    aiLoop.current++;
    aiCtrl.current?.abort();
    stopServerRun();
    setCards((cs) => cs.map((c) => (c.state === "waiting" ? { ...c, state: "failed", error: "Stopped by you; this request no longer counts." } : c)));
    setAiState("done");
    setAiMsg("Stopped. The run was cancelled on the server; nothing after this point is counted.");
  }
  /** Replay the exact verified proposal on the exact scene it was verified on (not whatever is on screen now). */
  async function replayFix(c: Card) {
    if (!c.proposed) return;
    const token = ++generation.current;
    const m = { lane: c.proposed.lane, offsetM: c.proposed.offsetM };
    const scene = applyLaneMove(c.scene, m);
    const result = await simulateMidair(scene);
    if (generation.current !== token || !alive.current) return;
    if (c.scene === baseline) {
      setLane(m.lane);
      setOffset(m.offsetM);
    }
    setReplayOf({ lane: m.lane, offsetM: m.offsetM, sameScene: c.scene === baseline });
    setReady(false);
    setView("top");
    setRun({ move: m, scene, result });
    setTime(0);
    setPlaying(true);
  }

  const decided = !!run && time >= run.result.decidedAt - 1e-9;
  const geometry = baseline?.geometrySource;
  const canReconstruct = !!health?.configured && !mock;
  const canAskArgon = !!health?.configured;
  const lastWin = [...cards].reverse().find((c) => c.success && c.proposed) ?? null;
  // One obvious next step: recreate the crash from the video, then let Argon find a better ending, then replay it.
  const step: "recreate" | "fix" | "replay" = geometry !== "argon_inferred" && canReconstruct && !choseHandFit ? "recreate" : lastWin ? "replay" : "fix";
  const steps = [
    { key: "recreate", label: "Recreate this crash" },
    { key: "fix", label: "Find a better ending" },
    { key: "replay", label: "Replay the fix" },
  ] as const;
  const stepIndex = steps.findIndex((x) => x.key === step);
  const status = busy || (aiState === "running" ? aiMsg : ready && step === "fix" ? "Scene ready. Now let Argon try a fix." : aiMsg);

  let primary: { label: string; onClick?: () => void; disabled?: boolean; stop?: boolean };
  if (busy) primary = { label: busy.startsWith("Loading") ? "Loading…" : "Recreating this crash…", disabled: true };
  else if (aiState === "running") primary = { label: "■ Stop", onClick: stopArgon, stop: true };
  else if (step === "recreate") primary = { label: "Recreate this crash", onClick: () => void startJob("reconstruct"), disabled: !baseline };
  else if (step === "replay" && lastWin) primary = { label: "▶ Replay the fix", onClick: () => void replayFix(lastWin) };
  else primary = { label: "Find a better ending", onClick: () => void askArgon(), disabled: !baseline || !canAskArgon };

  return (
    <main className="chain-app game-app stunt-app midair-app">
      <header className="chain-header">
        <div className="game-brand">
          <b>Unbreak</b>
          <span>Your turn to change the ending.</span>
        </div>
      </header>
      <section className="game-hero">
        <figure className="row-video game-video">
          <video src={MIDAIR_SOURCE.url} controls muted playsInline preload="auto" />
          <figcaption>
            <b>Real footage, source speed.</b> {MIDAIR_SOURCE.timingNote}{" "}
            <a href={MIDAIR_SOURCE.slowMoUrl} target="_blank" rel="noreferrer">
              Slow-motion excerpt (inspection only)
            </a>
            <span className="game-credit">
              {MIDAIR_SOURCE.attribution} <a href={MIDAIR_SOURCE.origin}>Source</a>
            </span>
          </figcaption>
        </figure>
        <div className="game-pitch">
          <p className="chain-eyebrow">MIDAIR · MOVE ONE LAUNCH LANE</p>
          <h1>
            Two cars. One crash. <em>Make it work.</em>
          </h1>
          <p>Argon recreates the crash from the video, then moves one ramp sideways — its car comes with it. Speeds and timing stay the same. Physics decides.</p>
          <ul className="game-badges" aria-label="Provenance">
            <li>Real footage · CC BY</li>
            <li className={geometry === "argon_inferred" ? "ok" : "warn"}>{geometry === "argon_inferred" ? `Geometry inferred by ${job?.model} from the video` : "Geometry hand-fitted (reference, not AI)"}</li>
            <li>Scale assumed · car 0.45 m</li>
            <li>Speed calibrated · 7 m/s</li>
            <li className={job?.verification.status === "verified" ? "ok" : ""}>
              {job?.verification.status === "verified" ? "Solvable: verified by search (not AI)" : job?.verification.status === "none_found" ? "No solution found by search" : "Checking solvability…"}
            </li>
          </ul>
          <div className="midair-next" aria-label="Next step">
            <ol className="midair-steps">
              {steps.map((x, k) => {
                // Step 1 only counts as done when the scene on screen really came from Argon's reconstruction.
                const skipped = k === 0 && k < stepIndex && geometry !== "argon_inferred";
                return (
                  <li key={x.key} className={skipped ? "is-skipped" : k < stepIndex ? "is-done" : k === stepIndex ? "is-current" : ""} aria-current={k === stepIndex ? "step" : undefined}>
                    <span>{k + 1}</span> {x.label}
                    {skipped ? " · skipped (hand-fitted scene)" : ""}
                  </li>
                );
              })}
            </ol>
            <button className={`midair-primary ${primary.stop ? "is-stop" : ""}`} disabled={primary.disabled} onClick={primary.onClick}>
              {primary.label}
            </button>
            {status && (
              <p className={`midair-status ${ready && step === "fix" && !busy && aiState !== "running" ? "is-ready" : ""}`} role="status">
                {status}
              </p>
            )}
            {!busy && aiState !== "running" && (
              <p className="midair-secondary">
                {step === "recreate" && (
                  <button className="midair-link" onClick={() => setChoseHandFit(true)}>
                    Skip — use the hand-fitted scene
                  </button>
                )}
                {step === "replay" && (
                  <button className="midair-link" onClick={() => void askArgon()} disabled={!canAskArgon}>
                    Ask Argon again
                  </button>
                )}
                {step === "fix" && !canAskArgon && <span>Argon needs a server API key (GEMINI_API_KEY). You can still try your own change below.</span>}
                {step === "fix" && mock && <span>Test mode: a scripted critic, not live AI evidence. Physics still decides.</span>}
              </p>
            )}
          </div>
        </div>
      </section>
      <section className="chain-stage game-stage">
        <div className="chain-stage-top">
          <span>{run ? (replayOf ? `${decided ? "RESULT" : "REPLAY"} · ARGON'S VERIFIED FIX` : decided ? "RESULT" : "PHYSICS REPLAY") : move ? `LANE ${lane} MOVED ${(offset * 100).toFixed(0)} CM` : "BASELINE"}</span>
          <div className="midair-cams">
            <span className="midair-cams-label">Camera</span>
            <div className="stunt-cams" role="group" aria-label="Camera">
              {(["cinematic", "top", "side"] as const).map((v) => (
                <button key={v} aria-pressed={view === v} onClick={() => setView(v)} title={v === "top" ? "Keeps both cars in view; drag a lane here" : undefined}>
                  {v === "cinematic" ? "Cinematic" : v === "top" ? "Top-down · both cars" : "Side"}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="chain-viewport stunt-viewport midair-viewport" ref={host} />
        {run && decided && (
          <div className={`game-verdict ${run.result.success ? "is-win" : "is-fail"}`} role="status">
            <strong>{OUTCOME[run.result.outcome]}</strong>
            <span>
              {replayOf ? "Argon's verified fix: " : ""}
              {run.move ? `lane ${run.move.lane} moved ${(run.move.offsetM * 100).toFixed(0)} cm` : "baseline"} · decided at {run.result.decidedAt.toFixed(2)} s · {run.result.reason}
              {replayOf && !replayOf.sameScene ? " · replayed on the scene Argon saw (not the one now on screen)" : ""}
            </span>
          </div>
        )}
        <details className="midair-manual">
          <summary>Try your own change</summary>
          <p className="midair-hint">Pick a lane and move it sideways — drag it in the Top-down view or use the slider — then test it.</p>
          <div className="game-actions stunt-controls">
            <div className="stunt-cams" role="group" aria-label="Launch lane">
              {(["A", "B"] as const).map((l) => (
                <button key={l} aria-pressed={lane === l} disabled={!!busy} onClick={() => (setLane(l), edit(0))}>
                  Lane {l}
                </button>
              ))}
            </div>
            <label className="stunt-pitch">
              Move one launch lane <b>{(offset * 100).toFixed(0)} cm</b>
              <input type="range" aria-label="Launch lane offset in meters" min={-LANE_RULE.maxOffsetM} max={LANE_RULE.maxOffsetM} step={LANE_RULE.stepM} value={offset} disabled={!baseline || !!busy} onChange={(e) => edit(Number(e.target.value))} />
            </label>
            <button className="game-run" disabled={!baseline || !!busy} onClick={() => void launch()}>
              ▶ Test my change
            </button>
            <button disabled={!!busy} onClick={reset}>Reset</button>
          </div>
        </details>
      </section>
      {error && <p className="chain-error" role="alert">{error}</p>}
      <section className="game-ai" aria-label="Argon">
        <div className="game-ai-head">
          <div>
            <p className="chain-eyebrow">ARGON'S ATTEMPTS {mock ? "· MOCK (TEST MODE)" : ""}</p>
            <h2>Argon looks at the video and the simulation, then moves one lane</h2>
            <p>
              {!health?.configured
                ? "Needs a server API key (GEMINI_API_KEY). Manual play works without it."
                : mock
                  ? "Test mode: a scripted critic; not live AI evidence. Physics still decides."
                  : "It sees the real recording plus synchronized side and top-down renders of the current attempt, and gets only the legal control and its bounds. Up to three rounds. Click a frame sheet to enlarge it."}
            </p>
          </div>
        </div>
        {cards.length > 0 && (
          <ol className="game-ai-rounds">
            {cards.map((c) => (
              <li key={c.id} className={c.state === "failed" ? "is-failed" : c.success ? "is-win" : ""}>
                <button className="midair-thumb" onClick={() => setViewer(c)} aria-label={`Enlarge the side and top-down frames sent in round ${c.n}`}>
                  <img src={c.image} alt={`Side and top-down renders sent in round ${c.n}`} />
                  <span>Enlarge</span>
                </button>
                <div>
                  <p className="chain-eyebrow">
                    ROUND {c.n}
                    {c.attempt > 1 ? ` · RETRY ${c.attempt - 1}` : ""} · {mock ? "MOCK" : job?.model}
                    {c.ms !== undefined ? ` · ${(c.ms / 1000).toFixed(1)} s` : ""}
                  </p>
                  <p className="small">Sent: {c.sent ? `lane ${c.sent.lane} moved ${(c.sent.offsetM * 100).toFixed(0)} cm` : "the baseline"}.</p>
                  {c.state === "waiting" && <p>Waiting…</p>}
                  {c.state === "failed" && <p>✕ Request failed (not a round): {c.error}</p>}
                  {c.state === "done" && (
                    <>
                      <p>{c.text}</p>
                      <p className="small">{c.evidence}</p>
                      <p>
                        {c.proposed ? `Proposed: lane ${c.proposed.lane}, ${(c.proposed.offsetM * 100).toFixed(0)} cm. ${c.proposed.reason}` : "No change proposed."} <b>{c.success ? "✓ Physics: both landed — verified." : `Physics: ${OUTCOME[c.outcome as MidairResult["outcome"]]}`}</b>
                      </p>
                      {c.success && c.proposed && (
                        <button className="game-run midair-replay" onClick={() => void replayFix(c)}>
                          ▶ Replay Argon's fix
                        </button>
                      )}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="game-more">
        <details>
          <summary>Inspect the reconstruction</summary>
          <p className="midair-secondary">
            <button className="midair-link" disabled={!!busy || !canReconstruct} onClick={() => void startJob("reconstruct")}>
              Recreate from the video again
            </button>{" "}
            <button className="midair-link" disabled={!!busy || geometry === "manual_fit"} onClick={() => (setChoseHandFit(true), void startJob("manual"))}>
              Use the hand-fitted scene
            </button>
          </p>
          {job?.comparison && (
            <table className="row-fit">
              <thead>
                <tr><th>Measure</th><th>Argon</th><th>Hand fit</th></tr>
              </thead>
              <tbody>{job.comparison.map((c) => <tr key={c.field}><td>{c.field}</td><td>{c.argon}</td><td>{c.manual}</td></tr>)}</tbody>
            </table>
          )}
          {job?.observations && <ul>{job.observations.map((o, i) => <li key={i}>{o.timeSeconds.toFixed(2)} s (clip time) — {o.description}</li>)}</ul>}
          <ul>{baseline?.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </details>
      </section>
      {viewer && <EvidenceViewer card={viewer} model={mock ? "MOCK" : job?.model ?? ""} onClose={() => setViewer(null)} />}
    </main>
  );
}

const ZOOMS = [{ key: "fit", label: "Fit" }, { key: 1, label: "100%" }, { key: 1.5, label: "150%" }, { key: 2, label: "200%" }] as const;

/** Large, accessible view of the exact frame sheet sent to Argon: native modal dialog, zoom, Escape/close, focus return. */
function EvidenceViewer({ card, model, onClose }: { card: Card; model: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]["key"]>("fit");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const d = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    d?.showModal();
    closeBtn.current?.focus();
    return () => opener?.focus();
  }, []);
  const width = zoom === "fit" || !natural ? undefined : Math.round(natural.w * zoom);
  return (
    <dialog ref={ref} className="midair-viewer" aria-labelledby="midair-viewer-title" onCancel={(e) => (e.preventDefault(), onClose())} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="midair-viewer-head">
        <div>
          <h2 id="midair-viewer-title">
            Round {card.n}
            {card.attempt > 1 ? ` · retry ${card.attempt - 1}` : ""} — what {model || "Argon"} saw
          </h2>
          <p>
            Top row: <b>side view</b>. Bottom row: <b>top-down view</b>. Same simulation times: {card.times.map((t) => `${t.toFixed(2)} s`).join(" · ")}. Sent: {card.sent ? `lane ${card.sent.lane} moved ${(card.sent.offsetM * 100).toFixed(0)} cm` : "the baseline"}.
          </p>
        </div>
        <div className="midair-viewer-tools" role="group" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button key={String(z.key)} aria-pressed={zoom === z.key} onClick={() => setZoom(z.key)}>
              {z.label}
            </button>
          ))}
          <button ref={closeBtn} className="midair-viewer-close" onClick={onClose} aria-label="Close (Esc)">
            ✕ Close
          </button>
        </div>
      </div>
      <div className={`midair-viewer-body ${zoom === "fit" ? "is-fit" : ""}`}>
        <img
          src={card.image}
          alt={`Side (top row) and top-down (bottom row) renders sent to Argon in round ${card.n}, at ${card.times.map((t) => `${t.toFixed(2)} s`).join(", ")}`}
          style={width ? { width, maxWidth: "none" } : undefined}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onClick={() => setZoom((z) => (z === "fit" ? 1.5 : "fit"))}
        />
      </div>
    </dialog>
  );
}

function safeMove(baseline: MidairScene, m: LaneMove): MidairScene | null {
  try {
    return applyLaneMove(baseline, m);
  } catch {
    return null;
  }
}
