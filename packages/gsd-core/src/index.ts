/**
 * @gsd-build/gsd-core — Harness-agnostic WTF orchestration engine.
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
} from "./adapters/harness-adapter.ts";

export { nullEventSink } from "./adapters/harness-adapter.ts";

// Tool handlers — pure functions for state mutation
export { handleCompleteTask } from "./tools/complete-task.ts";
export type { CompleteTaskResult } from "./tools/complete-task.ts";
export { handleCompleteSlice } from "./tools/complete-slice.ts";
export type { CompleteSliceResult } from "./tools/complete-slice.ts";
export { handleCompleteMilestone } from "./tools/complete-milestone.ts";
export { handlePlanMilestone } from "./tools/plan-milestone.ts";
export { handlePlanSlice } from "./tools/plan-slice.ts";
export { handlePlanTask } from "./tools/plan-task.ts";
export { handleReplanSlice } from "./tools/replan-slice.ts";
export { handleReassessRoadmap } from "./tools/reassess-roadmap.ts";
export { handleReopenTask } from "./tools/reopen-task.ts";
export { handleReopenSlice } from "./tools/reopen-slice.ts";
export { handleReopenMilestone } from "./tools/reopen-milestone.ts";
export { handleValidateMilestone } from "./tools/validate-milestone.ts";

// DB operations
export { saveDecisionToDb, saveRequirementToDb, updateRequirementInDb, saveArtifactToDb } from "./persistence/db-writer.ts";
export type { SaveArtifactOpts } from "./persistence/db-writer.ts";

// DB — lifecycle and direct access
export { openDatabase, closeDatabase, isDbAvailable, updateSliceStatus, saveGateResult } from "./persistence/wtf-db.ts";

// State derivation
export { deriveState, invalidateStateCache } from "./state/state.ts";

// Cache invalidation
export { clearPathCache } from "./persistence/paths.ts";
export { clearParseCache } from "./persistence/files.ts";

// Dispatch
export { resolveDispatch } from "./auto/auto-dispatch.ts";

// Preferences
export { loadEffectiveWTFPreferences } from "./preferences/preferences.ts";

// Session locking
export { acquireSessionLock, releaseSessionLock } from "./session/session-lock.ts";

// Milestone IDs
export { nextMilestoneId, findMilestoneIds } from "./milestone/milestone-ids.ts";

// Journal
export { queryJournal } from "./persistence/journal.ts";

// Constants
export { PROJECT_DIR_NAME } from "./domain/constants.ts";

// Types
export type { CompleteTaskParams, CompleteSliceParams } from "./domain/types.ts";

// Adapters
export { ClaudeCodeAdapter } from "./adapters/claude-code.ts";
export type { ClaudeCodeAdapterOptions } from "./adapters/claude-code.ts";
export { writeMcpConfig } from "./adapters/mcp-config.ts";
export type { McpConfigOptions } from "./adapters/mcp-config.ts";
