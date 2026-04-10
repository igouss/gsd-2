// GSD Database — Barrel re-export
// All downstream imports use this module path; sub-modules contain the implementation.

export type { DbAdapter, DbStatement } from "./db-core.js";
export { _getCurrentDb, _getCurrentPath, isDbAvailable, openDatabase, closeDatabase, transaction, _getAdapter } from "./db-core.js";
export { getRequirementById, upsertDecision, upsertRequirement } from "./db-decisions.js";
export { clearArtifacts, insertArtifact, getArtifact } from "./db-artifacts.js";
export type { ArtifactRow } from "./db-artifacts.js";
export { insertMilestone, upsertMilestonePlanning, getAllMilestones, getMilestone, updateMilestoneStatus } from "./db-milestones.js";
export type { MilestonePlanningRecord, MilestoneRow } from "./db-milestones.js";
export { insertSlice, upsertSlicePlanning, getSlice, updateSliceStatus, setSliceSummaryMd, getMilestoneSlices, updateSliceFields, deleteSlice } from "./db-slices.js";
export type { SlicePlanningRecord, SliceRow } from "./db-slices.js";
export { insertTask, updateTaskStatus, setTaskBlockerDiscovered, upsertTaskPlanning, getTask, getSliceTasks, setTaskSummaryMd, deleteTask } from "./db-tasks.js";
export type { TaskPlanningRecord, TaskRow } from "./db-tasks.js";
export { insertVerificationEvidence, getVerificationEvidence, deleteVerificationEvidence, insertReplanHistory, insertAssessment, deleteAssessmentByScope, getReplanHistory } from "./db-evidence.js";
export type { VerificationEvidenceRow } from "./db-evidence.js";
export { insertGateRow, saveGateResult, getPendingGates, getGateResults, markAllGatesOmitted, getPendingSliceGateCount } from "./db-gates.js";
export { reconcileWorktreeDb } from "./db-worktree.js";
export type { ReconcileResult } from "./db-worktree.js";
