/**
 * finalize/finalize.ts — Post-unit finalization: pre/post verification,
 * UAT pause, step-wizard.
 *
 * This is the "did the work actually succeed?" phase.
 */

import type { SidecarItem } from "../session.js";
import type { PreVerificationOpts } from "../loop-deps.js";
import type {
  PhaseResult,
  IterationContext,
  LoopState,
  IterationData,
} from "../types.js";
import { MAX_FINALIZE_TIMEOUTS } from "../types.js";
import { debugLog } from "../../reporting/debug-logger.js";
import { withTimeout, FINALIZE_PRE_TIMEOUT_MS, FINALIZE_POST_TIMEOUT_MS } from "../finalize-timeout.js";

/**
 * Phase 5: Post-unit finalize — pre/post verification, UAT pause, step-wizard.
 * Returns break/continue/next to control the outer loop.
 */
export async function runFinalize(
  ic: IterationContext,
  iterData: IterationData,
  loopState: LoopState,
  sidecarItem?: SidecarItem,
): Promise<PhaseResult> {
  const { s, deps } = ic;
  const { pauseAfterUatDispatch } = iterData;

  debugLog("autoLoop", { phase: "finalize", iteration: ic.iteration });

  // Clear unit timeout (unit completed)
  deps.clearUnitTimeout();

  // Pre-verification processing
  const preVerificationOpts: PreVerificationOpts | undefined = sidecarItem
    ? sidecarItem.kind === "hook"
      ? { skipSettleDelay: true, skipWorktreeSync: true }
      : { skipSettleDelay: true }
    : undefined;
  const preResultGuard = await withTimeout(
    deps.postUnitPreVerification(iterData.unitType, iterData.unitId, preVerificationOpts),
    FINALIZE_PRE_TIMEOUT_MS,
    "postUnitPreVerification",
  );

  if (preResultGuard.timedOut) {
    s.currentUnit = null;
    loopState.consecutiveFinalizeTimeouts++;
    debugLog("autoLoop", {
      phase: "pre-verification-timeout",
      iteration: ic.iteration,
      unitType: iterData.unitType,
      unitId: iterData.unitId,
      consecutiveTimeouts: loopState.consecutiveFinalizeTimeouts,
    });

    if (loopState.consecutiveFinalizeTimeouts >= MAX_FINALIZE_TIMEOUTS) {
      deps.events.notify(
        `postUnitPreVerification timed out ${loopState.consecutiveFinalizeTimeouts} consecutive times — stopping auto-mode to prevent budget waste`,
        "error",
      );
      await deps.stopAuto(`${loopState.consecutiveFinalizeTimeouts} consecutive finalize timeouts`);
      return { action: "break", reason: "finalize-timeout-escalation" };
    }

    deps.events.notify(
      `postUnitPreVerification timed out after ${FINALIZE_PRE_TIMEOUT_MS / 1000}s for ${iterData.unitType} ${iterData.unitId} (${loopState.consecutiveFinalizeTimeouts}/${MAX_FINALIZE_TIMEOUTS}) — continuing to next iteration`,
      "warning",
    );
    return { action: "next", data: undefined as void };
  }

  const preResult = preResultGuard.value;
  if (preResult === "dispatched") {
    debugLog("autoLoop", {
      phase: "exit",
      reason: "pre-verification-dispatched",
    });
    return { action: "break", reason: "pre-verification-dispatched" };
  }
  if (preResult === "retry") {
    if (sidecarItem) {
      debugLog("autoLoop", { phase: "sidecar-artifact-retry-skipped", iteration: ic.iteration });
    } else {
      debugLog("autoLoop", { phase: "artifact-verification-retry", iteration: ic.iteration });
      return { action: "continue" };
    }
  }

  if (pauseAfterUatDispatch) {
    deps.events.notify(
      "UAT requires human execution. Auto-mode will pause after this unit writes the result file.",
      "info",
    );
    await deps.pauseAuto();
    debugLog("autoLoop", { phase: "exit", reason: "uat-pause" });
    return { action: "break", reason: "uat-pause" };
  }

  // Verification gate
  const skipVerification = sidecarItem?.kind === "hook";
  if (!skipVerification) {
    const verificationResult = await deps.runPostUnitVerification(s);

    if (verificationResult === "pause") {
      debugLog("autoLoop", { phase: "exit", reason: "verification-pause" });
      return { action: "break", reason: "verification-pause" };
    }

    if (verificationResult === "retry") {
      if (sidecarItem) {
        debugLog("autoLoop", { phase: "sidecar-verification-retry-skipped", iteration: ic.iteration });
      } else {
        debugLog("autoLoop", { phase: "verification-retry", iteration: ic.iteration });
        return { action: "continue" };
      }
    }
  }

  // Post-verification processing
  const postResultGuard = await withTimeout(
    deps.postUnitPostVerification(iterData.unitType, iterData.unitId),
    FINALIZE_POST_TIMEOUT_MS,
    "postUnitPostVerification",
  );

  if (postResultGuard.timedOut) {
    s.currentUnit = null;
    loopState.consecutiveFinalizeTimeouts++;
    debugLog("autoLoop", {
      phase: "post-verification-timeout",
      iteration: ic.iteration,
      unitType: iterData.unitType,
      unitId: iterData.unitId,
      consecutiveTimeouts: loopState.consecutiveFinalizeTimeouts,
    });

    if (loopState.consecutiveFinalizeTimeouts >= MAX_FINALIZE_TIMEOUTS) {
      deps.events.notify(
        `postUnitPostVerification timed out ${loopState.consecutiveFinalizeTimeouts} consecutive times — stopping auto-mode to prevent budget waste`,
        "error",
      );
      await deps.stopAuto(`${loopState.consecutiveFinalizeTimeouts} consecutive finalize timeouts`);
      return { action: "break", reason: "finalize-timeout-escalation" };
    }

    deps.events.notify(
      `postUnitPostVerification timed out after ${FINALIZE_POST_TIMEOUT_MS / 1000}s for ${iterData.unitType} ${iterData.unitId} (${loopState.consecutiveFinalizeTimeouts}/${MAX_FINALIZE_TIMEOUTS}) — continuing to next iteration`,
      "warning",
    );
    return { action: "next", data: undefined as void };
  }

  const postResult = postResultGuard.value;

  if (postResult === "stopped") {
    debugLog("autoLoop", {
      phase: "exit",
      reason: "post-verification-stopped",
    });
    return { action: "break", reason: "post-verification-stopped" };
  }

  if (postResult === "step-wizard") {
    debugLog("autoLoop", { phase: "exit", reason: "step-wizard" });
    return { action: "break", reason: "step-wizard" };
  }

  // Both pre and post verification completed without timeout — reset counter
  loopState.consecutiveFinalizeTimeouts = 0;

  return { action: "next", data: undefined as void };
}
