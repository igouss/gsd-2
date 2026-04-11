// Requirement domain entity.

export type RequirementStatus = "active" | "validated" | "deferred" | "out-of-scope";

export type RequirementClass =
  | "core-capability"
  | "primary-user-loop"
  | "launchability"
  | "continuity"
  | "failure-visibility"
  | "integration"
  | "quality-attribute"
  | "operability"
  | "admin/support"
  | "compliance/security"
  | "differentiator"
  | "constraint"
  | "anti-feature";

export interface Requirement {
  id: string; // e.g. "R001"
  class: RequirementClass | ""; // "" = unclassified
  status: RequirementStatus;
  description: string; // short description
  why: string; // rationale
  source: string; // origin (milestone, user, etc.)
  primary_owner: string; // owning slice/milestone
  supporting_slices: string; // other slices that touch this
  validation: string; // how to validate
  notes: string; // additional notes
  full_content: string; // full requirement text
  superseded_by: string | null; // ID of superseding requirement, or null
}
