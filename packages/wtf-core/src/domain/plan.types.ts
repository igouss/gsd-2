// Slice plan and task plan types.

export interface TaskPlanEntry {
  id: string; // e.g. "T01"
  title: string; // e.g. "Core Type Definitions"
  description: string;
  done: boolean;
  estimate: string; // e.g. "30m", "2h" — informational only
  files?: string[]; // e.g. ["types.ts", "files.ts"] — extracted from "- Files:" subline
  verify?: string; // e.g. "run tests" — extracted from "- Verify:" subline
}

export interface TaskPlanFrontmatter {
  estimated_steps?: number; // optional scope estimate for plan quality validator
  estimated_files?: number; // optional file-count estimate for scope warning heuristics
  skills_used: string[]; // installed skill slugs/names to hand off to execute-task prompts
}

export interface TaskPlanFile {
  frontmatter: TaskPlanFrontmatter;
}

export interface SlicePlan {
  id: string; // e.g. "S01"
  title: string; // from the H1
  goal: string;
  demo: string;
  mustHaves: string[]; // top-level must-have bullet points
  tasks: TaskPlanEntry[];
  filesLikelyTouched: string[];
}
