/**
 * auto/session.ts — Core AutoSession for wtf-core.
 *
 * Contains all mutable auto-mode state that the core loop needs.
 * Does NOT reference ExtensionCommandContext, ExtensionContext, or pi-ai
 * Model types — the adapter layer owns those.
 *
 * The real extension AutoSession extends or wraps this with
 * harness-specific fields (cmdCtx, currentUnitModel as Model<Api>, etc.).
 */

import type { GitServiceImpl } from "../git/git-service.ts";
import type { CaptureEntry } from "./captures.ts";
import type { BudgetAlertLevel } from "./auto-budget.ts";

// ─── Exported Types ──────────────────────────────────────────────────────────

export interface CurrentUnit {
  type: string;
  id: string;
  startedAt: number;
}

export interface UnitRouting {
  tier: string;
  modelDowngraded: boolean;
}

export interface StartModel {
  provider: string;
  id: string;
}

export interface PendingVerificationRetry {
  unitId: string;
  failureContext: string;
  attempt: number;
}

/**
 * A typed item enqueued by postUnitPostVerification for the main loop to
 * drain via the standard runUnit path.
 */
export interface SidecarItem {
  kind: "hook" | "triage" | "quick-task";
  unitType: string;
  unitId: string;
  prompt: string;
  /** Model override for hook units (e.g. "anthropic/claude-3-5-sonnet"). */
  model?: string;
  /** Capture ID for quick-task items (already marked executed at enqueue time). */
  captureId?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const MAX_UNIT_DISPATCHES = 3;
export const STUB_RECOVERY_THRESHOLD = 2;
export const MAX_LIFETIME_DISPATCHES = 6;
export const NEW_SESSION_TIMEOUT_MS = 30_000;

// ─── AutoSession ─────────────────────────────────────────────────────────────

export class AutoSession {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  active = false;
  paused = false;
  stepMode = false;
  verbose = false;
  activeEngineId: string | null = null;
  activeRunDir: string | null = null;

  // ── Paths ────────────────────────────────────────────────────────────────
  basePath = "";
  originalBasePath = "";
  gitService: GitServiceImpl | null = null;

  // ── Dispatch counters ────────────────────────────────────────────────────
  readonly unitDispatchCount: Map<string, number> = new Map<string, number>();
  readonly unitLifetimeDispatches: Map<string, number> = new Map<string, number>();
  readonly unitRecoveryCount: Map<string, number> = new Map<string, number>();

  // ── Timers ───────────────────────────────────────────────────────────────
  unitTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  wrapupWarningHandle: ReturnType<typeof setTimeout> | null = null;
  idleWatchdogHandle: ReturnType<typeof setInterval> | null = null;
  continueHereHandle: ReturnType<typeof setInterval> | null = null;

  // ── Current unit ─────────────────────────────────────────────────────────
  currentUnit: CurrentUnit | null = null;
  currentUnitRouting: UnitRouting | null = null;
  currentMilestoneId: string | null = null;

  // ── Model state (harness-free — provider/id strings only) ───────────────
  autoModeStartModel: StartModel | null = null;
  /** Model applied to the current unit. In wtf-core this is { provider, id }. */
  currentUnitModel: { provider: string; id: string } | null = null;
  /** Fully-qualified model ID (provider/id) set after selectAndApplyModel + hook overrides. */
  currentDispatchedModelId: string | null = null;
  originalModelId: string | null = null;
  originalModelProvider: string | null = null;
  lastBudgetAlertLevel: BudgetAlertLevel = 0;

  // ── Recovery ─────────────────────────────────────────────────────────────
  pendingCrashRecovery: string | null = null;
  pendingVerificationRetry: PendingVerificationRetry | null = null;
  readonly verificationRetryCount: Map<string, number> = new Map<string, number>();
  pausedSessionFile: string | null = null;
  resourceVersionOnStart: string | null = null;
  lastStateRebuildAt = 0;

  // ── Sidecar queue ─────────────────────────────────────────────────────
  sidecarQueue: SidecarItem[] = [];

