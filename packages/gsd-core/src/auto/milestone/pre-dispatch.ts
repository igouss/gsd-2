/**
 * milestone/pre-dispatch.ts — Pre-dispatch phase: resource guards, health gate,
 * state derivation, milestone transitions, terminal conditions.
 *
 * This is the "what milestone are we in and should we keep going?" phase.
 */

import type {
  PhaseResult,
  IterationContext,
  LoopState,
  PreDispatchData,
} from "../types.ts";
import { generateMilestoneReport, _resolveReportBasePath } from "./report.ts";
import { closeoutAndStop } from "../closeout.ts";
import { debugLog } from "../../reporting/debug-logger.ts";
import { MergeConflictError } from "../../git/git-service.ts";
import { join, basename } from "node:path";
import { existsSync, cpSync } from "node:fs";
import { logWarning, logError } from "../../workflow/workflow-logger.ts";
import { gsdRoot } from "../../persistence/paths.ts";
import { atomicWriteSync } from "../../persistence/atomic-write.ts";
import { getEligibleSlices } from "../../parallel/slice-parallel-eligibility.ts";
import { startSliceParallel } from "../../parallel/slice-parallel-orchestrator.ts";
import { isDbAvailable, getMilestoneSlices } from "../../persistence/gsd-db.ts";

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
