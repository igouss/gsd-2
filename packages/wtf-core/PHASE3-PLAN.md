# Phase 3: Refactor Auto-Loop to Use HarnessAdapter

## Context

Phase 2 extracted ~186 harness-free files into `packages/wtf-core/src/`. The auto-loop
files (`auto/loop.ts`, `auto/phases.ts`, `auto/loop-deps.ts`, `auto/session.ts`, `auto/run-unit.ts`)
are currently **stubs** in wtf-core because they were harness-coupled in the original.

This phase replaces those stubs with real implementations that use `HarnessAdapter`
instead of `ExtensionAPI`/`ExtensionContext`. The loop logic stays the same — we're
only changing how it talks to the harness.

## Branch

Work on branch `feat/wtf-core-extraction`.

## Key Insight

The real loop/phases code uses `ctx` and `pi` for exactly **three categories** of things:

1. **Notifications**: `ctx.ui.notify(msg, level)` — ~40 call sites in phases.ts
2. **Unit execution**: `runUnit(ctx, pi, s, ...)` which calls `pi.sendMessage()` — 1 call site
3. **Model selection**: `pi.setModel()`, `ctx.modelRegistry`, `ctx.model` — in `selectAndApplyModel` and hook model override

All three are already behind `LoopDeps` or can be. The refactoring is mechanical.

## Step-by-Step

### Step 1: Define `CoreLoopDeps` in `packages/wtf-core/src/auto/loop-deps.ts`

Replace the stub with the real interface. Split the original 60+ member `LoopDeps` into:

**`CoreLoopDeps`** — everything that does NOT take `ExtensionContext`/`ExtensionAPI` as params:

