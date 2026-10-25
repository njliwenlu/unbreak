// Minimal live check of model access: one tiny text-only request with the configured key and model.
// Prints the model's reply or the API error verbatim. Never prints the key.
import { argonConfigFromEnv, checkModelAccess } from "../src/server/config";

try {
  process.loadEnvFile();
} catch {
  // rely on the environment
}
const config = argonConfigFromEnv();
if (!config.apiKey) {
  console.error("GEMINI_API_KEY is not set.");
  process.exit(2);
}
if (process.env.ARGON_MOCK) console.warn(`Note: ARGON_MOCK=${process.env.ARGON_MOCK} is set, but this check always calls the real API.`);
const out = await checkModelAccess(config);
console.log(JSON.stringify({ model: config.model, ...out }, null, 2));
if (!out.ok) process.exit(1);
