/**
 * auto/phases.ts — Pipeline phases for the auto-loop.
 *
 * Contains: runPreDispatch, runDispatch, runGuards, runUnitPhase, runFinalize,
 * plus internal helpers generateMilestoneReport and closeoutAndStop.
 *
 * Harness-free: uses CoreLoopDeps + OrchestratorEventSink instead of
 * ExtensionContext/ExtensionAPI. Unit execution goes through
 * deps.adapter.dispatchUnit().
 */

import type { AutoSession, SidecarItem } from "./session.js";
import type { CoreLoopDeps, PreVerificationOpts } from "./loop-deps.js";
import {
  MAX_RECOVERY_CHARS,
  BUDGET_THRESHOLDS,
  MAX_FINALIZE_TIMEOUTS,
  type PhaseResult,
  type IterationContext,
  type LoopState,
  type PreDispatchData,
  type IterationData,
} from "./types.js";
import { detectStuck } from "./detect-stuck.js";
import { debugLog } from "../debug-logger.js";
import { PROJECT_FILES } from "../detection.js";
import { MergeConflictError } from "../git/git-service.js";
import { join, basename, dirname, parse as parsePath } from "node:path";
import { existsSync, cpSync, readdirSync } from "node:fs";
import { logWarning, logError } from "../workflow/workflow-logger.js";
import { gsdRoot } from "../persistence/paths.js";
import { atomicWriteSync } from "../persistence/atomic-write.js";
import { verifyExpectedArtifact, buildLoopRemediationSteps } from "./auto-recovery.js";
import { diagnoseExpectedArtifact } from "./auto-artifact-paths.js";
import { writeUnitRuntimeRecord } from "../unit-runtime.js";
import { withTimeout, FINALIZE_PRE_TIMEOUT_MS, FINALIZE_POST_TIMEOUT_MS } from "./finalize-timeout.js";
import { getEligibleSlices } from "../parallel/slice-parallel-eligibility.js";
import { startSliceParallel } from "../parallel/slice-parallel-orchestrator.js";
import { isDbAvailable, getMilestoneSlices } from "../persistence/gsd-db.js";
import { resetEvidence } from "../safety/evidence-collector.js";
import { createCheckpoint, cleanupCheckpoint, rollbackToCheckpoint } from "../safety/git-checkpoint.js";
import { resolveSafetyHarnessConfig } from "../safety/safety-harness.js";

// ─── generateMilestoneReport ──────────────────────────────────────────────────

/**
 * Resolve the base path for milestone reports.
 * Prefers originalBasePath (project root) over basePath (which may be a worktree).
 * Exported for testing as _resolveReportBasePath.
 */
export function _resolveReportBasePath(s: Pick<AutoSession, "originalBasePath" | "basePath">): string {
  return s.originalBasePath || s.basePath;
}

/**
 * Resolve the authoritative project base for dispatch guards.
 * Prior-milestone completion lives at the project root, even when the active
 * unit is running inside an auto worktree.
 */
export function _resolveDispatchGuardBasePath(
  s: Pick<AutoSession, "originalBasePath" | "basePath">,
): string {
  return s.originalBasePath || s.basePath;
}

/**
 * Generate and write an HTML milestone report snapshot.
 * Extracted from the milestone-transition block in autoLoop.
 */
async function generateMilestoneReport(
  s: AutoSession,
  deps: CoreLoopDeps,
  milestoneId: string,
): Promise<void> {
  const { loadVisualizerData } = await import("../reporting/visualizer-data.js");
  const { generateHtmlReport } = await import("../reporting/export-html.js");
  const { writeReportSnapshot } = await import("../reporting/reports.js");

  const reportBasePath = _resolveReportBasePath(s);

  const snapData = await loadVisualizerData(reportBasePath);
  const completedMs = snapData.milestones.find(
    (m: { id: string }) => m.id === milestoneId,
  );
  const msTitle = completedMs?.title ?? milestoneId;
  const gsdVersion = process.env.GSD_VERSION ?? "0.0.0";
  const projName = basename(reportBasePath);
  const doneSlices = snapData.milestones.reduce(
    (acc: number, m: { slices: { done: boolean }[] }) =>
      acc + m.slices.filter((sl: { done: boolean }) => sl.done).length,
    0,
  );
  const totalSlices = snapData.milestones.reduce(
    (acc: number, m: { slices: unknown[] }) => acc + m.slices.length,
    0,
  );
  const outPath = writeReportSnapshot({
    basePath: reportBasePath,
    html: generateHtmlReport(snapData, {
      projectName: projName,
      projectPath: reportBasePath,
      gsdVersion,
      milestoneId,
      indexRelPath: "index.html",
    }),
    milestoneId,
    milestoneTitle: msTitle,
    kind: "milestone",
    projectName: projName,
    projectPath: reportBasePath,
    gsdVersion,
    totalCost: snapData.totals?.cost ?? 0,
    totalTokens: snapData.totals?.tokens.total ?? 0,
    totalDuration: snapData.totals?.duration ?? 0,
    doneSlices,
    totalSlices,
    doneMilestones: snapData.milestones.filter(
      (m: { status: string }) => m.status === "complete",
    ).length,
    totalMilestones: snapData.milestones.length,
    phase: snapData.phase,
  });
  deps.events.notify(
    `Report saved: .gsd/reports/${basename(outPath)} — open index.html to browse progression.`,
    "info",
  );
}

// ─── closeoutAndStop ──────────────────────────────────────────────────────────

/**
 * If a unit is in-flight, close it out, then stop auto-mode.
 * Extracted from ~4 identical if-closeout-then-stop sequences in autoLoop.
 */
