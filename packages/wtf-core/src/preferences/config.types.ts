// Operational configuration types: budget enforcement, phase skipping, notifications.

export type BudgetEnforcementMode = "warn" | "pause" | "halt";

export interface PhaseSkipPreferences {
  skip_research?: boolean;
  skip_reassess?: boolean;
  skip_slice_research?: boolean;
  skip_milestone_validation?: boolean;
  reassess_after_slice?: boolean;
  /** When true, auto-mode pauses before each slice for discussion (#789). */
  require_slice_discussion?: boolean;
}

export interface NotificationPreferences {
  enabled?: boolean; // default true
  on_complete?: boolean; // notify on each unit completion
  on_error?: boolean; // notify on errors
  on_budget?: boolean; // notify on budget thresholds
  on_milestone?: boolean; // notify when milestone finishes
  on_attention?: boolean; // notify when manual attention needed
}
