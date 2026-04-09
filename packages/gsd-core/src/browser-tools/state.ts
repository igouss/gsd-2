/**
 * browser-tools/state.ts — Stub for harness-coupled browser tools.
 *
 * The real implementation tracks browser console logs within the
 * pi-mono extension host. This stub provides the minimal export
 * needed by verification-gate.ts.
 */

export interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
  url: string;
  pageId: number;
}

export function getConsoleLogs(): ConsoleEntry[] {
  return [];
}
