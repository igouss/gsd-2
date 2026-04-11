// WTF state types: phase machine, active references, milestone registry, dashboard state.
//
// WTFState is composed from focused sub-interfaces so consumers can depend on
// only the slice they need. The full WTFState union is still the canonical
// return type of deriveState() for backwards compatibility.

// ─── Phase Machine ───────────────────────────────────────────────────────────

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

// ─── Active Navigation ───────────────────────────────────────────────────────

export interface ActiveRef {
  id: string;
  title: string;
}

/** Which work unit is currently active (milestone → slice → task). */
export interface ActiveNavigation {
  activeMilestone: ActiveRef | null;
  activeSlice: ActiveRef | null;
  activeTask: ActiveRef | null;
}

// ─── Phase + Operational State ───────────────────────────────────────────────

/** Current phase machine position, blockers, and next action. */
export interface PhaseState {
  phase: Phase;
  blockers: string[];
  nextAction: string;
}

// ─── Milestone Registry ──────────────────────────────────────────────────────

export interface MilestoneRegistryEntry {
  id: string;
  title: string;
  status: "complete" | "active" | "pending" | "parked";
  /** Milestone IDs that must be complete before this milestone becomes active. Populated from CONTEXT.md YAML frontmatter. */
  dependsOn?: string[];
}

// ─── Progress / Dashboard ────────────────────────────────────────────────────

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

/** Read-only dashboard view: registry, requirements, progress counts. */
export interface ProgressSnapshot {
  registry: MilestoneRegistryEntry[];
  requirements?: RequirementCounts;
  progress?: WTFProgress;
}

// ─── Composed State ──────────────────────────────────────────────────────────

export interface WTFState extends ActiveNavigation, PhaseState, ProgressSnapshot {
  /** When phase=complete, holds the last completed milestone (instead of activeMilestone). */
  lastCompletedMilestone?: ActiveRef | null;
}
