/**
 * auto/loop.ts — Main auto-mode execution loop.
 *
 * Iterates: derive → dispatch → guards → runUnit → finalize → repeat.
 * Exits when s.active becomes false or a terminal condition is reached.
 *
 * Harness-free: uses CoreLoopDeps + OrchestratorEventSink instead of
 * ExtensionContext/ExtensionAPI. Unit execution goes through
 * deps.adapter.dispatchUnit().
 */

import { randomUUID } from "node:crypto";
import type { AutoSession, SidecarItem } from "./session.js";
import type { CoreLoopDeps } from "./loop-deps.js";
import {
  MAX_LOOP_ITERATIONS,
  type LoopState,
  type IterationContext,
  type IterationData,
} from "./types.js";
import { _clearCurrentResolve } from "./resolve.js";
import {
  runPreDispatch,
  runDispatch,
  runGuards,
  runUnitPhase,
  runFinalize,
} from "./phases.js";
import { debugLog } from "../debug-logger.js";
import { isInfrastructureError } from "./infra-errors.js";
import { resolveEngine } from "../routing/engine-resolver.js";

/**
 * Main auto-mode execution loop. Iterates: derive → dispatch → guards →
 * runUnit → finalize → repeat. Exits when s.active becomes false or a
 * terminal condition is reached.
 */