```typescript
import type { HarnessAdapter, OrchestratorEventSink } from "../harness-adapter.js";
// ... other wtf-core imports ...

export interface CoreLoopDeps {
  // Adapter for dispatching units
  adapter: HarnessAdapter;
  
  // Event sink replaces ctx.ui.notify
  events: OrchestratorEventSink;

  // --- All the harness-free deps (keep exactly as-is) ---
  lockBase: () => string;
  buildSnapshotOpts: (unitType: string, unitId: string) => CloseoutOptions & Record<string, unknown>;
  clearUnitTimeout: () => void;
  invalidateAllCaches: () => void;
  deriveState: (basePath: string) => Promise<WTFState>;
  rebuildState: (basePath: string) => Promise<void>;
  loadEffectiveWTFPreferences: () => { preferences?: WTFPreferences } | undefined;
  preDispatchHealthGate: (basePath: string) => Promise<{ proceed: boolean; reason?: string; fixesApplied: string[] }>;
  syncProjectRootToWorktree: (originalBase: string, basePath: string, milestoneId: string | null) => void;
  checkResourcesStale: (version: string | null) => string | null;
  validateSessionLock: (basePath: string) => SessionLockStatus;
  updateSessionLock: (basePath: string, unitType: string, unitId: string, sessionFile?: string) => void;
  sendDesktopNotification: (title: string, body: string, kind: string, category: string, projectName?: string) => void;
  setActiveMilestoneId: (basePath: string, mid: string) => void;
  pruneQueueOrder: (basePath: string, pendingIds: string[]) => void;
  isInAutoWorktree: (basePath: string) => boolean;
  shouldUseWorktreeIsolation: () => boolean;
  mergeMilestoneToMain: (basePath: string, milestoneId: string, roadmapContent: string) => { pushed: boolean; codeFilesChanged: boolean };
  teardownAutoWorktree: (basePath: string, milestoneId: string) => void;
  createAutoWorktree: (basePath: string, milestoneId: string) => string;
  captureIntegrationBranch: (basePath: string, mid: string) => void;
  getIsolationMode: () => string;
  getCurrentBranch: (basePath: string) => string;
  autoWorktreeBranch: (milestoneId: string) => string;
  resolveMilestoneFile: (basePath: string, milestoneId: string, fileType: string) => string | null;
  getLedger: () => unknown;
  getProjectTotals: (units: unknown) => { cost: number };
  formatCost: (cost: number) => string;
  getBudgetAlertLevel: (pct: number) => number;
  getNewBudgetAlertLevel: (lastLevel: number, pct: number) => number;
  getBudgetEnforcementAction: (enforcement: string, pct: number) => string;
  getManifestStatus: (basePath: string, mid: string | undefined, projectRoot?: string) => Promise<{ pending: unknown[] } | null>;
  resolveDispatch: (dctx: { basePath: string; mid: string; midTitle: string; state: WTFState; prefs: WTFPreferences | undefined; session?: AutoSession }) => Promise<DispatchAction>;
  runPreDispatchHooks: (unitType: string, unitId: string, prompt: string, basePath: string) => { firedHooks: string[]; action: string; prompt?: string; unitType?: string; model?: string };
  getPriorSliceCompletionBlocker: (basePath: string, mainBranch: string, unitType: string, unitId: string) => string | null;
  getMainBranch: (basePath: string) => string;
  recordOutcome: (unitType: string, tier: string, success: boolean) => void;
  writeLock: (lockBase: string, unitType: string, unitId: string, sessionFile?: string) => void;
  captureAvailableSkills: () => void;
  ensurePreconditions: (unitType: string, unitId: string, basePath: string, state: WTFState) => void;
  updateSliceProgressCache: (basePath: string, mid: string, sliceId?: string) => void;
  getDeepDiagnostic: (basePath: string) => string | null;
  isDbAvailable: () => boolean;
  reorderForCaching: (prompt: string) => string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: string) => string;
  atomicWriteSync: (path: string, content: string) => void;
  GitServiceImpl: new (basePath: string, gitConfig: unknown) => unknown;
  resolver: WorktreeResolver;
  emitJournalEvent: (entry: JournalEntry) => void;

  // --- Deps that currently take ctx/pi but need signature changes ---
  
  // Was: stopAuto(ctx?, pi?, reason?) — remove ctx/pi params
  stopAuto: (reason?: string) => Promise<void>;
  
  // Was: pauseAuto(ctx?, pi?) — remove ctx/pi params
  pauseAuto: () => Promise<void>;
  
  // Was: handleLostSessionLock(ctx?, lockStatus?) — remove ctx
  handleLostSessionLock: (lockStatus?: SessionLockStatus) => void;
  
  // Was: closeoutUnit(ctx, basePath, ...) — remove ctx
  closeoutUnit: (basePath: string, unitType: string, unitId: string, startedAt: number, opts?: CloseoutOptions & Record<string, unknown>) => Promise<void>;
  
  // Was: selectAndApplyModel(ctx, pi, ...) — becomes modelId string return
  selectAndApplyModel: (unitType: string, unitId: string, basePath: string, prefs: WTFPreferences | undefined, verbose: boolean, startModel: { provider: string; id: string } | null, retryContext?: { isRetry: boolean; previousTier?: string }) => Promise<{ routing: { tier: string; modelDowngraded: boolean } | null; appliedModelId: string | null }>;
  
  // Was: startUnitSupervision({s, ctx, pi, ...}) — remove ctx/pi
  startUnitSupervision: (sctx: { s: AutoSession; unitType: string; unitId: string; prefs: WTFPreferences | undefined; buildSnapshotOpts: () => CloseoutOptions & Record<string, unknown>; buildRecoveryContext: () => unknown; pauseAuto: () => Promise<void> }) => void;

  // Was: collectSecretsFromManifest(basePath, mid, ctx) — remove ctx
  collectSecretsFromManifest: (basePath: string, mid: string | undefined) => Promise<{ applied: unknown[]; skipped: unknown[]; existingSkipped: unknown[] } | null>;

  // Was: updateProgressWidget(ctx, ...) — remove ctx
  updateProgressWidget: (unitType: string, unitId: string, state: WTFState) => void;

  // Was: syncCmuxSidebar(prefs, state) — unchanged, already harness-free
  syncCmuxSidebar: (preferences: WTFPreferences | undefined, state: WTFState) => void;
  logCmuxEvent: (preferences: WTFPreferences | undefined, message: string, level?: string) => void;

  // Was: reconcileMergeState(basePath, ctx) — remove ctx
  reconcileMergeState: (basePath: string) => boolean;

  // Was: getSessionFile(ctx) — becomes no-arg (adapter manages sessions)
  getSessionFile: () => string;

  // Was: postUnitPreVerification(pctx, opts) — pctx had ctx/pi
  postUnitPreVerification: (unitType: string, unitId: string, opts?: PreVerificationOpts) => Promise<"dispatched" | "continue" | "retry">;

  // Was: runPostUnitVerification({s, ctx, pi}, pauseAuto) — remove ctx/pi
  runPostUnitVerification: (session: AutoSession) => Promise<VerificationResult>;

  // Was: postUnitPostVerification(pctx) — pctx had ctx/pi
  postUnitPostVerification: (unitType: string, unitId: string) => Promise<"continue" | "step-wizard" | "stopped">;
}
```

