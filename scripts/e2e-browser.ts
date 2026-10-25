// Browser end-to-end checks for Unbreak Midair against the MOCK critic (no model calls). Each scenario starts its
// own server (serving the production build in dist/) with test-only settings, drives system Chrome, and checks the
// UI, the server state and the run archive on disk.
//   npm run build && npx tsx scripts/e2e-browser.ts <out-dir> [scenario...]
// Scenarios: midair-play, midair-ai, midair-recon. Prints a JSON report; exits 1 on failure.
// midair-recon uses request-interception fixtures (labeled FIXTURE) because mock mode cannot reconstruct video.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { MidairJob as MidairJobT } from "../src/midair/server";

const args = process.argv.slice(2);
const OUT = path.resolve(args[0] ?? "/tmp/rc-e2e");
const ONLY = args.slice(1);
mkdirSync(OUT, { recursive: true });
if (!existsSync("dist/index.html")) throw new Error("Run npm run build first (the server serves dist/).");

type Check = { scenario: string; name: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];
let scenario = "";
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ scenario, name, pass, ...(pass ? {} : { detail }) });
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A port the OS reports free right now (other local servers, e.g. another agent's checks, must not be reused). */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });

type TestServer = { base: string; archive: string; proc: ChildProcess; log: string[] };
const servers: TestServer[] = [];
/** Kill the whole process group (npx → tsx → node); killing npx alone leaves the server running. */
const stop = (proc: ChildProcess) => {
  try {
    process.kill(-proc.pid!, "SIGTERM");
  } catch {
    // already gone
  }
};

async function startServer(env: Record<string, string>): Promise<TestServer> {
  const port = await freePort();
  const archive = path.join(OUT, `archive-${scenario}`);
  const log: string[] = [];
  const proc = spawn("npx", ["tsx", "src/server/index.ts"], {
    env: { ...process.env, GEMINI_API_KEY: "", PORT: String(port), RUN_ARCHIVE_DIR: archive, ARGON_MOCK: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const server = { base: `http://localhost:${port}`, archive, proc, log };
  servers.push(server);
  proc.stdout!.on("data", (d) => log.push(String(d)));
  proc.stderr!.on("data", (d) => log.push(String(d)));
  // Only trust a server that announced it bound OUR port; a health reply alone could come from someone else's.
  for (let i = 0; i < 200; i++) {
    if (log.join("").includes(`on http://localhost:${port}`)) return server;
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
  stop(proc);
  throw new Error(`server did not start on ${port}: ${log.join("")}`);
}


async function newMidairPage(browser: Browser, base: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = [];
  const requests: { method: string; url: string; t: number; status?: number }[] = [];
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource.*(409|503)/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", (r) => r.url().includes("/api/midair") && requests.push({ method: r.request().method(), url: r.url().replace(base, ""), t: Date.now(), status: r.status() }));
  return { page, errors, requests };
}
const midairOffset = (page: Page) => page.locator("input[aria-label='Launch lane offset in meters']").inputValue().then(Number);
const midairRun = async (page: Page) => {
  const t0 = Date.now();
  if (!(await page.locator("details.midair-manual").getAttribute("open").then((v) => v !== null))) await page.click("text=Try your own change");
  await page.getByRole("button", { name: "▶ Test my change" }).click();
  await page.waitForTimeout(150);
  const early = await page.locator(".game-verdict").count();
  await page.waitForSelector(".game-verdict", { timeout: 30_000 });
  return { early, ms: Date.now() - t0, text: await page.locator(".game-verdict").innerText() };
};


const scenarios: Record<string, (browser: Browser) => Promise<void>> = {
  /** Midair: attribution, verdict timing, continuous lane drag, keyboard fix, reset, default landing page. */
  async "midair-play"(browser) {
    const srv = await startServer({});
    const { page, errors } = await newMidairPage(browser, srv.base);
    try {
      await page.goto(`${srv.base}/#midair`);
      await page.waitForSelector("text=Geometry hand-fitted (reference, not AI)", { timeout: 30_000 });
      const cap = await page.locator(".game-video figcaption").innerText();
      check("attribution and license beside the clip", cap.includes("billisa") && cap.includes("CC BY") && cap.includes("Slow-motion excerpt (inspection only)"), cap);
      const clip = await fetch(`${srv.base}/api/midair/media/rc-midair-crash-source-speed.mp4`);
      check("clip served from tracked media (200)", clip.status === 200 && Number(clip.headers.get("content-length")) > 500_000, clip.status);
      check("only whitelisted media are served", (await fetch(`${srv.base}/api/midair/media/README.md`)).status === 404);
      const played = await page.evaluate(async () => {
        const v = document.querySelector(".game-video video") as HTMLVideoElement;
        v.muted = true;
        await v.play();
        await new Promise((r) => setTimeout(r, 1500));
        return { t: v.currentTime, paused: v.paused, w: v.videoWidth, h: v.videoHeight, duration: v.duration };
      });
      check("source clip actually plays in the browser", played.t > 0.8 && played.w === 1280 && played.h === 720 && Math.abs(played.duration - 5.005) < 0.05, played);
      await page.evaluate(() => (document.querySelector(".game-video video") as HTMLVideoElement).pause());
      const badges = await page.locator(".game-badges").innerText();
      check("provenance badges: assumed scale and calibrated speed", badges.includes("Scale assumed") && badges.includes("Speed calibrated"), badges);
      await page.waitForFunction(() => /verified by search/.test(document.querySelector(".game-badges")?.textContent ?? ""), null, { timeout: 60_000 });
      const base = await midairRun(page);
      check("baseline: mid-air collision", base.text.startsWith("Mid-air collision"), base.text);
      check("verdict hidden at launch and revealed at the collision (~0.42 s sim at half speed)", base.early === 0 && base.ms > 700, base);
      await page.screenshot({ path: `${OUT}/midair-1-collision.png`, fullPage: true });

      // Continuous drag in the top-down view: every move keeps changing the offset (no reset after the first).
      await page.getByRole("button", { name: "Top-down · both cars" }).click();
      await page.waitForTimeout(300);
      const box = (await page.locator(".midair-viewport canvas").boundingBox())!;
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      const seen: number[] = [];
      for (let i = 1; i <= 5; i++) {
        await page.mouse.move(cx, cy + i * 12);
        await page.waitForTimeout(100);
        seen.push(await midairOffset(page));
      }
      await page.mouse.up();
      const increasing = seen.every((v, i) => i === 0 || v > seen[i - 1]!);
      check("continuous lane drag: offset changes on every move across rerenders", increasing && seen[4]! > 0.2 && seen[4]! < 1, seen);
      check("drag moves the launch lane (stage label)", (await page.locator(".chain-stage-top").innerText()).includes("LANE B MOVED"));
      await page.screenshot({ path: `${OUT}/midair-2-dragged.png`, fullPage: true });

      // Keyboard to exactly +0.60 m on lane B, then a verified landing.
      const slider = page.locator("input[aria-label='Launch lane offset in meters']");
      await slider.focus();
      let v = await midairOffset(page);
      for (let k = 0; k < 200 && Math.abs(v - 0.6) > 1e-9; k++) {
        await page.keyboard.press(v < 0.6 ? "ArrowRight" : "ArrowLeft");
        v = await midairOffset(page);
      }
      check("keyboard sets an exact offset", v === 0.6, v);
      await page.getByRole("button", { name: "Cinematic" }).click();
      const fix = await midairRun(page);
      check("lane B +60 cm: both cars land", fix.text.startsWith("Made it work"), fix.text);
      check("success verdict waits for both stable landings", fix.early === 0 && fix.ms > 2000, fix.ms);
      await page.screenshot({ path: `${OUT}/midair-3-landed.png`, fullPage: true });
      await page.click("button:has-text('Reset')");
      check("reset: offset 0, no verdict", (await midairOffset(page)) === 0 && (await page.locator(".game-verdict").count()) === 0);
      check("no console errors", errors.length === 0, errors);

      // Midair is the landing page, and the legacy /#midair link still opens it.
      await page.goto(`${srv.base}/`);
      await page.waitForSelector("text=MIDAIR · MOVE ONE LAUNCH LANE", { timeout: 30_000 });
      check("Midair is the default landing page", (await page.locator(".game-brand").innerText()).includes("Your turn to change the ending."));
    } finally {
      await page.close();
      stop(srv.proc);
    }
  },

  /** Argon loop (MOCK): Replay Argon's fix uses the exact verified proposal; Stop → immediate restart; late results ignored. */
  async "midair-ai"(browser) {
    const srv = await startServer({ ARGON_MOCK_CRITIC_MS: "1200" });
    const { page, errors, requests } = await newMidairPage(browser, srv.base);
    try {
      await page.goto(`${srv.base}/#midair`);
      await page.waitForFunction(() => /verified by search/.test(document.querySelector(".game-badges")?.textContent ?? ""), null, { timeout: 60_000 });
      const primary = page.locator("button.midair-primary");
      check("one primary next action: Find a better ending (mock hand-fit scene)", (await primary.count()) === 1 && (await primary.innerText()) === "Find a better ending", await primary.innerText());
      const ask = page.getByRole("button", { name: "Find a better ending", exact: true });
      // Stop, then immediately ask again.
      await ask.click();
      await page.waitForTimeout(500);
      await page.getByRole("button", { name: "■ Stop" }).click();
      const stoppedAt = Date.now();
      await ask.click();
      await page.waitForSelector("text=Physics verified Argon's change", { timeout: 40_000 });
      const conflicts = requests.filter((r) => r.status === 409);
      check("Stop → immediate restart: no 'not ready' conflicts", conflicts.length === 0, conflicts);
      const playtests = requests.filter((r) => r.method === "POST" && r.url.endsWith("/playtest")).length;
      const deletes = requests.filter((r) => r.method === "DELETE" && r.url.includes("/api/midair/jobs/") && r.t >= stoppedAt - 50);
      check("Stop cancels the first run on the server; the restart gets a fresh run", playtests === 2 && deletes.length >= 1, { playtests, deletes: deletes.length });
      const firstRun = deletes[0]!.url.split("/").pop();
      await page.waitForTimeout(1500); // the stopped run's mock critique finishes in the background
      const late = await fetch(`${srv.base}/api/midair/jobs/${firstRun}`);
      const lateJob = late.status === 200 ? ((await late.json()) as MidairJobT) : null;
      check("the stopped run's late result did not append (cancelled with no attempts, or gone)", late.status === 404 || (lateJob!.status === "cancelled" && lateJob!.attempts.length === 0), { status: late.status, job: lateJob && { status: lateJob.status, attempts: lateJob.attempts.length } });
      const cards = await page.locator(".game-ai-rounds li").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
      check("only the new loop's cards: round 1 (rollover), round 2 (verified)", cards.length === 2 && cards[0]!.includes("Proposed: lane B, 30 cm") && cards[1]!.includes("Proposed: lane B, 60 cm") && cards[1]!.includes("verified"), cards.map((c) => c.slice(0, 90)));
      check("status still the new loop's result after the late response", (await page.locator(".midair-status").innerText()).includes("Physics verified"));

      // The next action becomes "Replay the fix"; the history card keeps its own replay button and thumbnail.
      check("on the hand-fitted scene, step 1 is marked skipped, not done", (await page.locator(".midair-steps li").first().innerText()).includes("skipped (hand-fitted scene)"));
      check("primary action is now Replay the fix (step 3 current)", (await primary.innerText()) === "▶ Replay the fix" && (await page.locator(".midair-steps li[aria-current=step]").innerText()).includes("Replay the fix"), await primary.innerText());
      check("history card keeps its thumbnail and its own replay button", (await page.locator(".game-ai-rounds li .midair-thumb img").count()) === 2 && (await page.getByRole("button", { name: "▶ Replay Argon's fix" }).count()) === 1);

      // Evidence viewer: large, labeled, zoomable, Escape closes, focus returns to the thumbnail.
      const thumb = page.locator(".game-ai-rounds li").nth(1).locator(".midair-thumb");
      await thumb.click();
      const dialog = page.locator("dialog.midair-viewer[open]");
      await dialog.waitFor({ timeout: 5000 });
      const head = await dialog.locator(".midair-viewer-head").innerText();
      check("viewer opens with labels and the sheet's times", head.includes("Round 2") && head.includes("side view") && head.includes("top-down view") && /\d\.\d\d s/.test(head), head);
      check("viewer moves focus into the dialog", await page.evaluate(() => document.activeElement?.classList.contains("midair-viewer-close") ?? false));
      const fitW = await dialog.locator("img").evaluate((i) => i.getBoundingClientRect().width);
      check("fit view is large (≥ 1100 px wide at a 1440 px viewport)", fitW >= 1100, fitW);
      await page.screenshot({ path: `${OUT}/midair-viewer-fit.png` });
      await dialog.getByRole("button", { name: "200%" }).click();
      const zoomW = await dialog.locator("img").evaluate((i) => i.getBoundingClientRect().width);
      check("200% zoom enlarges beyond the dialog (scrollable)", zoomW > fitW * 1.5, { fitW, zoomW });
      await page.screenshot({ path: `${OUT}/midair-viewer-200.png` });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      check("Escape closes the viewer", (await page.locator("dialog.midair-viewer").count()) === 0);
      check("focus returns to the thumbnail", await page.evaluate(() => (document.activeElement?.getAttribute("aria-label") ?? "").includes("round 2")));
      await thumb.click();
      await dialog.waitFor({ timeout: 5000 });
      await dialog.getByRole("button", { name: "Close (Esc)" }).click();
      check("Close button closes the viewer", (await page.locator("dialog.midair-viewer").count()) === 0);

      // Replay the fix (primary): exact proposal on the exact scene, on the camera that keeps both cars visible.
      await primary.click();
      await page.waitForTimeout(150);
      check("replay is labeled as Argon's verified fix; verdict not shown early", (await page.locator(".chain-stage-top").innerText()).includes("ARGON'S VERIFIED FIX") && (await page.locator(".game-verdict").count()) === 0);
      check("replay uses the top-down camera (both cars stay in view)", (await page.getByRole("button", { name: "Top-down · both cars" }).getAttribute("aria-pressed")) === "true");
      await page.waitForSelector(".game-verdict", { timeout: 30_000 });
      const verdict = await page.locator(".game-verdict").innerText();
      check("replayed fix lands both cars, with the exact proposal", verdict.startsWith("Made it work") && verdict.includes("Argon's verified fix: lane B moved 60 cm"), verdict);
      check("controls now show the replayed proposal", (await midairOffset(page)) === 0.6);
      await page.screenshot({ path: `${OUT}/midair-ai.png`, fullPage: true });
      const shown = await page.locator(".game-ai-rounds li").first().locator("img").getAttribute("src");
      writeFileSync(`${OUT}/midair-sheet.jpg`, Buffer.from(shown!.split(",")[1]!, "base64"));
      check("no console errors", errors.length === 0, errors);
    } finally {
      await page.close();
      stop(srv.proc);
    }
  },

  /** Reconstruction provenance (request-interception FIXTURES; mock mode cannot reconstruct): rejection keeps the shown scene. */
  async "midair-recon"(browser) {
    const srv = await startServer({});
    const { page, errors } = await newMidairPage(browser, srv.base);
    try {
      await page.route("**/api/midair/health", (r) => r.fulfill({ json: { configured: true, model: "gemini-4-argon (TEST FIXTURE)" } }));
      let accept = false;
      await page.route("**/api/midair/jobs/reconstruct", (r) => r.fulfill({ status: 202, json: { id: accept ? "fixture-ok" : "fixture-bad" } }));
      await page.route("**/api/midair/jobs/fixture-bad", (r) => r.fulfill({ json: { id: "fixture-bad", geometrySource: "argon_inferred", model: "FIXTURE", status: "unsupported", stage: "FIXTURE: physics does not reproduce the recorded failure", verification: { status: "pending" }, attempts: [], failures: 0, failedAttempts: [], timings: { critiqueMs: [] }, createdAt: "" } }));
      await page.goto(`${srv.base}/#midair`);
      await page.waitForSelector("text=Geometry hand-fitted (reference, not AI)", { timeout: 30_000 });
      const primary = page.locator("button.midair-primary");
      await page.waitForFunction(() => document.querySelector("button.midair-primary")?.textContent !== "Loading…", null, { timeout: 20_000 });
      check("first step with a key: Recreate this crash", (await primary.innerText()) === "Recreate this crash", await primary.innerText());
      await primary.click();
      await page.waitForSelector(".chain-error", { timeout: 20_000 });
      check("rejected reconstruction is reported", (await page.locator(".chain-error").innerText()).includes("Argon reconstruction rejected: FIXTURE"));
      check("rejection keeps the displayed scene and its hand-fit label", (await page.locator(".game-badges").innerText()).includes("Geometry hand-fitted"));
      check("after a rejection the next action is still Recreate this crash (retry)", (await primary.innerText()) === "Recreate this crash");
      const manual = await (await fetch(`${srv.base}/api/midair/jobs/manual`, { method: "POST" })).json();
      accept = true;
      await page.route("**/api/midair/jobs/fixture-ok", (r) => r.fulfill({ json: { ...manual, id: "fixture-ok", geometrySource: "argon_inferred", model: "FIXTURE", status: "ready", baseline: { ...manual.baseline, geometrySource: "argon_inferred" } } }));
      await primary.click();
      check("manual controls cannot invalidate a pending reconstruction", (await page.getByRole("button", { name: "Reset", exact: true, includeHidden: true }).isDisabled()) && (await page.getByRole("slider", { includeHidden: true }).isDisabled()) && (await page.getByRole("button", { name: "▶ Test my change", exact: true, includeHidden: true }).isDisabled()));
      await page.waitForFunction(() => /inferred by/.test(document.querySelector(".game-badges")?.textContent ?? ""), null, { timeout: 20_000 });
      check("an accepted reconstruction switches the provenance label", (await page.locator(".game-badges").innerText()).includes("Geometry inferred by FIXTURE from the video"));
      await page.waitForTimeout(120);
      check("the recreated crash auto-plays once (no verdict before the collision)", (await page.locator(".chain-stage-top").innerText()).includes("PHYSICS REPLAY") && (await page.locator(".game-verdict").count()) === 0);
      await page.waitForSelector(".game-verdict", { timeout: 20_000 });
      check("auto-played baseline ends in the recorded mid-air collision", (await page.locator(".game-verdict").innerText()).startsWith("Mid-air collision"));
      check("manual controls re-enable after reconstruction", !(await page.getByRole("button", { name: "Reset", exact: true, includeHidden: true }).isDisabled()) && !(await page.getByRole("slider", { includeHidden: true }).isDisabled()));
      check("ready message and next action", (await page.locator(".midair-status").innerText()) === "Scene ready. Now let Argon try a fix." && (await primary.innerText()) === "Find a better ending");
      await page.screenshot({ path: `${OUT}/midair-recon-ready.png`, fullPage: true });
      check("no unexpected console errors", errors.filter((e) => !/fixture/i.test(e)).length === 0, errors);
    } finally {
      await page.close();
      stop(srv.proc);
    }
  },
};

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--use-angle=metal", "--enable-unsafe-swiftshader"] });
const timings: Record<string, number> = {};
try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    scenario = name;
    const t0 = Date.now();
    try {
      // A hung scenario must not stall the rest: fail it after 3 minutes.
      await Promise.race([run(browser), new Promise((_, reject) => setTimeout(() => reject(new Error("scenario timed out after 180 s")), 180_000))]);
    } catch (err) {
      check("scenario completed", false, String((err as Error)?.stack ?? err));
    }
    timings[name] = Date.now() - t0;
  }
} finally {
  await browser.close();
  for (const s of servers) stop(s.proc);
}
const failed = checks.filter((c) => !c.pass);
console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, timings, failures: failed, checks: checks.map((c) => `${c.pass ? "PASS" : "FAIL"} [${c.scenario}] ${c.name}`) }, null, 2));
process.exit(failed.length ? 1 : 0);
