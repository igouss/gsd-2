/**
 * guards/guards.ts — Pipeline guards: stop directives, budget ceiling,
 * secrets re-check.
 *
 * These are the "should we keep going or bail?" checks that run every iteration.
 */

import type { AutoSession } from "../session.ts";
import type {
  PhaseResult,
  IterationContext,
} from "../types.ts";
import { BUDGET_THRESHOLDS } from "../types.ts";
import { debugLog } from "../../reporting/debug-logger.ts";
import { basename } from "node:path";

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
    const { loadStopCaptures, markCaptureExecuted } = await import("../captures.ts");
    const stopCaptures = loadStopCaptures(s.basePath);
    if (stopCaptures.length > 0) {
      const first = stopCaptures[0]!;
      const isBacktrack = first.classification === "backtrack";
      const label = isBacktrack
        ? `Backtrack directive: ${first.text}`
        : `Stop directive: ${first.text}`;

      deps.events.notify(label, "warning");
      deps.sendDesktopNotification(
        "WTF", label, "warning", "stop-directive",
        basename(s.originalBasePath || s.basePath),
      );

      // Pause first — ensures auto-mode stops even if later steps fail
      await deps.pauseAuto();

      // For backtrack captures, write the backtrack trigger after pausing
      if (isBacktrack) {
        try {
          const { executeBacktrack } = await import("../triage-resolution.ts");
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
    if (process.env.WTF_PARALLEL_WORKER && s.autoStartTime && Array.isArray(costUnits)) {
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
          deps.sendDesktopNotification("WTF", msg, "error", "budget", basename(s.originalBasePath || s.basePath));
          await deps.stopAuto("Budget ceiling reached");
          debugLog("autoLoop", { phase: "exit", reason: "budget-halt" });
          return { action: "break", reason: "budget-halt" };
        }
        if (budgetEnforcementAction === "pause") {
          deps.events.notify(
            `${msg} Pausing auto-mode — /wtf auto to override and continue.`,
            "warning",
          );
          deps.sendDesktopNotification("WTF", msg, "warning", "budget", basename(s.originalBasePath || s.basePath));
          deps.logCmuxEvent(prefs, msg, "warning");
          await deps.pauseAuto();
          debugLog("autoLoop", { phase: "exit", reason: "budget-pause" });
          return { action: "break", reason: "budget-pause" };
        }
        deps.events.notify(`${msg} Continuing (enforcement: warn).`, "warning");
        deps.sendDesktopNotification("WTF", msg, "warning", "budget", basename(s.originalBasePath || s.basePath));
        deps.logCmuxEvent(prefs, msg, "warning");
      } else if (threshold.pct < 100) {
        const msg = `${threshold.label}: ${deps.formatCost(totalCost)} / ${deps.formatCost(budgetCeiling)}`;
        deps.events.notify(msg, threshold.notifyLevel);
        deps.sendDesktopNotification(
          "WTF",
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
