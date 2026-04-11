// Model routing and task classification types.

export type TokenProfile = "budget" | "balanced" | "quality";

export type InlineLevel = "full" | "standard" | "minimal";

export type ComplexityTier = "light" | "standard" | "heavy";

export interface ClassificationResult {
  tier: ComplexityTier;
  reason: string;
  downgraded: boolean;
  taskMetadata?: TaskMetadata;
}

export interface TaskMetadata {
  fileCount?: number;
  dependencyCount?: number;
  isNewFile?: boolean;
  tags?: string[];
  estimatedLines?: number;
  codeBlockCount?: number;
  complexityKeywords?: string[];
}
