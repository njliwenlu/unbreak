import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import { createMidairRouter, mockMidairProvider } from "../midair/server";
import { argonConfigFromEnv } from "./config";

try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the real environment.
}

const PORT = Number(process.env.PORT) || 8787;
const argonConfig = argonConfigFromEnv();
// Offline rehearsal/tests only: a scripted critic, labeled as MOCK everywhere. It cannot reconstruct video.
const MOCK = process.env.ARGON_MOCK === "1";
// Test-only knobs, honored only in mock mode so they can never alter a real run.
const MOCK_TEST_ENV = ["ARGON_MOCK_CRITIC_FAULTS", "ARGON_MOCK_CRITIC_MS"].filter((k) => process.env[k]);
if (!MOCK && MOCK_TEST_ENV.length) console.warn(`Ignoring ${MOCK_TEST_ENV.join(", ")}: test-only settings require ARGON_MOCK=1.`);
// Every model request, render, response and physics result is archived per run. Set RUN_ARCHIVE_DIR= to disable.
const RUN_ARCHIVE_DIR = process.env.RUN_ARCHIVE_DIR ?? "runs";

const app = express();
app.disable("x-powered-by");

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, argonConfigured: MOCK || Boolean(argonConfig.apiKey), mock: MOCK, model: MOCK ? "mock (ARGON_MOCK=1)" : argonConfig.model });
});

app.use(
  "/api/midair",
  express.json({ limit: "8mb" }),
  createMidairRouter({
    ...(RUN_ARCHIVE_DIR ? { runRoot: path.resolve(RUN_ARCHIVE_DIR) } : {}),
    ...(MOCK ? { provider: mockMidairProvider({ criticMs: process.env.ARGON_MOCK_CRITIC_MS ? Number(process.env.ARGON_MOCK_CRITIC_MS) : undefined, faults: process.env.ARGON_MOCK_CRITIC_FAULTS }) } : {}),
  }),
);

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: { code: "server_error", message: "Unexpected server error." } });
};
app.use(onError);

// In production, serve the built frontend from the same origin.
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

app.listen(PORT, () => {
  console.log(`Unbreak API on http://localhost:${PORT} — ${MOCK ? "MOCK critic (ARGON_MOCK=1)" : argonConfig.apiKey ? `Argon enabled (${argonConfig.model})` : "Argon NOT configured (hand-fit scene and manual play only)"}`);
});