async function closeoutAndStop(
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

// ─── runPreDispatch ───────────────────────────────────────────────────────────

/**
 * Phase 1: Pre-dispatch — resource guard, health gate, state derivation,
 * milestone transition, terminal conditions.
 * Returns break to exit the loop, or next with PreDispatchData on success.
 */
export async function runPreDispatch(
  ic: IterationContext,
  loopState: LoopState,
): Promise<PhaseResult<PreDispatchData>> {
  const { s, deps, prefs } = ic;

  // Resource version guard
  const staleMsg = deps.checkResourcesStale(s.resourceVersionOnStart);
  if (staleMsg) {
    await deps.stopAuto(staleMsg);
    debugLog("autoLoop", { phase: "exit", reason: "resources-stale" });
    return { action: "break", reason: "resources-stale" };
  }

  deps.invalidateAllCaches();
  s.lastPromptCharCount = undefined;
  s.lastBaselineCharCount = undefined;

  // Pre-dispatch health gate
  try {
    const healthGate = await deps.preDispatchHealthGate(s.basePath);
    if (healthGate.fixesApplied.length > 0) {
      deps.events.notify(
        `Pre-dispatch: ${healthGate.fixesApplied.join(", ")}`,
        "info",
      );
    }
    if (!healthGate.proceed) {
      deps.events.notify(
        healthGate.reason || "Pre-dispatch health check failed — run /gsd doctor for details.",
        "error",
      );
      await deps.pauseAuto();
      debugLog("autoLoop", { phase: "exit", reason: "health-gate-failed" });
      return { action: "break", reason: "health-gate-failed" };
    }
  } catch (e) {
    logWarning("engine", "Pre-dispatch health gate threw unexpectedly", { error: String(e) });
  }

  // Sync project root artifacts into worktree
  if (
    s.originalBasePath &&
    s.basePath !== s.originalBasePath &&
    s.currentMilestoneId
  ) {
    deps.syncProjectRootToWorktree(
      s.originalBasePath,
      s.basePath,
      s.currentMilestoneId,
    );
  }

  // Derive state
  let state = await deps.deriveState(s.basePath);
  deps.syncCmuxSidebar(prefs, state);
  let mid = state.activeMilestone?.id;
  let midTitle = state.activeMilestone?.title;
  debugLog("autoLoop", {
    phase: "state-derived",
    iteration: ic.iteration,
    mid,
    statePhase: state.phase,
  });

  // ── Slice-level parallelism gate (#2340) ─────────────────────────────
  if (
    prefs?.slice_parallel?.enabled &&
    mid &&
    !process.env.GSD_PARALLEL_WORKER &&
    isDbAvailable()
  ) {
    try {
      const dbSlices = getMilestoneSlices(mid);
      if (dbSlices.length > 0) {
        const doneIds = new Set(dbSlices.filter(sl => sl.status === "complete" || sl.status === "done").map(sl => sl.id));
        const sliceInputs = dbSlices.map(sl => ({
          id: sl.id,
          done: doneIds.has(sl.id),
          depends: sl.depends ?? [],
        }));
        const eligible = getEligibleSlices(sliceInputs, doneIds);
        if (eligible.length > 1) {
          debugLog("autoLoop", {
            phase: "slice-parallel-dispatch",
            iteration: ic.iteration,
            mid,
            eligibleSlices: eligible.map(e => e.id),
          });
          deps.events.notify(
            `Slice-parallel: dispatching ${eligible.length} eligible slices for ${mid}.`,
            "info",
          );
          const result = await startSliceParallel(
            s.basePath,
            mid,
            eligible,
            { maxWorkers: prefs.slice_parallel.max_workers ?? 2 },
          );
          if (result.started.length > 0) {
            deps.events.notify(
              `Slice-parallel: started ${result.started.length} worker(s): ${result.started.join(", ")}.`,
              "info",
            );
            await deps.stopAuto(`Slice-parallel dispatched for ${mid}`);
            return { action: "break", reason: "slice-parallel-dispatched" };
          }
          // Fall through to sequential if no workers started
        }
      }
    } catch (err) {
      debugLog("autoLoop", {
        phase: "slice-parallel-check-error",
        error: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal — fall through to sequential dispatch
    }
  }

  // ── Milestone transition ────────────────────────────────────────────
  if (mid && s.currentMilestoneId && mid !== s.currentMilestoneId) {
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "milestone-transition", data: { from: s.currentMilestoneId, to: mid } });
    deps.events.notify(
      `Milestone ${s.currentMilestoneId} complete. Advancing to ${mid}: ${midTitle}.`,
      "info",
    );
    deps.sendDesktopNotification(
      "GSD",
      `Milestone ${s.currentMilestoneId} complete!`,
      "success",
      "milestone",
      basename(s.originalBasePath || s.basePath),
    );
    deps.logCmuxEvent(
      prefs,
      `Milestone ${s.currentMilestoneId} complete. Advancing to ${mid}.`,
      "success",
    );

    const vizPrefs = prefs;
    if (vizPrefs?.auto_visualize) {
      deps.events.notify("Run /gsd visualize to see progress overview.", "info");
    }
    if (vizPrefs?.auto_report !== false) {
      try {
        await generateMilestoneReport(s, deps, s.currentMilestoneId!);
      } catch (err) {
        deps.events.notify(
          `Report generation failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    }

    // Reset dispatch counters for new milestone
    s.unitDispatchCount.clear();
    s.unitRecoveryCount.clear();
    s.unitLifetimeDispatches.clear();
    loopState.recentUnits.length = 0;
    loopState.stuckRecoveryAttempts = 0;

    // Worktree lifecycle on milestone transition — merge current, enter next
    try {
      deps.resolver.mergeAndExit(s.currentMilestoneId!, deps.events);
    } catch (mergeErr) {
      if (mergeErr instanceof MergeConflictError) {
        deps.events.notify(
          `Merge conflict: ${mergeErr.conflictedFiles.join(", ")}. Resolve conflicts manually and run /gsd auto to resume.`,
          "error",
        );
        await deps.stopAuto(`Merge conflict on milestone ${s.currentMilestoneId}`);
        return { action: "break", reason: "merge-conflict" };
      }
      logError("engine", "Milestone merge failed with non-conflict error", { milestone: s.currentMilestoneId!, error: String(mergeErr) });
      deps.events.notify(
        `Merge failed: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}. Resolve and run /gsd auto to resume.`,
        "error",
      );
      await deps.stopAuto(`Merge error on milestone ${s.currentMilestoneId}: ${String(mergeErr)}`);
      return { action: "break", reason: "merge-failed" };
    }

    // PR creation (auto_pr) is handled inside mergeMilestoneToMain (#2302)

    deps.invalidateAllCaches();

    state = await deps.deriveState(s.basePath);
    mid = state.activeMilestone?.id;
    midTitle = state.activeMilestone?.title;

    if (mid) {
      if (deps.getIsolationMode() !== "none") {
        deps.captureIntegrationBranch(s.basePath, mid);
      }
      deps.resolver.enterMilestone(mid, deps.events);
    }

    const pendingIds = state.registry
      .filter(
        (m: { status: string }) =>
          m.status !== "complete" && m.status !== "parked",
      )
      .map((m: { id: string }) => m.id);
    deps.pruneQueueOrder(s.basePath, pendingIds);

    // Archive the old completed-units.json instead of wiping it (#2313).
    try {
      const completedKeysPath = join(gsdRoot(s.basePath), "completed-units.json");
      if (existsSync(completedKeysPath) && s.currentMilestoneId) {
        const archivePath = join(
          gsdRoot(s.basePath),
          `completed-units-${s.currentMilestoneId}.json`,
        );
        cpSync(completedKeysPath, archivePath);
      }
      atomicWriteSync(completedKeysPath, JSON.stringify([], null, 2));
    } catch (e) {
      logWarning("engine", "Failed to archive completed-units on milestone transition", { error: String(e) });
    }

    // Rebuild STATE.md immediately so it reflects the new active milestone.
    try {
      await deps.rebuildState(s.basePath);
    } catch (e) {
      logWarning("engine", "STATE.md rebuild failed after milestone transition", { error: String(e) });
    }
  }

  if (mid) {
    s.currentMilestoneId = mid;
    deps.setActiveMilestoneId(s.basePath, mid);
  }

  // ── Terminal conditions ──────────────────────────────────────────────

  if (!mid) {
    if (s.currentUnit) {
      await deps.closeoutUnit(
        s.basePath,
        s.currentUnit.type,
        s.currentUnit.id,
        s.currentUnit.startedAt,
        deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id),
      );
    }

    const incomplete = state.registry.filter(
      (m: { status: string }) =>
        m.status !== "complete" && m.status !== "parked",
    );
    if (incomplete.length === 0 && state.registry.length > 0) {
      // All milestones complete — merge milestone branch before stopping
      if (s.currentMilestoneId) {
        try {
          deps.resolver.mergeAndExit(s.currentMilestoneId, deps.events);
          // Prevent stopAuto from attempting the same merge (#2645)
          s.milestoneMergedInPhases = true;
        } catch (mergeErr) {
          if (mergeErr instanceof MergeConflictError) {
            deps.events.notify(
              `Merge conflict: ${mergeErr.conflictedFiles.join(", ")}. Resolve conflicts manually and run /gsd auto to resume.`,
              "error",
            );
            await deps.stopAuto(`Merge conflict on milestone ${s.currentMilestoneId}`);
            return { action: "break", reason: "merge-conflict" };
          }
          logError("engine", "Milestone merge failed with non-conflict error", { milestone: s.currentMilestoneId!, error: String(mergeErr) });
          deps.events.notify(
            `Merge failed: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}. Resolve and run /gsd auto to resume.`,
            "error",
          );
          await deps.stopAuto(`Merge error on milestone ${s.currentMilestoneId}: ${String(mergeErr)}`);
          return { action: "break", reason: "merge-failed" };
        }

        // PR creation (auto_pr) is handled inside mergeMilestoneToMain (#2302)
      }
      deps.sendDesktopNotification(
        "GSD",
        "All milestones complete!",
        "success",
        "milestone",
        basename(s.originalBasePath || s.basePath),
      );
      deps.logCmuxEvent(
        prefs,
        "All milestones complete.",
        "success",
      );
      await deps.stopAuto("All milestones complete");
    } else if (incomplete.length === 0 && state.registry.length === 0) {
      const diag = `basePath=${s.basePath}, phase=${state.phase}`;
      deps.events.notify(
        `No milestones visible in current scope. Possible path resolution issue.\n   Diagnostic: ${diag}`,
        "error",
      );
      await deps.stopAuto(
        `No milestones found — check basePath resolution`,
      );
    } else if (state.phase === "blocked") {
      const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
      await deps.stopAuto(blockerMsg);
      deps.events.notify(`${blockerMsg}. Fix and run /gsd auto.`, "warning");
      deps.sendDesktopNotification("GSD", blockerMsg, "error", "attention", basename(s.originalBasePath || s.basePath));
      deps.logCmuxEvent(prefs, blockerMsg, "error");
    } else {
      const ids = incomplete.map((m: { id: string }) => m.id).join(", ");
      const diag = `basePath=${s.basePath}, milestones=[${state.registry.map((m: { id: string; status: string }) => `${m.id}:${m.status}`).join(", ")}], phase=${state.phase}`;
      deps.events.notify(
        `Unexpected: ${incomplete.length} incomplete milestone(s) (${ids}) but no active milestone.\n   Diagnostic: ${diag}`,
        "error",
      );
      await deps.stopAuto(
        `No active milestone — ${incomplete.length} incomplete (${ids}), see diagnostic above`,
      );
    }
    debugLog("autoLoop", { phase: "exit", reason: "no-active-milestone" });
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "no-active-milestone" } });
    return { action: "break", reason: "no-active-milestone" };
  }

  if (!midTitle) {
    midTitle = mid;
    deps.events.notify(
      `Milestone ${mid} has no title in roadmap — using ID as fallback.`,
      "warning",
    );
  }

  // Mid-merge safety check
  if (deps.reconcileMergeState(s.basePath)) {
    deps.invalidateAllCaches();
    state = await deps.deriveState(s.basePath);
    mid = state.activeMilestone?.id;
    midTitle = state.activeMilestone?.title;
  }

  if (!mid || !midTitle) {
    const noMilestoneReason = !mid
      ? "No active milestone after merge reconciliation"
      : `Milestone ${mid} has no title after reconciliation`;
    await closeoutAndStop(s, deps, noMilestoneReason);
    debugLog("autoLoop", {
      phase: "exit",
      reason: "no-milestone-after-reconciliation",
    });
    return { action: "break", reason: "no-milestone-after-reconciliation" };
  }

  // Terminal: complete
  if (state.phase === "complete") {
    // Milestone merge on complete (before closeout so branch state is clean)
    if (s.currentMilestoneId) {
      try {
        deps.resolver.mergeAndExit(s.currentMilestoneId, deps.events);
        // Prevent stopAuto from attempting the same merge (#2645)
        s.milestoneMergedInPhases = true;
      } catch (mergeErr) {
        if (mergeErr instanceof MergeConflictError) {
          deps.events.notify(
            `Merge conflict: ${mergeErr.conflictedFiles.join(", ")}. Resolve conflicts manually and run /gsd auto to resume.`,
            "error",
          );
          await deps.stopAuto(`Merge conflict on milestone ${s.currentMilestoneId}`);
          return { action: "break", reason: "merge-conflict" };
        }
        logError("engine", "Milestone merge failed with non-conflict error", { milestone: s.currentMilestoneId!, error: String(mergeErr) });
        deps.events.notify(
          `Merge failed: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}. Resolve and run /gsd auto to resume.`,
          "error",
        );
        await deps.stopAuto(`Merge error on milestone ${s.currentMilestoneId}: ${String(mergeErr)}`);
        return { action: "break", reason: "merge-failed" };
      }

      // PR creation (auto_pr) is handled inside mergeMilestoneToMain (#2302)
    }
    deps.sendDesktopNotification(
      "GSD",
      `Milestone ${mid} complete!`,
      "success",
      "milestone",
      basename(s.originalBasePath || s.basePath),
    );
    deps.logCmuxEvent(
      prefs,
      `Milestone ${mid} complete.`,
      "success",
    );
    await closeoutAndStop(s, deps, `Milestone ${mid} complete`);
    debugLog("autoLoop", { phase: "exit", reason: "milestone-complete" });
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "milestone-complete", milestoneId: mid } });
    return { action: "break", reason: "milestone-complete" };
  }

  // Terminal: blocked
  if (state.phase === "blocked") {
    const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
    await closeoutAndStop(s, deps, blockerMsg);
    deps.events.notify(`${blockerMsg}. Fix and run /gsd auto.`, "warning");
    deps.sendDesktopNotification("GSD", blockerMsg, "error", "attention", basename(s.originalBasePath || s.basePath));
    deps.logCmuxEvent(prefs, blockerMsg, "error");
    debugLog("autoLoop", { phase: "exit", reason: "blocked" });
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "blocked", blockers: state.blockers } });
    return { action: "break", reason: "blocked" };
  }

  return { action: "next", data: { state, mid, midTitle } };
}

// ─── runDispatch ──────────────────────────────────────────────────────────────

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

  const guardBasePath = _resolveDispatchGuardBasePath(s);
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

// ─── runGuards ────────────────────────────────────────────────────────────────

/**
 * Phase 2: Guards — stop directives, budget ceiling, context window, secrets re-check.
 * Returns break to exit the loop, or next to proceed to dispatch.
 */
export async function runGuards(
  ic: IterationContext,
  mid: string,
): Promise<PhaseResult> {
  const { s, deps, prefs } = ic;

  // ── Stop/Backtrack directive guard (#3487) ──
  try {
    const { loadStopCaptures, markCaptureExecuted } = await import("./captures.js");
    const stopCaptures = loadStopCaptures(s.basePath);
    if (stopCaptures.length > 0) {
      const first = stopCaptures[0];
      const isBacktrack = first.classification === "backtrack";
      const label = isBacktrack
        ? `Backtrack directive: ${first.text}`
        : `Stop directive: ${first.text}`;

      deps.events.notify(label, "warning");
      deps.sendDesktopNotification(
        "GSD", label, "warning", "stop-directive",
        basename(s.originalBasePath || s.basePath),
      );

      // Pause first — ensures auto-mode stops even if later steps fail
      await deps.pauseAuto();

      // For backtrack captures, write the backtrack trigger after pausing
      if (isBacktrack) {
        try {
          const { executeBacktrack } = await import("./triage-resolution.js");
          executeBacktrack(s.basePath, mid, first);
        } catch (e) {
          debugLog("guards", { phase: "backtrack-execution-error", error: String(e) });
        }
      }

      // Mark captures as executed only after successful pause/transition
      for (const cap of stopCaptures) {
        markCaptureExecuted(s.basePath, cap.id);
      }

      debugLog("autoLoop", { phase: "exit", reason: isBacktrack ? "user-backtrack" : "user-stop" });
      return { action: "break", reason: isBacktrack ? "user-backtrack" : "user-stop" };
    }
  } catch (e) {
    debugLog("guards", { phase: "stop-guard-error", error: String(e) });
    return { action: "break", reason: "stop-guard-error" };
  }

  // Budget ceiling guard
  const budgetCeiling = prefs?.budget_ceiling;
  if (budgetCeiling !== undefined && budgetCeiling > 0) {
    const currentLedger = deps.getLedger() as { units: unknown } | null;
    let costUnits = currentLedger?.units;
    if (process.env.GSD_PARALLEL_WORKER && s.autoStartTime && Array.isArray(costUnits)) {
      const sessionStartISO = new Date(s.autoStartTime).toISOString();
      costUnits = costUnits.filter(
        (u: { startedAt?: string }) => u.startedAt != null && u.startedAt >= sessionStartISO,
      );
    }
    const totalCost = costUnits
      ? deps.getProjectTotals(costUnits).cost
      : 0;
    const budgetPct = totalCost / budgetCeiling;
    const budgetAlertLevel = deps.getBudgetAlertLevel(budgetPct);
    const newBudgetAlertLevel = deps.getNewBudgetAlertLevel(
      s.lastBudgetAlertLevel,
      budgetPct,
    );
    const enforcement = prefs?.budget_enforcement ?? "pause";
    const budgetEnforcementAction = deps.getBudgetEnforcementAction(
      enforcement,
      budgetPct,
    );

    const threshold = BUDGET_THRESHOLDS.find(
      (t) => newBudgetAlertLevel >= t.pct,
    );
    if (threshold) {
      s.lastBudgetAlertLevel =
        newBudgetAlertLevel as AutoSession["lastBudgetAlertLevel"];

      if (threshold.pct === 100 && budgetEnforcementAction !== "none") {
        const msg = `Budget ceiling ${deps.formatCost(budgetCeiling)} reached (spent ${deps.formatCost(totalCost)}).`;
        if (budgetEnforcementAction === "halt") {
          deps.sendDesktopNotification("GSD", msg, "error", "budget", basename(s.originalBasePath || s.basePath));
          await deps.stopAuto("Budget ceiling reached");
          debugLog("autoLoop", { phase: "exit", reason: "budget-halt" });
          return { action: "break", reason: "budget-halt" };
        }
        if (budgetEnforcementAction === "pause") {
          deps.events.notify(
            `${msg} Pausing auto-mode — /gsd auto to override and continue.`,
            "warning",
          );
          deps.sendDesktopNotification("GSD", msg, "warning", "budget", basename(s.originalBasePath || s.basePath));
          deps.logCmuxEvent(prefs, msg, "warning");
          await deps.pauseAuto();
          debugLog("autoLoop", { phase: "exit", reason: "budget-pause" });
          return { action: "break", reason: "budget-pause" };
        }
        deps.events.notify(`${msg} Continuing (enforcement: warn).`, "warning");
        deps.sendDesktopNotification("GSD", msg, "warning", "budget", basename(s.originalBasePath || s.basePath));
        deps.logCmuxEvent(prefs, msg, "warning");
      } else if (threshold.pct < 100) {
        const msg = `${threshold.label}: ${deps.formatCost(totalCost)} / ${deps.formatCost(budgetCeiling)}`;
        deps.events.notify(msg, threshold.notifyLevel);
        deps.sendDesktopNotification(
          "GSD",
          msg,
          threshold.notifyLevel,
          "budget",
          basename(s.originalBasePath || s.basePath),
        );
        deps.logCmuxEvent(prefs, msg, threshold.cmuxLevel);
      }
    } else if (budgetAlertLevel === 0) {
      s.lastBudgetAlertLevel = 0;
    }
  } else {
    s.lastBudgetAlertLevel = 0;
  }

  // Context window guard — removed (cmdCtx is harness-specific; adapter manages context)

  // Secrets re-check gate
  try {
    const manifestStatus = await deps.getManifestStatus(s.basePath, mid, s.originalBasePath);
    if (manifestStatus && manifestStatus.pending.length > 0) {
      const result = await deps.collectSecretsFromManifest(
        s.basePath,
        mid,
      );
      if (
        result &&
        result.applied &&
        result.skipped &&
        result.existingSkipped
      ) {
        deps.events.notify(
          `Secrets collected: ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.existingSkipped.length} already set.`,
          "info",
        );
      } else {
        deps.events.notify("Secrets collection skipped.", "info");
      }
    }
  } catch (err) {
    deps.events.notify(
      `Secrets collection error: ${err instanceof Error ? err.message : String(err)}. Continuing with next task.`,
      "warning",
    );
  }

  return { action: "next", data: undefined as void };
}

// ─── runUnitPhase ─────────────────────────────────────────────────────────────

/**
 * Phase 4: Unit execution — dispatch prompt, await result, closeout, artifact verify.
 * Returns break or next with unitStartedAt for downstream phases.
 */
export async function runUnitPhase(
  ic: IterationContext,
  iterData: IterationData,
  loopState: LoopState,
  sidecarItem?: SidecarItem,
): Promise<PhaseResult<{ unitStartedAt: number }>> {
  const { s, deps, prefs } = ic;
  const { unitType, unitId, prompt, state, mid } = iterData;

  debugLog("autoLoop", {
    phase: "unit-execution",
    iteration: ic.iteration,
    unitType,
    unitId,
  });

  // ── Worktree health check (#1833, #1843) ────────────────────────────
  if (s.basePath && unitType === "execute-task") {
    const gitMarker = join(s.basePath, ".git");
    const hasGit = deps.existsSync(gitMarker);
    if (!hasGit) {
      const msg = `Worktree health check failed: ${s.basePath} has no .git — refusing to dispatch ${unitType} ${unitId}`;
      debugLog("runUnitPhase", { phase: "worktree-health-fail", basePath: s.basePath, hasGit });
      deps.events.notify(msg, "error");
      await deps.stopAuto(msg);
      return { action: "break", reason: "worktree-invalid" };
    }
    const hasProjectFile = PROJECT_FILES.some((f) => deps.existsSync(join(s.basePath, f)));
    const hasSrcDir = deps.existsSync(join(s.basePath, "src"));
    let hasXcodeBundle = false;
    try {
      const entries = deps.existsSync(s.basePath) ? readdirSync(s.basePath) : [];
      hasXcodeBundle = entries.some((e: string) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"));
    } catch (err) {
      debugLog("runUnitPhase", { phase: "xcode-bundle-scan-failed", basePath: s.basePath, error: String(err) });
    }
    let hasProjectFileInParent = false;
    if (!hasProjectFile && !hasSrcDir && !hasXcodeBundle) {
      let checkDir = dirname(s.basePath);
      const { root } = parsePath(checkDir);
      while (checkDir !== root) {
        if (deps.existsSync(join(checkDir, ".git"))) break;
        if (PROJECT_FILES.some((f) => deps.existsSync(join(checkDir, f)))) {
          hasProjectFileInParent = true;
          break;
        }
        checkDir = dirname(checkDir);
      }
    }
    if (!hasProjectFile && !hasSrcDir && !hasXcodeBundle && !hasProjectFileInParent) {
      debugLog("runUnitPhase", { phase: "worktree-health-warn-greenfield", basePath: s.basePath, hasProjectFile, hasSrcDir, hasXcodeBundle });
      deps.events.notify(`Warning: ${s.basePath} has no recognized project files — proceeding as greenfield project`, "warning");
    }
  }

  // Detect retry and capture previous tier for escalation
  const isRetry = !!(
    s.currentUnit &&
    s.currentUnit.type === unitType &&
    s.currentUnit.id === unitId
  );
  const previousTier = s.currentUnitRouting?.tier;

  s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  s.lastToolInvocationError = null;
  const unitStartSeq = ic.nextSeq();
  deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: unitStartSeq, eventType: "unit-start", data: { unitType, unitId } });
  deps.captureAvailableSkills();
  writeUnitRuntimeRecord(
    s.basePath,
    unitType,
    unitId,
    s.currentUnit.startedAt,
    {
      phase: "dispatched",
      wrapupWarningSent: false,
      timeoutAt: null,
      lastProgressAt: s.currentUnit.startedAt,
      progressCount: 0,
      lastProgressKind: "dispatch",
      recoveryAttempts: 0,
    },
  );

  // Progress widget + preconditions deferred until after model selection
  if (mid)
    deps.updateSliceProgressCache(s.basePath, mid, state.activeSlice?.id);

  // ── Safety harness: reset evidence + create checkpoint ──
  const safetyConfig = resolveSafetyHarnessConfig(
    prefs?.safety_harness as Record<string, unknown> | undefined,
  );
  if (safetyConfig.enabled && safetyConfig.evidence_collection) {
    resetEvidence();
  }
  if (safetyConfig.enabled && safetyConfig.checkpoints && unitType === "execute-task") {
    s.checkpointSha = createCheckpoint(s.basePath, unitId);
    if (s.checkpointSha) {
      debugLog("runUnitPhase", { phase: "checkpoint-created", unitId, sha: s.checkpointSha.slice(0, 8) });
    }
  }

  // Prompt injection
  let finalPrompt = prompt;

  if (s.pendingVerificationRetry) {
    const retryCtx = s.pendingVerificationRetry;
    s.pendingVerificationRetry = null;
    const capped =
      retryCtx.failureContext.length > MAX_RECOVERY_CHARS
        ? retryCtx.failureContext.slice(0, MAX_RECOVERY_CHARS) +
          "\n\n[...failure context truncated]"
        : retryCtx.failureContext;
    finalPrompt = `**VERIFICATION FAILED — AUTO-FIX ATTEMPT ${retryCtx.attempt}**\n\nThe verification gate ran after your previous attempt and found failures. Fix these issues before completing the task.\n\n${capped}\n\n---\n\n${finalPrompt}`;
  }

  if (s.pendingCrashRecovery) {
    const capped =
      s.pendingCrashRecovery.length > MAX_RECOVERY_CHARS
        ? s.pendingCrashRecovery.slice(0, MAX_RECOVERY_CHARS) +
          "\n\n[...recovery briefing truncated to prevent memory exhaustion]"
        : s.pendingCrashRecovery;
    finalPrompt = `${capped}\n\n---\n\n${finalPrompt}`;
    s.pendingCrashRecovery = null;
  } else if ((s.unitDispatchCount.get(`${unitType}/${unitId}`) ?? 0) > 1) {
    const diagnostic = deps.getDeepDiagnostic(s.basePath);
    if (diagnostic) {
      const cappedDiag =
        diagnostic.length > MAX_RECOVERY_CHARS
          ? diagnostic.slice(0, MAX_RECOVERY_CHARS) +
            "\n\n[...diagnostic truncated to prevent memory exhaustion]"
          : diagnostic;
      finalPrompt = `**RETRY — your previous attempt did not produce the required artifact.**\n\nDiagnostic from previous attempt:\n${cappedDiag}\n\nFix whatever went wrong and make sure you write the required file this time.\n\n---\n\n${finalPrompt}`;
    }
  }

  // Prompt char measurement
  s.lastPromptCharCount = finalPrompt.length;
  s.lastBaselineCharCount = undefined;
  if (deps.isDbAvailable()) {
    try {
      const { inlineGsdRootFile } = await import("../prompt/auto-prompts.js");
      const [decisionsContent, requirementsContent, projectContent] =
        await Promise.all([
          inlineGsdRootFile(s.basePath, "decisions.md", "Decisions"),
          inlineGsdRootFile(s.basePath, "requirements.md", "Requirements"),
          inlineGsdRootFile(s.basePath, "project.md", "Project"),
        ]);
      s.lastBaselineCharCount =
        (decisionsContent?.length ?? 0) +
        (requirementsContent?.length ?? 0) +
        (projectContent?.length ?? 0);
    } catch (e) {
      logWarning("engine", "Baseline char count measurement failed", { error: String(e) });
    }
  }

  // Cache-optimize prompt section ordering
  try {
    finalPrompt = deps.reorderForCaching(finalPrompt);
  } catch (reorderErr) {
    const msg =
      reorderErr instanceof Error ? reorderErr.message : String(reorderErr);
    logWarning("engine", "Prompt reorder failed", { error: msg });
  }

  // Select and apply model (with tier escalation on retry — normal units only)
  const modelResult = await deps.selectAndApplyModel(
    unitType,
    unitId,
    s.basePath,
    prefs,
    s.verbose,
    s.autoModeStartModel,
    sidecarItem ? undefined : { isRetry, previousTier },
  );
  s.currentUnitRouting =
    modelResult.routing as AutoSession["currentUnitRouting"];

  // Apply sidecar/pre-dispatch hook model override
  const hookModelOverride = sidecarItem?.model ?? iterData.hookModelOverride;
  if (hookModelOverride) {
    // In core, the model override is just a string ID. The adapter handles
    // resolving it against available models and applying it.
    s.currentUnitModel = { provider: "override", id: hookModelOverride };
    deps.events.notify(`Hook model override: ${hookModelOverride}`, "info");
  } else if (modelResult.appliedModelId) {
    // Parse "provider/id" format from the adapter
    const slashIdx = modelResult.appliedModelId.indexOf("/");
    if (slashIdx > 0) {
      s.currentUnitModel = {
        provider: modelResult.appliedModelId.slice(0, slashIdx),
        id: modelResult.appliedModelId.slice(slashIdx + 1),
      };
    } else {
      s.currentUnitModel = { provider: "", id: modelResult.appliedModelId };
    }
  }

  // Store the final dispatched model ID
  s.currentDispatchedModelId = s.currentUnitModel
    ? `${s.currentUnitModel.provider}/${s.currentUnitModel.id}`
    : null;

  // Progress widget + preconditions — deferred to after model selection
  deps.updateProgressWidget(unitType, unitId, state);
  deps.ensurePreconditions(unitType, unitId, s.basePath, state);

  // Start unit supervision
  deps.clearUnitTimeout();
  deps.startUnitSupervision({
    s,
    unitType,
    unitId,
    prefs,
    buildSnapshotOpts: () => deps.buildSnapshotOpts(unitType, unitId),
    buildRecoveryContext: () => ({
      basePath: s.basePath,
      verbose: s.verbose,
      currentUnitStartedAt: s.currentUnit?.startedAt ?? Date.now(),
      unitRecoveryCount: s.unitRecoveryCount,
    }),
    pauseAuto: deps.pauseAuto,
  });

  // Write preliminary lock
  deps.writeLock(
    deps.lockBase(),
    unitType,
    unitId,
  );

  debugLog("autoLoop", {
    phase: "runUnit-start",
    iteration: ic.iteration,
    unitType,
    unitId,
  });

  // ── Dispatch unit through adapter instead of runUnit(ctx, pi, s, ...) ──
  const dispatchResult = await deps.adapter.dispatchUnit({
    unitType,
    unitId,
    prompt: finalPrompt,
    modelId: s.currentUnitModel ? `${s.currentUnitModel.provider}/${s.currentUnitModel.id}` : undefined,
    mcpConfigPath: deps.mcpConfigPath,
    cwd: s.basePath,
  });

  // Map UnitDispatchResult to UnitResult shape
  const unitResult = {
    status: dispatchResult.status,
    errorContext: dispatchResult.errorContext ? {
      message: dispatchResult.errorContext.message,
      category: dispatchResult.errorContext.category,
      stopReason: dispatchResult.errorContext.stopReason,
      isTransient: dispatchResult.errorContext.isTransient,
      retryAfterMs: dispatchResult.errorContext.retryAfterMs,
    } : undefined,
  };

  debugLog("autoLoop", {
    phase: "runUnit-end",
    iteration: ic.iteration,
    unitType,
    unitId,
    status: unitResult.status,
  });

  // Now that the unit has completed, update the session lock with the session file path.
  const sessionFile = deps.getSessionFile();
  deps.updateSessionLock(
    deps.lockBase(),
    unitType,
    unitId,
    sessionFile,
  );
  deps.writeLock(
    deps.lockBase(),
    unitType,
    unitId,
    sessionFile,
  );

  // Tag the most recent window entry with error info for stuck detection
  const lastEntry = loopState.recentUnits[loopState.recentUnits.length - 1];
  if (lastEntry) {
    if (unitResult.errorContext) {
      lastEntry.error = `${unitResult.errorContext.category}:${unitResult.errorContext.message}`.slice(0, 200);
    } else if (unitResult.status === "error" || unitResult.status === "cancelled") {
      lastEntry.error = `${unitResult.status}:${unitType}/${unitId}`;
    }
  }

  if (unitResult.status === "cancelled") {
    if (unitResult.errorContext?.category === "provider") {
      debugLog("autoLoop", { phase: "exit", reason: "provider-pause", isTransient: unitResult.errorContext.isTransient });
      return { action: "break", reason: "provider-pause" };
    }
    if (
      unitResult.errorContext?.isTransient &&
      unitResult.errorContext?.category === "timeout"
    ) {
      deps.events.notify(
        `Session creation timed out for ${unitType} ${unitId}. Will retry.`,
        "warning",
      );
      debugLog("autoLoop", { phase: "session-timeout-pause", unitType, unitId });
      await deps.pauseAuto();
      return { action: "break", reason: "session-timeout" };
    }
    deps.events.notify(
      `Session creation failed for ${unitType} ${unitId}: ${unitResult.errorContext?.message ?? "unknown"}. Stopping auto-mode.`,
      "warning",
    );
    await deps.stopAuto(`Session creation failed: ${unitResult.errorContext?.message ?? "unknown"}`);
    debugLog("autoLoop", { phase: "exit", reason: "session-failed" });
    return { action: "break", reason: "session-failed" };
  }

  // ── Immediate unit closeout ────────
  if (s.currentUnit) {
    await deps.closeoutUnit(
      s.basePath,
      unitType,
      unitId,
      s.currentUnit.startedAt,
      deps.buildSnapshotOpts(unitType, unitId),
    );
  }

  // ── Zero tool-call guard (#1833, #2653) ──────────────────────────
  {
    const currentLedger = deps.getLedger() as { units: Array<{ type: string; id: string; startedAt: number; toolCalls: number }> } | null;
    if (currentLedger?.units) {
      const lastUnit = [...currentLedger.units].reverse().find(
        (u: { type: string; id: string; startedAt: number; toolCalls: number }) => u.type === unitType && u.id === unitId && u.startedAt === s.currentUnit?.startedAt,
      );
      if (lastUnit && lastUnit.toolCalls === 0) {
        debugLog("runUnitPhase", {
          phase: "zero-tool-calls",
          unitType,
          unitId,
          warning: "Unit completed with 0 tool calls — likely context exhaustion, marking as failed",
        });
        deps.events.notify(
          `${unitType} ${unitId} completed with 0 tool calls — context exhaustion, will retry`,
          "warning",
        );
        return { action: "next", data: { unitStartedAt: s.currentUnit?.startedAt } };
      }
    }
  }

  if (s.currentUnitRouting) {
    deps.recordOutcome(
      unitType,
      s.currentUnitRouting.tier as "light" | "standard" | "heavy",
      true,
    );
  }

  const skipArtifactVerification = unitType.startsWith("hook/") || unitType === "custom-step";
  const artifactVerified =
    skipArtifactVerification ||
    verifyExpectedArtifact(unitType, unitId, s.basePath);
  if (artifactVerified) {
    s.unitDispatchCount.delete(`${unitType}/${unitId}`);
    s.unitRecoveryCount.delete(`${unitType}/${unitId}`);
  }

  // Write phase handoff anchor after successful research/planning completion
  const anchorPhases = new Set(["research-milestone", "research-slice", "plan-milestone", "plan-slice"]);
  if (artifactVerified && mid && anchorPhases.has(unitType)) {
    try {
      const { writePhaseAnchor } = await import("../execution/phase-anchor.js");
      writePhaseAnchor(s.basePath, mid, {
        phase: unitType,
        milestoneId: mid,
        generatedAt: new Date().toISOString(),
        intent: `Completed ${unitType} for ${unitId}`,
        decisions: [],
        blockers: [],
        nextSteps: [],
      });
    } catch (err) {
      logWarning("engine", `phase anchor failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "unit-end", data: { unitType, unitId, status: unitResult.status, artifactVerified, ...(unitResult.errorContext ? { errorContext: unitResult.errorContext } : {}) }, causedBy: { flowId: ic.flowId, seq: unitStartSeq } });

  // ── Safety harness: checkpoint cleanup or rollback ──
  if (s.checkpointSha) {
    if (unitResult.status === "error" && safetyConfig.auto_rollback) {
      const rolled = rollbackToCheckpoint(s.basePath, unitId, s.checkpointSha);
      if (rolled) {
        deps.events.notify(`Rolled back to pre-unit checkpoint for ${unitId}`, "info");
        debugLog("runUnitPhase", { phase: "checkpoint-rollback", unitId });
      }
    } else if (unitResult.status === "error") {
      deps.events.notify(
        `Unit ${unitId} failed. Pre-unit checkpoint available at ${s.checkpointSha.slice(0, 8)}`,
        "warning",
      );
    } else {
      cleanupCheckpoint(s.basePath, unitId);
      debugLog("runUnitPhase", { phase: "checkpoint-cleaned", unitId });
    }
    s.checkpointSha = null;
  }

  return { action: "next", data: { unitStartedAt: s.currentUnit?.startedAt } };
}

// ─── runFinalize ──────────────────────────────────────────────────────────────

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
