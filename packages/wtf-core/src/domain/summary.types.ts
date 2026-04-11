// Summary types: task and slice completion summaries.

export interface SummaryRequires {
  slice: string;
  provides: string;
}

export interface SummaryFrontmatter {
  id: string;
  parent: string;
  milestone: string;
  provides: string[];
  requires: SummaryRequires[];
  affects: string[];
  key_files: string[];
  key_decisions: string[];
  patterns_established: string[];
  drill_down_paths: string[];
  observability_surfaces: string[];
  duration: string;
  verification_result: string;
  completed_at: string;
  blocker_discovered: boolean;
}

export interface FileModified {
  path: string;
  description: string;
}

export interface Summary {
  frontmatter: SummaryFrontmatter;
  title: string;
  oneLiner: string;
  whatHappened: string;
  deviations: string;
  filesModified: FileModified[];
  followUps: string;
  knownLimitations: string;
}
