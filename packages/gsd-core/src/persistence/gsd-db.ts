// GSD Database — Barrel re-export
// All downstream imports use this module path; sub-modules contain the implementation.

export type { DbAdapter, DbStatement } from "./db-core.ts";
export { _getCurrentDb, _getCurrentPath, isDbAvailable, openDatabase, closeDatabase, transaction, _getAdapter } from "./db-core.ts";
export { getRequirementById, upsertDecision, upsertRequirement } from "./db-decisions.ts";
export { clearArtifacts, insertArtifact, getArtifact } from "./db-artifacts.ts";
export type { ArtifactRow } from "./db-artifacts.ts";
export { insertMilestone, upsertMilestonePlanning, getAllMilestones, getMilestone, updateMilestoneStatus } from "./db-milestones.ts";
export type { MilestonePlanningRecord, MilestoneRow } from "./db-milestones.ts";
export { insertSlice, upsertSlicePlanning, getSlice, updateSliceStatus, setSliceSummaryMd, getMilestoneSlices, updateSliceFields, deleteSlice } from "./db-slices.ts";
export type { SlicePlanningRecord, SliceRow } from "./db-slices.ts";
export { insertTask, updateTaskStatus, setTaskBlockerDiscovered, upsertTaskPlanning, getTask, getSliceTasks, setTaskSummaryMd, deleteTask } from "./db-tasks.ts";
export type { TaskPlanningRecord, TaskRow } from "./db-tasks.ts";
export { insertVerificationEvidence, getVerificationEvidence, deleteVerificationEvidence, insertReplanHistory, insertAssessment, deleteAssessmentByScope, getReplanHistory } from "./db-evidence.ts";
export type { VerificationEvidenceRow } from "./db-evidence.ts";
export { insertGateRow, saveGateResult, getPendingGates, getGateResults, markAllGatesOmitted, getPendingSliceGateCount } from "./db-gates.ts";
export { reconcileWorktreeDb } from "./db-worktree.ts";
export type { ReconcileResult } from "./db-worktree.ts";
