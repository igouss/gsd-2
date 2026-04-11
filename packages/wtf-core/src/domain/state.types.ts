// WTF state types: phase machine, active references, milestone registry, dashboard state.

export type Phase =
  | "pre-planning"
  | "needs-discussion"
  | "discussing"
  | "researching"
  | "planning"
  | "evaluating-gates"
  | "executing"
  | "verifying"
  | "summarizing"
  | "advancing"
  | "validating-milestone"
  | "completing-milestone"
  | "replanning-slice"
  | "complete"
  | "paused"
  | "blocked";

export interface ActiveRef {
  id: string;
  title: string;
}

export interface MilestoneRegistryEntry {
  id: string;
  title: string;
  status: "complete" | "active" | "pending" | "parked";
  /** Milestone IDs that must be complete before this milestone becomes active. Populated from CONTEXT.md YAML frontmatter. */
  dependsOn?: string[];
}

export interface RequirementCounts {
  active: number;
  validated: number;
  deferred: number;
  outOfScope: number;
  blocked: number;
  total: number;
}

export interface ProgressCounts {
  done: number;
  total: number;
}

export interface WTFProgress {
  milestones: ProgressCounts;
  slices?: ProgressCounts;
  tasks?: ProgressCounts;
}

export interface WTFState {
  activeMilestone: ActiveRef | null;
  activeSlice: ActiveRef | null;
  activeTask: ActiveRef | null;
  phase: Phase;
  recentDecisions: string[];
  blockers: string[];
  nextAction: string;
  activeWorkspace?: string;
  registry: MilestoneRegistryEntry[];
  requirements?: RequirementCounts;
  progress?: WTFProgress;
  /** When phase=complete, holds the last completed milestone (instead of activeMilestone). */
  lastCompletedMilestone?: ActiveRef | null;
}
