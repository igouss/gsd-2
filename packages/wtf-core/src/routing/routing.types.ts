// Model routing and task classification types.

export type TokenProfile = "budget" | "balanced" | "quality";

export type InlineLevel = "full" | "standard" | "minimal";

// ComplexityTier, ClassificationResult, and TaskMetadata are canonical in
// analysis/complexity-classifier.ts. Re-exported for convenience.
export type { ComplexityTier, ClassificationResult, TaskMetadata } from "../analysis/complexity-classifier.ts";
