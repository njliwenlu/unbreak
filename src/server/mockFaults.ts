/** TEST ONLY: outcomes injected into successive scripted-critic calls (ARGON_MOCK_CRITIC_FAULTS, mock mode only). */
export const MOCK_CRITIC_FAULTS = ["ok", "timeout", "model_error", "invalid_critique"] as const;
export type MockCriticFault = (typeof MOCK_CRITIC_FAULTS)[number];

export function parseMockCriticFaults(raw: string | undefined): MockCriticFault[] {
  if (!raw) return [];
  const faults = raw.split(",").map((s) => s.trim());
  const bad = faults.filter((f) => !(MOCK_CRITIC_FAULTS as readonly string[]).includes(f));
  if (bad.length) throw new Error(`ARGON_MOCK_CRITIC_FAULTS: unknown entries ${bad.join(", ")} (allowed: ${MOCK_CRITIC_FAULTS.join(", ")})`);
  return faults as MockCriticFault[];
}
