/**
 * guards/stuck-detection.ts — Stuck-pattern detection for the auto-loop.
 *
 * Pure guard: inspects recent unit dispatches for repeating / oscillating
 * patterns that indicate the loop is making no progress.
 *
 * Leaf node in the import DAG (imports only from types.ts).
 */

import type { WindowEntry } from "../types.ts";

/**
 * Pattern matching ENOENT errors with a file path.
 * Matches: "ENOENT: no such file or directory, access '/path/to/file'"
 * and similar Node.js filesystem error messages.
 */
const ENOENT_PATH_RE = /ENOENT[^']*'([^']+)'/;

/**
 * Analyze recent unit dispatches for stuck patterns.
 * Returns a signal with reason if stuck, null otherwise.
 *
 * Rule 1: Same error string twice in a row → stuck immediately.
 * Rule 2: Same unit key 3+ consecutive times → stuck (preserves prior behavior).
 * Rule 3: Oscillation A→B→A→B in last 4 entries → stuck.
 * Rule 4: Same ENOENT path in any 2 entries → stuck (#3575).
 *         Missing files don't self-heal between retries — retrying wastes budget.
 */
export function detectStuck(
  recentUnits: readonly WindowEntry[],
): { stuck: true; reason: string } | null {
  if (recentUnits.length < 2) return null;

  const last = recentUnits[recentUnits.length - 1];
  const prev = recentUnits[recentUnits.length - 2];

  // Rule 1: Same error repeated consecutively
  if (last.error && prev.error && last.error === prev.error) {
    return {
      stuck: true,
      reason: `Same error repeated: ${last.error.slice(0, 200)}`,
    };
  }

  // Rule 2: Same unit 3+ consecutive times
  if (recentUnits.length >= 3) {
    const lastThree = recentUnits.slice(-3);
    if (lastThree.every((u) => u.key === last.key)) {
      return {
        stuck: true,
        reason: `${last.key} derived 3 consecutive times without progress`,
      };
    }
  }

  // Rule 3: Oscillation (A→B→A→B in last 4)
  if (recentUnits.length >= 4) {
    const tail = recentUnits.slice(-4);
    if (
      tail[0].key === tail[2].key &&
      tail[1].key === tail[3].key &&
      tail[0].key !== tail[1].key
    ) {
      return {
        stuck: true,
        reason: `Oscillation detected: ${tail[0].key} ↔ ${tail[1].key}`,
      };
    }
  }

  // Rule 4: Same ENOENT path seen twice in window (#3575)
  // Missing files don't appear between retries — stop immediately.
  const enoentPaths = new Map<string, number>();
  for (const entry of recentUnits) {
    if (!entry.error) continue;
    const match = ENOENT_PATH_RE.exec(entry.error);
    if (!match) continue;
    const filePath = match[1];
    const count = (enoentPaths.get(filePath) ?? 0) + 1;
    if (count >= 2) {
      return {
        stuck: true,
        reason: `Missing file referenced twice: ${filePath} (ENOENT)`,
      };
    }
    enoentPaths.set(filePath, count);
  }

  return null;
}