**Key change pattern**: Every dep that takes `ctx: ExtensionContext` or `pi: ExtensionAPI` gets those params removed. The adapter layer (pi-mono or standalone) captures `ctx`/`pi` in closures when constructing `CoreLoopDeps`.

### Step 2: Update `AutoSession` in `packages/wtf-core/src/auto/session.ts`

The current stub is already harness-free. Add the missing fields that the real loop uses but the stub doesn't have:

```typescript
// Add these fields (from the real auto/session.ts in the extension):
currentMilestoneId: string | null = null;
currentUnitRouting: UnitRouting | null = null;
currentUnitModel: { provider: string; id: string } | null = null;
autoModeStartModel: { provider: string; id: string } | null = null;
resourceVersionOnStart: string | null = null;
lastPromptCharCount: number | undefined;
lastBaselineCharCount: number | undefined;
pendingCrashRecovery: string | null = null;
lastToolInvocationError: string | null = null;
checkpointSha: string | null = null;
currentDispatchedModelId: string | null = null;
milestoneMergedInPhases = false;
```

Do NOT add `cmdCtx: ExtensionCommandContext` — that stays in the pi-mono adapter layer.

### Step 3: Update `IterationContext` in `packages/wtf-core/src/auto/types.ts`

Change:
```typescript
// FROM (harness-coupled):
export interface IterationContext {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  s: AutoSession;
  deps: LoopDeps;
  prefs: WTFPreferences | undefined;
  iteration: number;
  flowId: string;
  nextSeq: () => number;
}

// TO (harness-free):
export interface IterationContext {
  s: AutoSession;
  deps: CoreLoopDeps;
  prefs: WTFPreferences | undefined;
  iteration: number;
  flowId: string;
  nextSeq: () => number;
}
```

Remove `ctx` and `pi` from the interface. They're no longer needed — notifications
go through `deps.events`, unit execution through `deps.adapter`, model selection
through `deps.selectAndApplyModel`.

### Step 4: Rewrite `auto/loop.ts`

Copy the real loop from `src/resources/extensions/wtf/auto/loop.ts` (330 lines) into
`packages/wtf-core/src/auto/loop.ts`. Make these changes:

1. **Remove harness imports**:
   ```typescript
   // DELETE this line:
   import type { ExtensionAPI, ExtensionContext } from "@wtf/pi-coding-agent";
   ```

2. **Change function signature**:
   ```typescript
   // FROM:
   export async function autoLoop(
     ctx: ExtensionContext, pi: ExtensionAPI, s: AutoSession, deps: LoopDeps
   ): Promise<void>

   // TO:
   export async function autoLoop(
     s: AutoSession, deps: CoreLoopDeps
   ): Promise<void>
   ```

3. **Remove `s.cmdCtx` check** (line 76-79) — adapter manages sessions, not the loop.

4. **Build `IterationContext` without ctx/pi**:
   ```typescript
   // FROM:
   const ic: IterationContext = { ctx, pi, s, deps, prefs, iteration, flowId, nextSeq };
   
   // TO:
   const ic: IterationContext = { s, deps, prefs, iteration, flowId, nextSeq };
   ```

5. **Replace `ctx.ui.notify()` with `deps.events.notify()`**:
   ```typescript
   // FROM:
   ctx.ui.notify("Auto-mode stopped: infrastructure error...", "error");
   
   // TO:
   deps.events.notify("Auto-mode stopped: infrastructure error...", "error");
   ```

6. **Remove ctx/pi from `deps.stopAuto()` and `deps.pauseAuto()` calls**:
   ```typescript
   // FROM:
   await deps.stopAuto(ctx, pi, "Safety: loop exceeded...");
   
   // TO:
   await deps.stopAuto("Safety: loop exceeded...");
   ```

7. **Replace `deps.handleLostSessionLock(ctx, lockStatus)` → `deps.handleLostSessionLock(lockStatus)`**

