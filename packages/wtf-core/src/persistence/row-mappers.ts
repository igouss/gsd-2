// Row Mappers — Single source of truth for DB row → domain entity conversion.
//
// Every query site that reads rows from SQLite MUST use these functions
// instead of inline `as` casts. One mapper per table.

import type { Decision, DecisionMadeBy, Requirement, RequirementClass, RequirementStatus } from '../domain/types.ts';
import type { GateRow, GateId, GateScope, GateStatus, GateVerdict } from '../domain/types.ts';
import type { MilestoneRow } from './db-milestones.ts';
import type { SliceRow } from './db-slices.ts';
import type { TaskRow } from './db-tasks.ts';
import type { ArtifactRow } from './db-artifacts.ts';
import type { Memory } from './memory-store.ts';

/** Map a raw SQLite row to a Decision domain entity. */
export function rowToDecision(row: Record<string, unknown>): Decision {
  return {
    seq: row['seq'] as number,
    id: row['id'] as string,
    when_context: row['when_context'] as string,
    scope: row['scope'] as string,
    decision: row['decision'] as string,
    choice: row['choice'] as string,
    rationale: row['rationale'] as string,
    revisable: row['revisable'] as string,
    made_by: (row['made_by'] as DecisionMadeBy) ?? 'agent',
    superseded_by: (row['superseded_by'] as string) ?? null,
  };
}

/** Map a raw SQLite row to a Requirement domain entity. */
export function rowToRequirement(row: Record<string, unknown>): Requirement {
  return {
    id: row['id'] as string,
    class: row['class'] as RequirementClass | "",
    status: row['status'] as RequirementStatus,
    description: row['description'] as string,
    why: row['why'] as string,
    source: row['source'] as string,
    primary_owner: row['primary_owner'] as string,
    supporting_slices: row['supporting_slices'] as string,
    validation: row['validation'] as string,
    notes: row['notes'] as string,
    full_content: row['full_content'] as string,
    superseded_by: (row['superseded_by'] as string) ?? null,
  };
}

/** Map a raw SQLite row to a MilestoneRow. */
export function rowToMilestone(row: Record<string, unknown>): MilestoneRow {
  return {
    id: row["id"] as string,
    title: row["title"] as string,
    status: row["status"] as string,
    depends_on: JSON.parse((row["depends_on"] as string) || "[]"),
    created_at: row["created_at"] as string,
    completed_at: (row["completed_at"] as string) ?? null,
    vision: (row["vision"] as string) ?? "",
    success_criteria: JSON.parse((row["success_criteria"] as string) || "[]"),
    key_risks: JSON.parse((row["key_risks"] as string) || "[]"),
    proof_strategy: JSON.parse((row["proof_strategy"] as string) || "[]"),
    verification_contract: (row["verification_contract"] as string) ?? "",
    verification_integration: (row["verification_integration"] as string) ?? "",
    verification_operational: (row["verification_operational"] as string) ?? "",
    verification_uat: (row["verification_uat"] as string) ?? "",
    definition_of_done: JSON.parse((row["definition_of_done"] as string) || "[]"),
    requirement_coverage: (row["requirement_coverage"] as string) ?? "",
    boundary_map_markdown: (row["boundary_map_markdown"] as string) ?? "",
  };
}

/** Map a raw SQLite row to a SliceRow. */
export function rowToSlice(row: Record<string, unknown>): SliceRow {
  return {
    milestone_id: row["milestone_id"] as string,
    id: row["id"] as string,
    title: row["title"] as string,
    status: row["status"] as string,
    risk: row["risk"] as string,
    depends: JSON.parse((row["depends"] as string) || "[]"),
    demo: (row["demo"] as string) ?? "",
    created_at: row["created_at"] as string,
    completed_at: (row["completed_at"] as string) ?? null,
    full_summary_md: (row["full_summary_md"] as string) ?? "",
    full_uat_md: (row["full_uat_md"] as string) ?? "",
    goal: (row["goal"] as string) ?? "",
    success_criteria: (row["success_criteria"] as string) ?? "",
    proof_level: (row["proof_level"] as string) ?? "",
    integration_closure: (row["integration_closure"] as string) ?? "",
    observability_impact: (row["observability_impact"] as string) ?? "",
    sequence: (row["sequence"] as number) ?? 0,
    replan_triggered_at: (row["replan_triggered_at"] as string) ?? null,
  };
}

/** Map a raw SQLite row to a TaskRow. */
export function rowToTask(row: Record<string, unknown>): TaskRow {
  return {
    milestone_id: row["milestone_id"] as string,
    slice_id: row["slice_id"] as string,
    id: row["id"] as string,
    title: row["title"] as string,
    status: row["status"] as string,
    one_liner: row["one_liner"] as string,
    narrative: row["narrative"] as string,
    verification_result: row["verification_result"] as string,
    duration: row["duration"] as string,
    completed_at: (row["completed_at"] as string) ?? null,
    blocker_discovered: (row["blocker_discovered"] as number) === 1,
    deviations: row["deviations"] as string,
    known_issues: row["known_issues"] as string,
    key_files: JSON.parse((row["key_files"] as string) || "[]"),
    key_decisions: JSON.parse((row["key_decisions"] as string) || "[]"),
    full_summary_md: row["full_summary_md"] as string,
    description: (row["description"] as string) ?? "",
    estimate: (row["estimate"] as string) ?? "",
    files: JSON.parse((row["files"] as string) || "[]"),
    verify: (row["verify"] as string) ?? "",
    inputs: JSON.parse((row["inputs"] as string) || "[]"),
    expected_output: JSON.parse((row["expected_output"] as string) || "[]"),
    observability_impact: (row["observability_impact"] as string) ?? "",
    full_plan_md: (row["full_plan_md"] as string) ?? "",
    sequence: (row["sequence"] as number) ?? 0,
  };
}

/** Map a raw SQLite row to a GateRow. */
export function rowToGate(row: Record<string, unknown>): GateRow {
  return {
    milestone_id: row["milestone_id"] as string,
    slice_id: row["slice_id"] as string,
    gate_id: row["gate_id"] as GateId,
    scope: row["scope"] as GateScope,
    task_id: (row["task_id"] as string) ?? "",
    status: row["status"] as GateStatus,
    verdict: (row["verdict"] as GateVerdict) || "",
    rationale: (row["rationale"] as string) || "",
    findings: (row["findings"] as string) || "",
    evaluated_at: (row["evaluated_at"] as string) ?? null,
  };
}

/** Map a raw SQLite row to an ArtifactRow. */
export function rowToArtifact(row: Record<string, unknown>): ArtifactRow {
  return {
    path: row["path"] as string,
    artifact_type: row["artifact_type"] as string,
    milestone_id: (row["milestone_id"] as string) ?? null,
    slice_id: (row["slice_id"] as string) ?? null,
    task_id: (row["task_id"] as string) ?? null,
    full_content: row["full_content"] as string,
    imported_at: row["imported_at"] as string,
  };
}

/** Map a raw SQLite row to a Memory entity. */
export function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    seq: row['seq'] as number,
    id: row['id'] as string,
    category: row['category'] as string,
    content: row['content'] as string,
    confidence: row['confidence'] as number,
    source_unit_type: (row['source_unit_type'] as string) ?? null,
    source_unit_id: (row['source_unit_id'] as string) ?? null,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
    superseded_by: (row['superseded_by'] as string) ?? null,
    hit_count: row['hit_count'] as number,
  };
}
