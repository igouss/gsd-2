// Barrel export for old .planning migration module

export { handleMigrate } from './command.ts';
export { parsePlanningDirectory } from './parser.ts';
export { validatePlanningDirectory } from './validator.ts';
export { transformToWTF } from './transformer.ts';
export { writeWTFDirectory } from './writer.ts';
export type { WrittenFiles, MigrationPreview } from './writer.ts';
export { generatePreview } from './preview.ts';
export type {
  // Input types (old .planning format)
  PlanningProject,
  PlanningPhase,
  PlanningPlan,
  PlanningPlanFrontmatter,
  PlanningPlanMustHaves,
  PlanningSummary,
  PlanningSummaryFrontmatter,
  PlanningSummaryRequires,
  PlanningRoadmap,
  PlanningRoadmapMilestone,
  PlanningRoadmapEntry,
  PlanningRequirement,
  PlanningResearch,
  PlanningConfig,
  PlanningQuickTask,
  PlanningMilestone,
  PlanningState,
  PlanningPhaseFile,
  ValidationResult,
  ValidationIssue,
  ValidationSeverity,
  // Output types (WTF-2 format)
  WTFProject,
  WTFMilestone,
  WTFSlice,
  WTFTask,
  WTFRequirement,
  WTFSliceSummaryData,
  WTFTaskSummaryData,
  WTFBoundaryEntry,
} from './types.ts';