8. **Replace `deps.updateProgressWidget(ctx, ...)` → `deps.updateProgressWidget(...)`** (remove ctx param)

### Step 5: Rewrite `auto/phases.ts`

This is the biggest file (~1640 lines). Copy from the real extension file and apply the same pattern:

1. **Remove harness imports** — delete `import { importExtensionModule, type ExtensionAPI, type ExtensionContext } from "@wtf/pi-coding-agent"`

2. **Replace all `ctx.ui.notify(msg, level)` → `deps.events.notify(msg, level)`** (~40 call sites)

3. **Replace all `deps.stopAuto(ctx, pi, reason)` → `deps.stopAuto(reason)`** (~15 call sites)

4. **Replace all `deps.pauseAuto(ctx, pi)` → `deps.pauseAuto()`** (~5 call sites)

5. **Replace `deps.closeoutUnit(ctx, basePath, ...)` → `deps.closeoutUnit(basePath, ...)`** (~5 call sites)

6. **Replace `deps.updateProgressWidget(ctx, ...)` → `deps.updateProgressWidget(...)`** (~3 call sites)

7. **Replace `deps.resolver.mergeAndExit(mid, ctx.ui)` → `deps.resolver.mergeAndExit(mid, deps.events)`** (~3 call sites)
   - This means the `WorktreeResolver` interface needs to accept `OrchestratorEventSink` instead of `ctx.ui`. Check `packages/wtf-core/src/worktree-resolver.ts` — if it uses `ctx.ui.notify()`, change to accept `OrchestratorEventSink`.

8. **Replace `deps.reconcileMergeState(basePath, ctx)` → `deps.reconcileMergeState(basePath)`**

9. **Replace `deps.collectSecretsFromManifest(basePath, mid, ctx)` → `deps.collectSecretsFromManifest(basePath, mid)`**

10. **In `runUnitPhase`**, replace the `runUnit(ctx, pi, s, ...)` call with adapter dispatch:
    ```typescript
    // FROM:
    const unitResult = await runUnit(ctx, pi, s, unitType, unitId, finalPrompt);
    
    // TO:
    const unitResult = await deps.adapter.dispatchUnit({
      unitType,
      unitId,
      prompt: finalPrompt,
      modelId: s.currentUnitModel ? `${s.currentUnitModel.provider}/${s.currentUnitModel.id}` : undefined,
      mcpConfigPath: deps.mcpConfigPath,  // add to CoreLoopDeps
      cwd: s.basePath,
    });
    ```
    Note: `UnitDispatchResult` maps directly to `UnitResult`. The `event` field from the old `UnitResult` is pi-mono-specific (agent_end event messages). In the core, we only need `status` and `errorContext`. Update the `UnitResult` type if needed, or use `UnitDispatchResult` directly.

11. **In `runUnitPhase`**, the `selectAndApplyModel` call:
    ```typescript
    // FROM:
    const modelResult = await deps.selectAndApplyModel(ctx, pi, unitType, ...);
    
    // TO:
    const modelResult = await deps.selectAndApplyModel(unitType, ...);
    ```

12. **In `runUnitPhase`**, the hook model override section uses `ctx.modelRegistry.getAvailable()` and `pi.setModel(match)`. Replace with:
    ```typescript
    // The model override is now just a modelId string. The adapter handles applying it.
    // Store it on the session for the adapter to pick up:
    if (hookModelOverride) {
      s.currentUnitModel = { provider: "override", id: hookModelOverride };
      deps.events.notify(`Hook model override: ${hookModelOverride}`, "info");
    }
    ```