  // ── Tool invocation errors ──────────────────────────────────────────
  lastToolInvocationError: string | null = null;

  // ── Isolation degradation ────────────────────────────────────────────
  isolationDegraded = false;

  // ── Merge guard ──────────────────────────────────────────────────────
  milestoneMergedInPhases = false;

  // ── Dispatch circuit breakers ──────────────────────────────────────
  rewriteAttemptCount = 0;
  consecutiveCompleteBootstraps = 0;

  // ── Metrics ──────────────────────────────────────────────────────────────
  autoStartTime = 0;
  lastPromptCharCount: number | undefined;
  lastBaselineCharCount: number | undefined;
  pendingQuickTasks: CaptureEntry[] = [];

  // ── Safety harness ───────────────────────────────────────────────────────
  checkpointSha: string | null = null;

  // ── Captures (legacy compat) ────────────────────────────────────────────
  captures: CaptureEntry[] = [];
  staleResourceVersion: string | null = null;
  lastDispatchedUnitType: string | null = null;
  lastDispatchedUnitId: string | null = null;
  consecutiveErrorCount = 0;

  // ── Methods ──────────────────────────────────────────────────────────────

  clearTimers(): void {
    if (this.unitTimeoutHandle) { clearTimeout(this.unitTimeoutHandle); this.unitTimeoutHandle = null; }
    if (this.wrapupWarningHandle) { clearTimeout(this.wrapupWarningHandle); this.wrapupWarningHandle = null; }
    if (this.idleWatchdogHandle) { clearInterval(this.idleWatchdogHandle); this.idleWatchdogHandle = null; }
    if (this.continueHereHandle) { clearInterval(this.continueHereHandle); this.continueHereHandle = null; }
  }

  resetDispatchCounters(): void {
    this.unitDispatchCount.clear();
    this.unitLifetimeDispatches.clear();
  }

  get lockBasePath(): string {
    return this.originalBasePath || this.basePath;
  }

  reset(): void {
    this.clearTimers();

    // Lifecycle
    this.active = false;
    this.paused = false;
    this.stepMode = false;
    this.verbose = false;
    this.activeEngineId = null;
    this.activeRunDir = null;

    // Paths
    this.basePath = "";
    this.originalBasePath = "";
    this.gitService = null;

    // Dispatch
    this.unitDispatchCount.clear();
    this.unitLifetimeDispatches.clear();
    this.unitRecoveryCount.clear();

    // Unit
    this.currentUnit = null;
    this.currentUnitRouting = null;
    this.currentMilestoneId = null;

    // Model
    this.autoModeStartModel = null;
    this.currentUnitModel = null;
    this.currentDispatchedModelId = null;
    this.originalModelId = null;
    this.originalModelProvider = null;
    this.lastBudgetAlertLevel = 0;

    // Recovery
    this.pendingCrashRecovery = null;
    this.pendingVerificationRetry = null;
    this.verificationRetryCount.clear();
    this.pausedSessionFile = null;
    this.resourceVersionOnStart = null;
    this.lastStateRebuildAt = 0;

    // Metrics
    this.autoStartTime = 0;
    this.lastPromptCharCount = undefined;
    this.lastBaselineCharCount = undefined;
    this.pendingQuickTasks = [];
    this.sidecarQueue = [];
    this.rewriteAttemptCount = 0;
    this.consecutiveCompleteBootstraps = 0;
    this.lastToolInvocationError = null;
    this.isolationDegraded = false;
    this.milestoneMergedInPhases = false;
    this.checkpointSha = null;

    // Legacy
    this.captures = [];
    this.consecutiveErrorCount = 0;
  }

  toJSON(): Record<string, unknown> {
    return {
      active: this.active,
      paused: this.paused,
      stepMode: this.stepMode,
      basePath: this.basePath,
      activeEngineId: this.activeEngineId,
      activeRunDir: this.activeRunDir,
      currentMilestoneId: this.currentMilestoneId,
      currentUnit: this.currentUnit,
      unitDispatchCount: Object.fromEntries(this.unitDispatchCount),
    };
  }
}
