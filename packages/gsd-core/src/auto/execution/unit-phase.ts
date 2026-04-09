/**
 * execution/unit-phase.ts — Unit execution: dispatch prompt to adapter,
 * await result, closeout, artifact verification, safety harness.
 *
 * This is the "actually run the work" phase.
 */

import type { AutoSession, SidecarItem } from "../session.js";
import type { CoreLoopDeps } from "../loop-deps.js";
import type {
  PhaseResult,
  IterationContext,
  LoopState,
  IterationData,
} from "../types.js";
import { MAX_RECOVERY_CHARS } from "../types.js";
import { debugLog } from "../../debug-logger.js";
import { PROJECT_FILES } from "../../detection.js";
import { join, basename, dirname, parse as parsePath } from "node:path";
import { readdirSync } from "node:fs";
import { logWarning } from "../../workflow/workflow-logger.js";
import { verifyExpectedArtifact } from "../auto-recovery.js";
import { writeUnitRuntimeRecord } from "../../state/unit-runtime.js";
import { createCheckpoint, cleanupCheckpoint, rollbackToCheckpoint, resolveSafetyHarnessConfig } from "../../safety/safety-harness.js";

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

  // ── Safety harness: create checkpoint ──
  const safetyConfig = resolveSafetyHarnessConfig(
    prefs?.safety_harness as Record<string, unknown> | undefined,
  );
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
      const { inlineGsdRootFile } = await import("../../prompt/auto-prompts.js");
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
      const { writePhaseAnchor } = await import("../../execution/phase-anchor.js");
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
