/**
 * minimal-loop.ts — Bare-bones GSD dispatch loop.
 *
 * deriveState → resolveDispatch → buildPrompt → adapter.dispatchUnit → repeat
 *
 * No worktrees, no supervision, no budget tracking, no stuck detection,
 * no verification gates. Just the core dispatch cycle. Features get added
 * back incrementally.
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import type {
  HarnessAdapter,
  OrchestratorEventSink,
  UnitDispatchResult,
} from "@gsd-build/gsd-core";

import { GSD_SYSTEM_PROMPT } from "./system-prompt.js";

// All imports below are from gsd-core's internal modules.
// Since gsd-core only re-exports a subset from index.ts, we import
// from the built dist/ paths directly.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MinimalLoopOptions {
  adapter: HarnessAdapter;
  events: OrchestratorEventSink;
  projectDir: string;
  mcpConfigPath: string;
  maxIterations?: number;
}

// ---------------------------------------------------------------------------
// Dynamic imports — load gsd-core internals at runtime
// ---------------------------------------------------------------------------

interface CoreModules {
  deriveState: (basePath: string) => Promise<any>;
  invalidateStateCache: () => void;
  resolveDispatch: (ctx: any) => Promise<any>;
  openDatabase: (path: string) => boolean;
  closeDatabase: () => void;
  isDbAvailable: () => boolean;
  loadEffectiveGSDPreferences: () => any;
  acquireSessionLock: (basePath: string) => any;
  releaseSessionLock: (basePath: string) => void;
}

async function loadCoreModules(): Promise<CoreModules> {
  const [stateMod, dispatchMod, dbMod, prefsMod, lockMod] = await Promise.all([
    import("@gsd-build/gsd-core/dist/state.js"),
    import("@gsd-build/gsd-core/dist/auto-dispatch.js"),
    import("@gsd-build/gsd-core/dist/gsd-db.js"),
    import("@gsd-build/gsd-core/dist/preferences.js"),
    import("@gsd-build/gsd-core/dist/session-lock.js"),
  ]);

  return {
    deriveState: stateMod.deriveState,
    invalidateStateCache: stateMod.invalidateStateCache,
    resolveDispatch: dispatchMod.resolveDispatch,
    openDatabase: dbMod.openDatabase,
    closeDatabase: dbMod.closeDatabase,
    isDbAvailable: dbMod.isDbAvailable,
    loadEffectiveGSDPreferences: prefsMod.loadEffectiveGSDPreferences,
    acquireSessionLock: lockMod.acquireSessionLock,
    releaseSessionLock: lockMod.releaseSessionLock,
  };
}

// ---------------------------------------------------------------------------
// Minimal loop
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 200;

export async function minimalLoop(opts: MinimalLoopOptions): Promise<void> {
  const { adapter, events, projectDir, mcpConfigPath } = opts;
  const maxIter = opts.maxIterations ?? MAX_ITERATIONS;

  const core = await loadCoreModules();

  // Open DB (creates + initializes schema if it doesn't exist)
  const dbPath = join(projectDir, ".gsd", "gsd.db");
  const opened = core.openDatabase(dbPath);
  if (!opened) {
    events.notify("Failed to open .gsd/gsd.db — continuing without DB (state may not advance)", "warning");
  } else {
    events.notify("Database opened", "info");
  }

  // Acquire session lock
  const lockResult = core.acquireSessionLock(projectDir);
  if (!lockResult.acquired) {
    events.notify(`Session lock held by another process: ${lockResult.reason ?? "unknown"}`, "error");
    return;
  }
  events.notify("Session lock acquired", "info");

  let iteration = 0;
  let running = true;

  // Graceful shutdown
  const stop = () => { running = false; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  try {
    while (running && iteration < maxIter) {
      iteration++;
      core.invalidateStateCache();

      // 1. Derive state
      const state = await core.deriveState(projectDir);
      const mid = state.activeMilestone?.id;
      const midTitle = state.activeMilestone?.title ?? mid;

      if (!mid) {
        if (state.phase === "complete" || state.registry?.every((m: any) => m.status === "complete")) {
          events.notify("All milestones complete", "success");
        } else {
          events.notify(`No active milestone (phase: ${state.phase})`, "error");
        }
        break;
      }

      events.progress({ unitType: "derive", unitId: mid, phase: "state-derived", iteration });

      // 2. Resolve dispatch
      const prefs = core.loadEffectiveGSDPreferences()?.preferences;
      const dispatch = await core.resolveDispatch({
        basePath: projectDir,
        mid,
        midTitle,
        state,
        prefs,
      });

      if (dispatch.action === "stop") {
        events.notify(`Dispatch stopped: ${dispatch.reason}`, dispatch.level ?? "info");
        break;
      }

      if (dispatch.action === "skip") {
        continue;
      }

      // dispatch.action === "dispatch"
      const { unitType, unitId, prompt } = dispatch;
      events.progress({ unitType, unitId, phase: "dispatching", iteration });
      events.notify(`[${iteration}] ${unitType} ${unitId}`, "info");

      // 3. Inject system context into prompt
      const systemContext = buildSystemContext(projectDir, mid);
      const fullPrompt = systemContext
        ? `${systemContext}\n\n---\n\n${prompt}`
        : prompt;

      // 4. Dispatch to harness
      let result: UnitDispatchResult;
      try {
        result = await adapter.dispatchUnit({
          unitType,
          unitId,
          prompt: fullPrompt,
          systemPrompt: GSD_SYSTEM_PROMPT,
          mcpConfigPath,
          cwd: projectDir,
        });
      } catch (err) {
        events.notify(`Dispatch error: ${(err as Error).message}`, "error");
        break;
      }

      // 5. Handle result
      events.progress({ unitType, unitId, phase: "completed", iteration });

      if (result.cost) {
        events.metric({
          unitType,
          unitId,
          cost: result.cost.totalCost,
          inputTokens: result.cost.tokens.input,
          outputTokens: result.cost.tokens.output,
        });
      }

      if (result.status === "error") {
        events.notify(
          `Unit failed: ${result.errorContext?.message ?? "unknown error"}`,
          "error",
        );
        // Transient errors: retry. Permanent: stop.
        if (result.errorContext?.isTransient) {
          events.notify("Transient error — retrying", "warning");
          continue;
        }
        break;
      }

      if (result.status === "cancelled") {
        events.notify("Unit cancelled", "warning");
        break;
      }

      // Success — loop back, re-derive state, pick next unit
      events.notify(`Unit complete: ${unitType} ${unitId}`, "success");
    }

    if (iteration >= maxIter) {
      events.notify(`Safety: hit ${maxIter} iteration limit`, "error");
    }
  } finally {
    core.releaseSessionLock(projectDir);
    events.notify("Session lock released", "info");
  }
}

// ---------------------------------------------------------------------------
// System context builder — inject project/decisions/requirements into prompt
// ---------------------------------------------------------------------------

function buildSystemContext(projectDir: string, milestoneId: string): string | null {
  const gsdDir = join(projectDir, ".gsd");
  const sections: string[] = [];

  // Project description
  const projectPath = join(gsdDir, "PROJECT.md");
  if (existsSync(projectPath)) {
    sections.push(`## Project\n\n${readFileSync(projectPath, "utf-8")}`);
  }

  // Decisions
  const decisionsPath = join(gsdDir, "DECISIONS.md");
  if (existsSync(decisionsPath)) {
    sections.push(`## Decisions\n\n${readFileSync(decisionsPath, "utf-8")}`);
  }

  // Requirements
  const requirementsPath = join(gsdDir, "REQUIREMENTS.md");
  if (existsSync(requirementsPath)) {
    sections.push(`## Requirements\n\n${readFileSync(requirementsPath, "utf-8")}`);
  }

  // Roadmap
  const roadmapPath = join(gsdDir, "milestones", milestoneId, `${milestoneId}-ROADMAP.md`);
  if (existsSync(roadmapPath)) {
    sections.push(`## Roadmap\n\n${readFileSync(roadmapPath, "utf-8")}`);
  }

  if (sections.length === 0) return null;

  return `# GSD Context\n\n${sections.join("\n\n---\n\n")}`;
}
