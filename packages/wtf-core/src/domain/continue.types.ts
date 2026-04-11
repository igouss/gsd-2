// Continue-here types: session resumption state.

export type ContinueStatus = "in_progress" | "interrupted" | "compacted";

export interface ContinueFrontmatter {
  milestone: string;
  slice: string;
  task: string;
  step: number;
  totalSteps: number;
  status: ContinueStatus;
  savedAt: string;
}

export interface Continue {
  frontmatter: ContinueFrontmatter;
  completedWork: string;
  remainingWork: string;
  decisions: string;
  context: string;
  nextAction: string;
}
