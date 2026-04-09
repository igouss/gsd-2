/**
 * forensics.ts — Stub for harness-coupled forensics module.
 *
 * Real implementation depends on ExtensionAPI/ExtensionCommandContext.
 * This exports only the pure function that gsd-core uses.
 */

export function splitCompletedKey(key: string): { unitType: string; unitId: string } | null {
  const idx = key.indexOf("/");
  if (idx < 0) return null;
  return { unitType: key.slice(0, idx), unitId: key.slice(idx + 1) };
}
