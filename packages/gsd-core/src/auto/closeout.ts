/**
 * auto/closeout.ts — Close out an in-flight unit and stop auto-mode.
 *
 * Shared helper used by pre-dispatch and dispatch phases when a terminal
 * condition is reached.
 */

import type { AutoSession } from "./session.js";
import type { CoreLoopDeps } from "./loop-deps.js";

/**
 * If a unit is in-flight, close it out, then stop auto-mode.
 */
export async function closeoutAndStop(
  s: AutoSession,
  deps: CoreLoopDeps,
  reason: string,
): Promise<void> {
  if (s.currentUnit) {
    await deps.closeoutUnit(
      s.basePath,
      s.currentUnit.type,
      s.currentUnit.id,
      s.currentUnit.startedAt,
      deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id),
    );
  }
  await deps.stopAuto(reason);
}
