// Decision domain entity.

export type DecisionMadeBy = "human" | "agent" | "collaborative";

export interface Decision {
  seq: number; // auto-increment primary key
  id: string; // e.g. "D001"
  when_context: string; // when/context of the decision
  scope: string; // scope (milestone, slice, global, etc.)
  decision: string; // what was decided
  choice: string; // the specific choice made
  rationale: string; // why this choice
  revisable: string; // whether/when revisable
  made_by: DecisionMadeBy; // who made the decision: human, agent, or collaborative
  superseded_by: string | null; // ID of superseding decision, or null
}