export async function autoLoop(
  s: AutoSession,
  deps: CoreLoopDeps,
): Promise<void> {
  debugLog("autoLoop", { phase: "enter" });
  let iteration = 0;
  const loopState: LoopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  let consecutiveErrors = 0;
  const recentErrorMessages: string[] = [];

  while (s.active) {
    iteration++;
    debugLog("autoLoop", { phase: "loop-top", iteration });

    // ── Journal: per-iteration flow grouping ──
    const flowId = randomUUID();
    let seqCounter = 0;
    const nextSeq = () => ++seqCounter;

    if (iteration > MAX_LOOP_ITERATIONS) {
      debugLog("autoLoop", {
        phase: "exit",
        reason: "max-iterations",
        iteration,
      });
      await deps.stopAuto(
        `Safety: loop exceeded ${MAX_LOOP_ITERATIONS} iterations — possible runaway`,
      );
      break;
    }

    try {
      // ── Blanket try/catch: one bad iteration must not kill the session
      const prefs = deps.loadEffectiveGSDPreferences()?.preferences;

      // ── Check sidecar queue before deriveState ──
      let sidecarItem: SidecarItem | undefined;
      if (s.sidecarQueue.length > 0) {
        sidecarItem = s.sidecarQueue.shift()!;
        debugLog("autoLoop", {
          phase: "sidecar-dequeue",
          kind: sidecarItem.kind,
          unitType: sidecarItem.unitType,
          unitId: sidecarItem.unitId,
        });
        deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "sidecar-dequeue", data: { kind: sidecarItem.kind, unitType: sidecarItem.unitType, unitId: sidecarItem.unitId } });
      }

      const sessionLockBase = deps.lockBase();
      if (sessionLockBase) {
        const lockStatus = deps.validateSessionLock(sessionLockBase);
        if (!lockStatus.valid) {
          debugLog("autoLoop", {
            phase: "session-lock-invalid",
            reason: lockStatus.failureReason ?? "unknown",
            existingPid: lockStatus.existingPid,
            expectedPid: lockStatus.expectedPid,
          });
          deps.handleLostSessionLock(lockStatus);
          debugLog("autoLoop", {
            phase: "exit",
            reason: "session-lock-lost",
            detail: lockStatus.failureReason ?? "unknown",
          });
          break;
        }
      }

      const ic: IterationContext = { s, deps, prefs, iteration, flowId, nextSeq };
      deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "iteration-start", data: { iteration } });
      let iterData: IterationData;

      // ── Custom engine path ──────────────────────────────────────────────
      if (s.activeEngineId != null && s.activeEngineId !== "dev" && !sidecarItem && process.env.GSD_ENGINE_BYPASS !== "1") {
        debugLog("autoLoop", { phase: "custom-engine-derive", iteration, engineId: s.activeEngineId });

        const { engine, policy } = resolveEngine({
          activeEngineId: s.activeEngineId,
          activeRunDir: s.activeRunDir,
        });

        const engineState = await engine.deriveState(s.basePath);
        if (engineState.isComplete) {
          await deps.stopAuto("Workflow complete");
          break;
        }

        debugLog("autoLoop", { phase: "custom-engine-dispatch", iteration });
        const dispatch = await engine.resolveDispatch(engineState, { basePath: s.basePath });

        if (dispatch.action === "stop") {
          await deps.stopAuto(dispatch.reason ?? "Engine stopped");
          break;
        }
        if (dispatch.action === "skip") {
          continue;
        }

        // dispatch.action === "dispatch"
        const step = dispatch.step!;
        const gsdState = await deps.deriveState(s.basePath);

        iterData = {
          unitType: step.unitType,
          unitId: step.unitId,
          prompt: step.prompt,
          finalPrompt: step.prompt,
          pauseAfterUatDispatch: false,
          state: gsdState,
          mid: s.currentMilestoneId ?? "workflow",
          midTitle: "Workflow",
          isRetry: false,
          previousTier: undefined,
        };

        // ── Progress widget ──
        deps.updateProgressWidget(iterData.unitType, iterData.unitId, iterData.state);

        // ── Guards (shared with dev path) ──
        const guardsResult = await runGuards(ic, s.currentMilestoneId ?? "workflow");
        if (guardsResult.action === "break") break;

        // ── Unit execution (shared with dev path) ──
        const unitPhaseResult = await runUnitPhase(ic, iterData, loopState);
        if (unitPhaseResult.action === "break") break;

        // ── Verify first, then reconcile (only mark complete on pass) ──
        debugLog("autoLoop", { phase: "custom-engine-verify", iteration, unitId: iterData.unitId });
        const verifyResult = await policy.verify(iterData.unitType, iterData.unitId, { basePath: s.basePath });
        if (verifyResult === "pause") {
          await deps.pauseAuto();
          break;
        }
        if (verifyResult === "retry") {
          debugLog("autoLoop", { phase: "custom-engine-verify-retry", iteration, unitId: iterData.unitId });
          continue;
        }

        // Verification passed — mark step complete
        debugLog("autoLoop", { phase: "custom-engine-reconcile", iteration, unitId: iterData.unitId });
        await engine.reconcile(engineState, {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          startedAt: s.currentUnit?.startedAt ?? Date.now(),
          finishedAt: Date.now(),
        });

        deps.clearUnitTimeout();
        consecutiveErrors = 0;
        recentErrorMessages.length = 0;
        deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "iteration-end", data: { iteration } });
        debugLog("autoLoop", { phase: "iteration-complete", iteration });
        continue;
      }

      if (!sidecarItem) {
        // ── Phase 1: Pre-dispatch ─────────────────────────────────────────
        const preDispatchResult = await runPreDispatch(ic, loopState);
        if (preDispatchResult.action === "break") break;
        if (preDispatchResult.action === "continue") continue;

        const preData = preDispatchResult.data;

        // ── Phase 2: Guards ───────────────────────────────────────────────
        const guardsResult = await runGuards(ic, preData.mid);
        if (guardsResult.action === "break") break;

        // ── Phase 3: Dispatch ─────────────────────────────────────────────
        const dispatchResult = await runDispatch(ic, preData, loopState);
        if (dispatchResult.action === "break") break;
        if (dispatchResult.action === "continue") continue;
        iterData = dispatchResult.data;
      } else {
        // ── Sidecar path: use values from the sidecar item directly ──
        const sidecarState = await deps.deriveState(s.basePath);
        iterData = {
          unitType: sidecarItem.unitType,
          unitId: sidecarItem.unitId,
          prompt: sidecarItem.prompt,
          finalPrompt: sidecarItem.prompt,
          pauseAfterUatDispatch: false,
          state: sidecarState,
          mid: sidecarState.activeMilestone?.id,
          midTitle: sidecarState.activeMilestone?.title,
          isRetry: false, previousTier: undefined,
        };
      }

      const unitPhaseResult = await runUnitPhase(ic, iterData, loopState, sidecarItem);
      if (unitPhaseResult.action === "break") break;

      // ── Phase 5: Finalize ───────────────────────────────────────────────

      const finalizeResult = await runFinalize(ic, iterData, loopState, sidecarItem);
      if (finalizeResult.action === "break") break;
      if (finalizeResult.action === "continue") continue;

      consecutiveErrors = 0; // Iteration completed successfully
      recentErrorMessages.length = 0;
      deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "iteration-end", data: { iteration } });
      debugLog("autoLoop", { phase: "iteration-complete", iteration });
    } catch (loopErr) {
      // ── Blanket catch: absorb unexpected exceptions, apply graduated recovery ──
      const msg = loopErr instanceof Error ? loopErr.message : String(loopErr);

      deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "iteration-end", data: { iteration, error: msg } });

      // ── Infrastructure errors: immediate stop, no retry ──
      const infraCode = isInfrastructureError(loopErr);
      if (infraCode) {
        debugLog("autoLoop", {
          phase: "infrastructure-error",
          iteration,
          code: infraCode,
          error: msg,
        });
        deps.events.notify(
          `Auto-mode stopped: infrastructure error ${infraCode} — ${msg}`,
          "error",
        );
        await deps.stopAuto(
          `Infrastructure error (${infraCode}): not recoverable by retry`,
        );
        break;
      }

      consecutiveErrors++;
      recentErrorMessages.push(msg.length > 120 ? msg.slice(0, 120) + "..." : msg);
      debugLog("autoLoop", {
        phase: "iteration-error",
        iteration,
        consecutiveErrors,
        error: msg,
      });

      if (consecutiveErrors >= 3) {
        const errorHistory = recentErrorMessages
          .map((m, i) => `  ${i + 1}. ${m}`)
          .join("\n");
        deps.events.notify(
          `Auto-mode stopped: ${consecutiveErrors} consecutive iteration failures:\n${errorHistory}`,
          "error",
        );
        await deps.stopAuto(
          `${consecutiveErrors} consecutive iteration failures`,
        );
        break;
      } else if (consecutiveErrors === 2) {
        deps.events.notify(
          `Iteration error (attempt ${consecutiveErrors}): ${msg}. Invalidating caches and retrying.`,
          "warning",
        );
        deps.invalidateAllCaches();
      } else {
        deps.events.notify(`Iteration error: ${msg}. Retrying.`, "warning");
      }
    }
  }

  _clearCurrentResolve();
  debugLog("autoLoop", { phase: "exit", totalIterations: iteration });
}
