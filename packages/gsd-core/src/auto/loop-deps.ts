/**
 * auto/loop-deps.ts — CoreLoopDeps interface for dependency injection into autoLoop.
 *
 * Leaf node in the import DAG (type-only). All harness-specific parameters
 * (ExtensionContext, ExtensionAPI) have been removed — the adapter layer
 * captures those in closures when constructing CoreLoopDeps.
 */

import type { HarnessAdapter, OrchestratorEventSink } from "../adapters/harness-adapter.ts";
import type { AutoSession } from "./session.ts";
import type { GSDPreferences } from "../preferences/preferences-types.ts";
import type { GSDState } from "../domain/types.ts";
import type { SessionLockStatus } from "../session/session-lock.ts";
import type { DispatchAction } from "./auto-dispatch.ts";
import type { WorktreeResolver } from "../git/worktree-resolver.ts";
import type { CmuxLogLevel } from "../cmux/index.ts";
import type { JournalEntry } from "../persistence/journal.ts";

// ─── Types needed by CoreLoopDeps (originally in harness-coupled modules) ───

/** Options for unit closeout (metrics snapshot). Originally in auto-unit-closeout.ts. */
export interface CloseoutOptions {
  promptCharCount?: number;
  baselineCharCount?: number;
  tier?: string;
  modelDowngraded?: boolean;
  continueHereFired?: boolean;
}

/** Options for pre-verification processing. Originally in auto-post-unit.ts. */
export interface PreVerificationOpts {
  skipSettleDelay?: boolean;
  skipWorktreeSync?: boolean;
}

/** Result of post-unit verification gate. Originally in auto-verification.ts. */
export type AutoVerificationResult = "continue" | "retry" | "pause";

/**
 * Dependencies injected by the caller so autoLoop can access functions
 * without importing harness-specific modules. All deps that previously
 * took ExtensionContext/ExtensionAPI have those params removed — the
 * adapter layer captures ctx/pi in closures.
 */
export interface CoreLoopDeps {
  // ── Adapter for dispatching units ──
  adapter: HarnessAdapter;

  // ── Event sink replaces ctx.ui.notify ──
  events: OrchestratorEventSink;

  // ── MCP config path for unit dispatch requests ──
  mcpConfigPath: string;

  // ── Session / lock ──
  lockBase: () => string;
  buildSnapshotOpts: (
    unitType: string,
    unitId: string,
  ) => CloseoutOptions & Record<string, unknown>;

  // ── Lifecycle control (ctx/pi params removed) ──
  stopAuto: (reason?: string) => Promise<void>;
  pauseAuto: () => Promise<void>;

  clearUnitTimeout: () => void;

  // ── Progress / UI (ctx param removed) ──
  updateProgressWidget: (
    unitType: string,
    unitId: string,
    state: GSDState,
  ) => void;
  syncCmuxSidebar: (preferences: GSDPreferences | undefined, state: GSDState) => void;
  logCmuxEvent: (
    preferences: GSDPreferences | undefined,
    message: string,
    level?: CmuxLogLevel,
  ) => void;

  // ── State and cache functions ──
  invalidateAllCaches: () => void;
  deriveState: (basePath: string) => Promise<GSDState>;
  rebuildState: (basePath: string) => Promise<void>;
  loadEffectiveGSDPreferences: () =>
    | { preferences?: GSDPreferences }
    | undefined;

  // ── Pre-dispatch health gate ──
  preDispatchHealthGate: (
    basePath: string,
  ) => Promise<{ proceed: boolean; reason?: string; fixesApplied: string[] }>;

  // ── Worktree sync ──
  syncProjectRootToWorktree: (
    originalBase: string,
    basePath: string,
    milestoneId: string | null,
  ) => void;

  // ── Resource version guard ──
  checkResourcesStale: (version: string | null) => string | null;

  // ── Session lock ──
  validateSessionLock: (basePath: string) => SessionLockStatus;
  updateSessionLock: (
    basePath: string,
    unitType: string,
    unitId: string,
    sessionFile?: string,
  ) => void;
  handleLostSessionLock: (lockStatus?: SessionLockStatus) => void;

  // ── Milestone transition functions ──
  sendDesktopNotification: (
    title: string,
    body: string,
    kind: string,
    category: string,
    projectName?: string,
  ) => void;
  setActiveMilestoneId: (basePath: string, mid: string) => void;
  pruneQueueOrder: (basePath: string, pendingIds: string[]) => void;
  isInAutoWorktree: (basePath: string) => boolean;
  shouldUseWorktreeIsolation: () => boolean;
  mergeMilestoneToMain: (
    basePath: string,
    milestoneId: string,
    roadmapContent: string,
  ) => { pushed: boolean; codeFilesChanged: boolean };
  teardownAutoWorktree: (basePath: string, milestoneId: string) => void;
  createAutoWorktree: (basePath: string, milestoneId: string) => string;
  captureIntegrationBranch: (
    basePath: string,
    mid: string,
  ) => void;
  getIsolationMode: () => string;
  getCurrentBranch: (basePath: string) => string;
  autoWorktreeBranch: (milestoneId: string) => string;
  resolveMilestoneFile: (
    basePath: string,
    milestoneId: string,
    fileType: string,
  ) => string | null;

