/**
 * @gsd-build/gsd-core — Harness-agnostic GSD orchestration engine.
 *
 * This package contains the core orchestration logic: auto-loop, state machine,
 * dispatch, prompt building, DB, journal, recovery — everything that does NOT
 * depend on a specific LLM execution harness.
 *
 * Harness-specific behavior is plugged in via the HarnessAdapter interface.
 */

// Adapter contract
export type {
  HarnessAdapter,
  UnitDispatchRequest,
  UnitDispatchResult,
  UnitErrorContext,
  OrchestratorEventSink,
} from "./adapters/harness-adapter.js";

export { nullEventSink } from "./adapters/harness-adapter.js";

// Tool handlers — pure functions for state mutation
export { handleCompleteTask } from "./tools/complete-task.js";
export type { CompleteTaskResult } from "./tools/complete-task.js";
export { handleCompleteSlice } from "./tools/complete-slice.js";
export type { CompleteSliceResult } from "./tools/complete-slice.js";
export { handleCompleteMilestone } from "./tools/complete-milestone.js";
export { handlePlanMilestone } from "./tools/plan-milestone.js";
export { handlePlanSlice } from "./tools/plan-slice.js";
export { handlePlanTask } from "./tools/plan-task.js";
export { handleReplanSlice } from "./tools/replan-slice.js";
export { handleReassessRoadmap } from "./tools/reassess-roadmap.js";
export { handleReopenTask } from "./tools/reopen-task.js";
export { handleReopenSlice } from "./tools/reopen-slice.js";
export { handleReopenMilestone } from "./tools/reopen-milestone.js";
export { handleValidateMilestone } from "./tools/validate-milestone.js";

// DB operations
export { saveDecisionToDb, saveRequirementToDb, updateRequirementInDb, saveArtifactToDb } from "./persistence/db-writer.js";
export type { SaveArtifactOpts } from "./persistence/db-writer.js";

// DB — lifecycle and direct access
export { openDatabase, closeDatabase, isDbAvailable, updateSliceStatus, saveGateResult } from "./persistence/gsd-db.js";

// State derivation
export { deriveState, invalidateStateCache } from "./state/state.js";

// Cache invalidation
export { clearPathCache } from "./persistence/paths.js";
export { clearParseCache } from "./persistence/files.js";

// Dispatch
export { resolveDispatch } from "./auto/auto-dispatch.js";

// Preferences
export { loadEffectiveGSDPreferences } from "./preferences/preferences.js";

// Session locking
export { acquireSessionLock, releaseSessionLock } from "./session/session-lock.js";

// Milestone IDs
export { nextMilestoneId, findMilestoneIds } from "./milestone/milestone-ids.js";

// Journal
export { queryJournal } from "./persistence/journal.js";

// Types
export type { CompleteTaskParams, CompleteSliceParams } from "./domain/types.js";

// Adapters
export { ClaudeCodeAdapter } from "./adapters/claude-code.js";
export type { ClaudeCodeAdapterOptions } from "./adapters/claude-code.js";
export { writeMcpConfig } from "./adapters/mcp-config.js";
export type { McpConfigOptions } from "./adapters/mcp-config.js";
