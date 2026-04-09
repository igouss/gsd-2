/**
 * auto/orchestrator.ts — Main auto-mode execution loop.
 *
 * Iterates: pre-dispatch → guards → dispatch → execute → finalize → repeat.
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
import { runPreDispatch } from "./milestone/pre-dispatch.js";
import { runDispatch } from "./dispatch/dispatch.js";
import { runGuards } from "./guards/guards.js";
import { runUnitPhase } from "./execution/unit-phase.js";
import { runFinalize } from "./finalize/finalize.js";
import { debugLog } from "../debug-logger.js";
import { isInfrastructureError } from "./infra-errors.js";
import { resolveEngine } from "../routing/engine-resolver.js";
import type { JournalEventType } from "../persistence/journal.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Convenience emitter that captures flowId + nextSeq per iteration. */
type JournalEmitter = (eventType: JournalEventType, data: Record<string, unknown>) => void;

/** Mutable error-tracking state shared across iterations. */
interface ErrorTracker {
  consecutiveErrors: number;
  recentMessages: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildSidecarIterData(
  sidecarItem: SidecarItem,
  state: Awaited<ReturnType<CoreLoopDeps["deriveState"]>>,
): IterationData {
  return {
    unitType: sidecarItem.unitType,
    unitId: sidecarItem.unitId,
    prompt: sidecarItem.prompt,
    finalPrompt: sidecarItem.prompt,
    pauseAfterUatDispatch: false,
    state,
    mid: state.activeMilestone?.id,
    midTitle: state.activeMilestone?.title,
    isRetry: false,
    previousTier: undefined,
  };
}

/**
 * Custom engine path: resolve engine → derive state → dispatch → guards →
 * execute → verify → reconcile.
 *
 * Returns "break" / "continue" to control the outer while-loop.
 */
async function runCustomEnginePath(
  ic: IterationContext,
  loopState: LoopState,
  emitJournal: JournalEmitter,
): Promise<{ action: "break" | "continue" | "next" }> {
  const { s, deps, iteration } = ic;

  debugLog("autoLoop", { phase: "custom-engine-derive", iteration, engineId: s.activeEngineId });

  const { engine, policy } = resolveEngine({
    activeEngineId: s.activeEngineId,
    activeRunDir: s.activeRunDir,
  });

  const engineState = await engine.deriveState(s.basePath);
  if (engineState.isComplete) {
    await deps.stopAuto("Workflow complete");
    return { action: "break" };
  }

  debugLog("autoLoop", { phase: "custom-engine-dispatch", iteration });
  const dispatch = await engine.resolveDispatch(engineState, { basePath: s.basePath });

  if (dispatch.action === "stop") {
    await deps.stopAuto(dispatch.reason ?? "Engine stopped");
    return { action: "break" };
  }
  if (dispatch.action === "skip") {
    return { action: "continue" };
  }

  // dispatch.action === "dispatch"
  const step = dispatch.step!;
  const gsdState = await deps.deriveState(s.basePath);

  const iterData: IterationData = {
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
  if (guardsResult.action === "break") return { action: "break" };

  // ── Unit execution (shared with dev path) ──
  const unitPhaseResult = await runUnitPhase(ic, iterData, loopState);
  if (unitPhaseResult.action === "break") return { action: "break" };

  // ── Verify first, then reconcile (only mark complete on pass) ──
  debugLog("autoLoop", { phase: "custom-engine-verify", iteration, unitId: iterData.unitId });
  const verifyResult = await policy.verify(iterData.unitType, iterData.unitId, { basePath: s.basePath });
  if (verifyResult === "pause") {
    await deps.pauseAuto();
    return { action: "break" };
  }
  if (verifyResult === "retry") {
    debugLog("autoLoop", { phase: "custom-engine-verify-retry", iteration, unitId: iterData.unitId });
    return { action: "continue" };
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
  return { action: "next" };
}

/**
 * Dev path: pre-dispatch → guards → dispatch → execute → finalize.
 *
 * Returns "break" / "continue" / "next" to control the outer while-loop.
 */
async function runDevPath(
  ic: IterationContext,
  loopState: LoopState,
  sidecarItem: SidecarItem | undefined,
): Promise<{ action: "break" | "continue" | "next" }> {
  const { deps } = ic;
  let iterData: IterationData;

  if (!sidecarItem) {
    // ── Phase 1: Pre-dispatch (milestone lifecycle) ──────────────────
    const preDispatchResult = await runPreDispatch(ic, loopState);
    if (preDispatchResult.action === "break") return { action: "break" };
    if (preDispatchResult.action === "continue") return { action: "continue" };

    const preData = preDispatchResult.data;

    // ── Phase 2: Guards (budget, directives, secrets) ────────────────
    const guardsResult = await runGuards(ic, preData.mid);
    if (guardsResult.action === "break") return { action: "break" };

    // ── Phase 3: Dispatch (resolve next unit) ────────────────────────
    const dispatchResult = await runDispatch(ic, preData, loopState);
    if (dispatchResult.action === "break") return { action: "break" };
    if (dispatchResult.action === "continue") return { action: "continue" };
    iterData = dispatchResult.data;
  } else {
    // ── Sidecar path: use values from the sidecar item directly ──
    const sidecarState = await deps.deriveState(ic.s.basePath);
    iterData = buildSidecarIterData(sidecarItem, sidecarState);
  }

  // ── Phase 4: Execute (run the unit) ─────────────────────────────
  const unitPhaseResult = await runUnitPhase(ic, iterData, loopState, sidecarItem);
  if (unitPhaseResult.action === "break") return { action: "break" };

  // ── Phase 5: Finalize (verify the work) ────────────────────────────
  const finalizeResult = await runFinalize(ic, iterData, loopState, sidecarItem);
  if (finalizeResult.action === "break") return { action: "break" };
  if (finalizeResult.action === "continue") return { action: "continue" };

  return { action: "next" };
}

/**
 * Graduated error recovery: infrastructure errors stop immediately,
 * transient errors retry with escalation, 3 consecutive failures halt.
 *
 * Returns "break" to exit the loop, or "continue" to retry.
 */
function handleIterationError(
  err: unknown,
  deps: CoreLoopDeps,
  tracker: ErrorTracker,
  emitJournal: JournalEmitter,
  iteration: number,
): "break" | "continue" {
  const msg = err instanceof Error ? err.message : String(err);
  emitJournal("iteration-end", { iteration, error: msg });

  // ── Infrastructure errors: immediate stop, no retry ──
  const infraCode = isInfrastructureError(err);
  if (infraCode) {
    debugLog("autoLoop", { phase: "infrastructure-error", iteration, code: infraCode, error: msg });
    deps.events.notify(`Auto-mode stopped: infrastructure error ${infraCode} — ${msg}`, "error");
    void deps.stopAuto(`Infrastructure error (${infraCode}): not recoverable by retry`);
    return "break";
  }

  tracker.consecutiveErrors++;
  tracker.recentMessages.push(msg.length > 120 ? msg.slice(0, 120) + "..." : msg);
  debugLog("autoLoop", { phase: "iteration-error", iteration, consecutiveErrors: tracker.consecutiveErrors, error: msg });

  if (tracker.consecutiveErrors >= 3) {
    const errorHistory = tracker.recentMessages.map((m, i) => `  ${i + 1}. ${m}`).join("\n");
    deps.events.notify(`Auto-mode stopped: ${tracker.consecutiveErrors} consecutive iteration failures:\n${errorHistory}`, "error");
    void deps.stopAuto(`${tracker.consecutiveErrors} consecutive iteration failures`);
    return "break";
  } else if (tracker.consecutiveErrors === 2) {
    deps.events.notify(`Iteration error (attempt ${tracker.consecutiveErrors}): ${msg}. Invalidating caches and retrying.`, "warning");
    deps.invalidateAllCaches();
  } else {
    deps.events.notify(`Iteration error: ${msg}. Retrying.`, "warning");
  }
  return "continue";
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

/**
 * Main auto-mode execution loop. Iterates: pre-dispatch → guards →
 * dispatch → execute → finalize → repeat. Exits when s.active becomes
 * false or a terminal condition is reached.
 */
export async function autoLoop(
  s: AutoSession,
  deps: CoreLoopDeps,
): Promise<void> {
  debugLog("autoLoop", { phase: "enter" });
  let iteration = 0;
  const loopState: LoopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const errorTracker: ErrorTracker = { consecutiveErrors: 0, recentMessages: [] };

  while (s.active) {
    iteration++;
    debugLog("autoLoop", { phase: "loop-top", iteration });

    // ── Journal: per-iteration flow grouping ──
    const flowId = randomUUID();
    let seqCounter = 0;
    const nextSeq = () => ++seqCounter;
    const emitJournal: JournalEmitter = (eventType, data) =>
      deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType, data });

    if (iteration > MAX_LOOP_ITERATIONS) {
      debugLog("autoLoop", { phase: "exit", reason: "max-iterations", iteration });
      await deps.stopAuto(`Safety: loop exceeded ${MAX_LOOP_ITERATIONS} iterations — possible runaway`);
      break;
    }

    try {
      const prefs = deps.loadEffectiveGSDPreferences()?.preferences;

      // ── Check sidecar queue before deriveState ──
      let sidecarItem: SidecarItem | undefined;
      if (s.sidecarQueue.length > 0) {
        sidecarItem = s.sidecarQueue.shift()!;
        debugLog("autoLoop", { phase: "sidecar-dequeue", kind: sidecarItem.kind, unitType: sidecarItem.unitType, unitId: sidecarItem.unitId });
        emitJournal("sidecar-dequeue", { kind: sidecarItem.kind, unitType: sidecarItem.unitType, unitId: sidecarItem.unitId });
      }

      // ── Session lock validation ──
      const sessionLockBase = deps.lockBase();
      if (sessionLockBase) {
        const lockStatus = deps.validateSessionLock(sessionLockBase);
        if (!lockStatus.valid) {
          debugLog("autoLoop", { phase: "session-lock-invalid", reason: lockStatus.failureReason ?? "unknown", existingPid: lockStatus.existingPid, expectedPid: lockStatus.expectedPid });
          deps.handleLostSessionLock(lockStatus);
          debugLog("autoLoop", { phase: "exit", reason: "session-lock-lost", detail: lockStatus.failureReason ?? "unknown" });
          break;
        }
      }

      const ic: IterationContext = { s, deps, prefs, iteration, flowId, nextSeq };
      emitJournal("iteration-start", { iteration });

      // ── Route to engine path or dev path ──
      const isCustomEngine = s.activeEngineId != null && s.activeEngineId !== "dev"
        && !sidecarItem && process.env.GSD_ENGINE_BYPASS !== "1";

      const result = isCustomEngine
        ? await runCustomEnginePath(ic, loopState, emitJournal)
        : await runDevPath(ic, loopState, sidecarItem);

      if (result.action === "break") break;
      if (result.action === "continue") continue;

      // ── Iteration completed successfully ──
      errorTracker.consecutiveErrors = 0;
      errorTracker.recentMessages.length = 0;
      emitJournal("iteration-end", { iteration });
      debugLog("autoLoop", { phase: "iteration-complete", iteration });
    } catch (loopErr) {
      const decision = handleIterationError(loopErr, deps, errorTracker, emitJournal, iteration);
      if (decision === "break") break;
    }
  }

  _clearCurrentResolve();
  debugLog("autoLoop", { phase: "exit", totalIterations: iteration });
}