  // ── Merge state reconciliation (ctx param removed) ──
  reconcileMergeState: (basePath: string) => boolean;

  // ── Budget/context/secrets ──
  getLedger: () => unknown;
  getProjectTotals: (units: unknown) => { cost: number };
  formatCost: (cost: number) => string;
  getBudgetAlertLevel: (pct: number) => number;
  getNewBudgetAlertLevel: (lastLevel: number, pct: number) => number;
  getBudgetEnforcementAction: (enforcement: string, pct: number) => string;
  getManifestStatus: (
    basePath: string,
    mid: string | undefined,
    projectRoot?: string,
  ) => Promise<{ pending: unknown[] } | null>;

  // ── Secrets collection (ctx param removed) ──
  collectSecretsFromManifest: (
    basePath: string,
    mid: string | undefined,
  ) => Promise<{
    applied: unknown[];
    skipped: unknown[];
    existingSkipped: unknown[];
  } | null>;

  // ── Dispatch ──
  resolveDispatch: (dctx: {
    basePath: string;
    mid: string;
    midTitle: string;
    state: GSDState;
    prefs: GSDPreferences | undefined;
    session?: AutoSession;
  }) => Promise<DispatchAction>;
  runPreDispatchHooks: (
    unitType: string,
    unitId: string,
    prompt: string,
    basePath: string,
  ) => {
    firedHooks: string[];
    action: string;
    prompt?: string;
    unitType?: string;
    model?: string;
  };
  getPriorSliceCompletionBlocker: (
    basePath: string,
    mainBranch: string,
    unitType: string,
    unitId: string,
  ) => string | null;
  getMainBranch: (basePath: string) => string;

  // ── Unit closeout + runtime records (ctx param removed) ──
  closeoutUnit: (
    basePath: string,
    unitType: string,
    unitId: string,
    startedAt: number,
    opts?: CloseoutOptions & Record<string, unknown>,
  ) => Promise<void>;
  recordOutcome: (unitType: string, tier: string, success: boolean) => void;
  writeLock: (
    lockBase: string,
    unitType: string,
    unitId: string,
    sessionFile?: string,
  ) => void;
  captureAvailableSkills: () => void;
  ensurePreconditions: (
    unitType: string,
    unitId: string,
    basePath: string,
    state: GSDState,
  ) => void;
  updateSliceProgressCache: (
    basePath: string,
    mid: string,
    sliceId?: string,
  ) => void;

  // ── Model selection (ctx/pi params removed, returns modelId string) ──
  selectAndApplyModel: (
    unitType: string,
    unitId: string,
    basePath: string,
    prefs: GSDPreferences | undefined,
    verbose: boolean,
    startModel: { provider: string; id: string } | null,
    retryContext?: { isRetry: boolean; previousTier?: string },
  ) => Promise<{
    routing: { tier: string; modelDowngraded: boolean } | null;
    appliedModelId: string | null;
  }>;

  // ── Unit supervision (ctx/pi params removed) ──
  startUnitSupervision: (sctx: {
    s: AutoSession;
    unitType: string;
    unitId: string;
    prefs: GSDPreferences | undefined;
    buildSnapshotOpts: () => CloseoutOptions & Record<string, unknown>;
    buildRecoveryContext: () => unknown;
    pauseAuto: () => Promise<void>;
  }) => void;

  // ── Prompt helpers ──
  getDeepDiagnostic: (basePath: string) => string | null;
  isDbAvailable: () => boolean;
  reorderForCaching: (prompt: string) => string;

  // ── Filesystem ──
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: string) => string;
  atomicWriteSync: (path: string, content: string) => void;

  // ── Git ──
  GitServiceImpl: new (basePath: string, gitConfig: unknown) => unknown;

  // ── WorktreeResolver ──
  resolver: WorktreeResolver;

  // ── Post-unit processing (ctx/pi params removed) ──
  postUnitPreVerification: (
    unitType: string,
    unitId: string,
    opts?: PreVerificationOpts,
  ) => Promise<"dispatched" | "continue" | "retry">;
  runPostUnitVerification: (
    session: AutoSession,
  ) => Promise<AutoVerificationResult>;
  postUnitPostVerification: (
    unitType: string,
    unitId: string,
  ) => Promise<"continue" | "step-wizard" | "stopped">;

  // ── Session manager (ctx param removed) ──
  getSessionFile: () => string;

  // ── Journal ──
  emitJournalEvent: (entry: JournalEntry) => void;
}
