/**
 * dispatch/dispatch.ts — Unit dispatch resolution: resolve next unit,
 * stuck detection, pre-dispatch hooks, prior-slice blockers.
 *
 * This is the "what work unit do we run next?" phase.
 */

import type { AutoSession } from "../session.js";
import type {
  PhaseResult,
  IterationContext,
  LoopState,
  PreDispatchData,
  IterationData,
} from "../types.js";
import { MAX_RECOVERY_CHARS } from "../types.js";
import { closeoutAndStop } from "../closeout.js";
import { detectStuck } from "../guards/stuck-detection.js";
import { debugLog } from "../../debug-logger.js";
import { verifyExpectedArtifact, buildLoopRemediationSteps } from "../../auto-recovery.js";
import { diagnoseExpectedArtifact } from "../../auto-artifact-paths.js";

/**
 * Phase 3: Dispatch resolution — resolve next unit, stuck detection, pre-dispatch hooks.
 * Returns break/continue to control the loop, or next with IterationData on success.
 */
export async function runDispatch(
  ic: IterationContext,
  preData: PreDispatchData,
  loopState: LoopState,
): Promise<PhaseResult<IterationData>> {
  const { s, deps, prefs } = ic;
  const { state, mid, midTitle } = preData;
  const STUCK_WINDOW_SIZE = 6;

  debugLog("autoLoop", { phase: "dispatch-resolve", iteration: ic.iteration });
  const dispatchResult = await deps.resolveDispatch({
    basePath: s.basePath,
    mid,
    midTitle,
    state,
    prefs,
    session: s,
  });

  if (dispatchResult.action === "stop") {
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "dispatch-stop", rule: dispatchResult.matchedRule, data: { reason: dispatchResult.reason } });
    if (dispatchResult.level === "warning") {
      deps.events.notify(dispatchResult.reason, "warning");
      await deps.pauseAuto();
    } else {
      await closeoutAndStop(s, deps, dispatchResult.reason);
    }
    debugLog("autoLoop", { phase: "exit", reason: "dispatch-stop" });
    return { action: "break", reason: "dispatch-stop" };
  }

  if (dispatchResult.action !== "dispatch") {
    // Non-dispatch action (e.g. "skip") — re-derive state
    await new Promise((r) => setImmediate(r));
    return { action: "continue" };
  }

  deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "dispatch-match", rule: dispatchResult.matchedRule, data: { unitType: dispatchResult.unitType, unitId: dispatchResult.unitId } });

  let unitType = dispatchResult.unitType;
  let unitId = dispatchResult.unitId;
  let prompt = dispatchResult.prompt;
  const pauseAfterUatDispatch = dispatchResult.pauseAfterDispatch ?? false;

  // ── Sliding-window stuck detection with graduated recovery ──
  const derivedKey = `${unitType}/${unitId}`;

  if (!s.pendingVerificationRetry) {
    loopState.recentUnits.push({ key: derivedKey });
    if (loopState.recentUnits.length > STUCK_WINDOW_SIZE) loopState.recentUnits.shift();

    const stuckSignal = detectStuck(loopState.recentUnits);
    if (stuckSignal) {
      debugLog("autoLoop", {
        phase: "stuck-check",
        unitType,
        unitId,
        reason: stuckSignal.reason,
        recoveryAttempts: loopState.stuckRecoveryAttempts,
      });

      if (loopState.stuckRecoveryAttempts === 0) {
        loopState.stuckRecoveryAttempts++;
        const artifactExists = verifyExpectedArtifact(
          unitType,
          unitId,
          s.basePath,
        );
        if (artifactExists) {
          debugLog("autoLoop", {
            phase: "stuck-recovery",
            level: 1,
            action: "artifact-found",
          });
          deps.events.notify(
            `Stuck recovery: artifact for ${unitType} ${unitId} found on disk. Invalidating caches.`,
            "info",
          );
          deps.invalidateAllCaches();
          return { action: "continue" };
        }
        deps.events.notify(
          `Stuck on ${unitType} ${unitId} (${stuckSignal.reason}). Invalidating caches and retrying.`,
          "warning",
        );
        deps.invalidateAllCaches();
      } else {
        debugLog("autoLoop", {
          phase: "stuck-detected",
          unitType,
          unitId,
          reason: stuckSignal.reason,
        });
        const stuckDiag = diagnoseExpectedArtifact(unitType, unitId, s.basePath);
        const stuckRemediation = buildLoopRemediationSteps(unitType, unitId, s.basePath);
        const stuckParts = [`Stuck on ${unitType} ${unitId} — ${stuckSignal.reason}.`];
        if (stuckDiag) stuckParts.push(`Expected: ${stuckDiag}`);
        if (stuckRemediation) stuckParts.push(`To recover:\n${stuckRemediation}`);
        deps.events.notify(stuckParts.join(" "), "error");
        await deps.stopAuto(
          `Stuck: ${stuckSignal.reason}`,
        );
        return { action: "break", reason: "stuck-detected" };
      }
    } else {
      if (loopState.stuckRecoveryAttempts > 0) {
        debugLog("autoLoop", {
          phase: "stuck-counter-reset",
          from: loopState.recentUnits[loopState.recentUnits.length - 2]?.key ?? "",
          to: derivedKey,
        });
        loopState.stuckRecoveryAttempts = 0;
      }
    }
  }

  // Pre-dispatch hooks
  const preDispatchResult = deps.runPreDispatchHooks(
    unitType,
    unitId,
    prompt,
    s.basePath,
  );
  if (preDispatchResult.firedHooks.length > 0) {
    deps.events.notify(
      `Pre-dispatch hook${preDispatchResult.firedHooks.length > 1 ? "s" : ""}: ${preDispatchResult.firedHooks.join(", ")}`,
      "info",
    );
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "pre-dispatch-hook", data: { firedHooks: preDispatchResult.firedHooks, action: preDispatchResult.action } });
  }
  if (preDispatchResult.action === "skip") {
    deps.events.notify(
      `Skipping ${unitType} ${unitId} (pre-dispatch hook).`,
      "info",
    );
    await new Promise((r) => setImmediate(r));
    return { action: "continue" };
  }
  if (preDispatchResult.action === "replace") {
    prompt = preDispatchResult.prompt ?? prompt;
    if (preDispatchResult.unitType) unitType = preDispatchResult.unitType;
  } else if (preDispatchResult.prompt) {
    prompt = preDispatchResult.prompt;
  }

  const guardBasePath = s.originalBasePath || s.basePath;
  const priorSliceBlocker = deps.getPriorSliceCompletionBlocker(
    guardBasePath,
    deps.getMainBranch(guardBasePath),
    unitType,
    unitId,
  );
  if (priorSliceBlocker) {
    await deps.stopAuto(priorSliceBlocker);
    debugLog("autoLoop", { phase: "exit", reason: "prior-slice-blocker" });
    return { action: "break", reason: "prior-slice-blocker" };
  }

  return {
    action: "next",
    data: {
      unitType, unitId, prompt, finalPrompt: prompt,
      pauseAfterUatDispatch,
      state, mid, midTitle,
      isRetry: false, previousTier: undefined,
      hookModelOverride: preDispatchResult.model,
    },
  };
}
