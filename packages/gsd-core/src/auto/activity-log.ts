/**
 * activity-log.ts — Stub for harness-coupled activity-log module.
 *
 * Real implementation depends on ExtensionContext. This exports only
 * the pure function that gsd-core uses.
 */

import { readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";

export function pruneActivityLogs(activityDir: string, retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  try {
    for (const name of readdirSync(activityDir)) {
      const full = join(activityDir, name);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* directory may not exist */ }
}
