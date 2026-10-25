import RAPIER from "@dimforge/rapier3d-compat";

let rapierReady: Promise<void> | null = null;
/** Rapier's WASM must be initialized once before creating a world. */
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}