13. **In `runUnitPhase`**, the `ctx.ui.setStatus("wtf-auto", "auto")` call — replace with `deps.events.progress(...)` or remove (it's a pi-mono TUI widget concern).

14. **In `runUnitPhase`**, `deps.startUnitSupervision({s, ctx, pi, ...})` — remove ctx/pi from the call.

15. **In `runUnitPhase`**, `deps.getSessionFile(ctx)` → `deps.getSessionFile()`.

16. **In `runFinalize`**, the `PostUnitContext` construction uses `ctx` and `pi`. Since we changed the dep signatures to not take ctx/pi, the PostUnitContext type needs updating or removal. Replace with direct dep calls:
    ```typescript
    // FROM:
    const postUnitCtx: PostUnitContext = { s, ctx, pi, buildSnapshotOpts: deps.buildSnapshotOpts, ... };
    deps.postUnitPreVerification(postUnitCtx, preVerificationOpts);
    
    // TO:
    deps.postUnitPreVerification(iterData.unitType, iterData.unitId, preVerificationOpts);
    ```

17. **In `runFinalize`**, `deps.runPostUnitVerification({s, ctx, pi}, deps.pauseAuto)` → `deps.runPostUnitVerification(s)`

18. **The `importExtensionModule` calls** in `generateMilestoneReport` and `runUnitPhase`. These are pi-mono-specific dynamic imports. Replace with regular imports since the modules are already in wtf-core:
    ```typescript
    // FROM:
    const { loadVisualizerData } = await importExtensionModule<...>(import.meta.url, "../visualizer-data.js");
    
    // TO:
    const { loadVisualizerData } = await import("../visualizer-data.js");
    ```

### Step 6: Remove `auto/run-unit.ts` from wtf-core

Delete `packages/wtf-core/src/auto/run-unit.ts` — unit execution is now handled by
`HarnessAdapter.dispatchUnit()`. The file is no longer needed in wtf-core.
(The real `run-unit.ts` stays in the extension directory for the future pi-mono adapter.)

### Step 7: Add `mcpConfigPath` to `CoreLoopDeps`

The loop needs to pass the MCP config path in each `UnitDispatchRequest`. Add:
```typescript
mcpConfigPath: string;
```
to `CoreLoopDeps`.

### Step 8: Update `WorktreeResolver` if needed

Check `packages/wtf-core/src/worktree-resolver.ts`. If `mergeAndExit` and
`enterMilestone` take a `ctx.ui`-shaped parameter, change them to accept
`OrchestratorEventSink` instead (or a simpler `{ notify: (msg, level) => void }` interface).

### Step 9: Verify

```bash
# 1. No harness imports in wtf-core
grep -r "@wtf/pi-coding-agent\|@wtf/pi-tui\|@wtf/pi-ai" packages/wtf-core/src/ --include="*.ts" -l

# 2. Compiles
cd packages/wtf-core && npx tsc --noEmit

# 3. No references to ExtensionAPI, ExtensionContext, ExtensionCommandContext in wtf-core
grep -r "ExtensionAPI\|ExtensionContext\|ExtensionCommandContext" packages/wtf-core/src/ --include="*.ts"
```

All three must return zero results (except comments explaining the migration).

## DO NOT

- Do NOT modify files in `src/resources/extensions/wtf/` — the original stays as-is
- Do NOT change any logic — the loop behavior must be identical
- Do NOT add `@wtf/pi-*` imports to wtf-core
- Do NOT worry about the pi-mono adapter wiring yet — that's deferred
- Do NOT change `auto-post-unit.ts`, `auto-verification.ts`, `auto-timeout-recovery.ts` in the extension dir — those stay coupled for now. Their functionality flows through `CoreLoopDeps` callbacks.

## Summary of changes

| File | Action |
|------|--------|
| `wtf-core/src/auto/loop-deps.ts` | Replace stub with full `CoreLoopDeps` interface |
| `wtf-core/src/auto/session.ts` | Add missing session fields |
| `wtf-core/src/auto/types.ts` | Remove ctx/pi from `IterationContext` |
| `wtf-core/src/auto/loop.ts` | Replace stub with real loop, adapted for CoreLoopDeps |
| `wtf-core/src/auto/phases.ts` | Create new file — real phases adapted for CoreLoopDeps |
| `wtf-core/src/auto/run-unit.ts` | Delete (replaced by adapter.dispatchUnit) |
| `wtf-core/src/harness-adapter.ts` | No changes (already defined in Phase 1) |
| `wtf-core/src/worktree-resolver.ts` | Possibly update to accept OrchestratorEventSink |

## How to prompt the other session

```
Read packages/wtf-core/PHASE3-PLAN.md and execute it.
You're on branch feat/wtf-core-extraction.
The real loop/phases code is at src/resources/extensions/wtf/auto/loop.ts and 
src/resources/extensions/wtf/auto/phases.ts — use those as source material.
Do not commit — just get it compiling with npx tsc --noEmit in packages/wtf-core/.
```
