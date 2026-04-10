// GSD Database — Slice CRUD + dependencies

import { GSDError, GSD_STALE_STATE } from "../domain/errors.ts";
import { _getCurrentDb } from "./db-core.ts";
import { transaction } from "./db-core.ts";

export interface SlicePlanningRecord {
  goal: string;
  successCriteria: string;
  proofLevel: string;
  integrationClosure: string;
  observabilityImpact: string;
}

export interface SliceRow {
  milestone_id: string;
  id: string;
  title: string;
  status: string;
  risk: string;
  depends: string[];
  demo: string;
  created_at: string;
  completed_at: string | null;
  full_summary_md: string;
  full_uat_md: string;
  goal: string;
  success_criteria: string;
  proof_level: string;
  integration_closure: string;
  observability_impact: string;
  sequence: number;
  replan_triggered_at: string | null;
}

function rowToSlice(row: Record<string, unknown>): SliceRow {
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

export function insertSlice(s: {
  id: string;
  milestoneId: string;
  title?: string;
  status?: string;
  risk?: string;
  depends?: string[];
  demo?: string;
  sequence?: number;
  planning?: Partial<SlicePlanningRecord>;
}): void {
  const db = _getCurrentDb();
  if (!db) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  db.prepare(
    `INSERT INTO slices (
      milestone_id, id, title, status, risk, depends, demo, created_at,
      goal, success_criteria, proof_level, integration_closure, observability_impact, sequence
    ) VALUES (
      :milestone_id, :id, :title, :status, :risk, :depends, :demo, :created_at,
      :goal, :success_criteria, :proof_level, :integration_closure, :observability_impact, :sequence
    )
    ON CONFLICT (milestone_id, id) DO UPDATE SET
      title = CASE WHEN :raw_title IS NOT NULL THEN excluded.title ELSE slices.title END,
      status = CASE WHEN slices.status IN ('complete', 'done') THEN slices.status ELSE excluded.status END,
      risk = CASE WHEN :raw_risk IS NOT NULL THEN excluded.risk ELSE slices.risk END,
      depends = excluded.depends,
      demo = CASE WHEN :raw_demo IS NOT NULL THEN excluded.demo ELSE slices.demo END,
      goal = CASE WHEN :raw_goal IS NOT NULL THEN excluded.goal ELSE slices.goal END,
      success_criteria = CASE WHEN :raw_success_criteria IS NOT NULL THEN excluded.success_criteria ELSE slices.success_criteria END,
      proof_level = CASE WHEN :raw_proof_level IS NOT NULL THEN excluded.proof_level ELSE slices.proof_level END,
      integration_closure = CASE WHEN :raw_integration_closure IS NOT NULL THEN excluded.integration_closure ELSE slices.integration_closure END,
      observability_impact = CASE WHEN :raw_observability_impact IS NOT NULL THEN excluded.observability_impact ELSE slices.observability_impact END,
      sequence = CASE WHEN :raw_sequence IS NOT NULL THEN excluded.sequence ELSE slices.sequence END`,
  ).run({
    ":milestone_id": s.milestoneId,
    ":id": s.id,
    ":title": s.title ?? "",
    ":status": s.status ?? "pending",
    ":risk": s.risk ?? "medium",
    ":depends": JSON.stringify(s.depends ?? []),
    ":demo": s.demo ?? "",
    ":created_at": new Date().toISOString(),
    ":goal": s.planning?.goal ?? "",
    ":success_criteria": s.planning?.successCriteria ?? "",
    ":proof_level": s.planning?.proofLevel ?? "",
    ":integration_closure": s.planning?.integrationClosure ?? "",
    ":observability_impact": s.planning?.observabilityImpact ?? "",
    ":sequence": s.sequence ?? 0,
    // Raw sentinel params: NULL when caller omitted the field, used in ON CONFLICT guards
    ":raw_title": s.title ?? null,
    ":raw_risk": s.risk ?? null,
    ":raw_demo": s.demo ?? null,
    ":raw_goal": s.planning?.goal ?? null,
    ":raw_success_criteria": s.planning?.successCriteria ?? null,
    ":raw_proof_level": s.planning?.proofLevel ?? null,
    ":raw_integration_closure": s.planning?.integrationClosure ?? null,
    ":raw_observability_impact": s.planning?.observabilityImpact ?? null,
    ":raw_sequence": s.sequence ?? null,
  });
}

export function upsertSlicePlanning(milestoneId: string, sliceId: string, planning: Partial<SlicePlanningRecord>): void {
  const db = _getCurrentDb();
  if (!db) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  db.prepare(
    `UPDATE slices SET
      goal = COALESCE(:goal, goal),
      success_criteria = COALESCE(:success_criteria, success_criteria),
      proof_level = COALESCE(:proof_level, proof_level),
      integration_closure = COALESCE(:integration_closure, integration_closure),
      observability_impact = COALESCE(:observability_impact, observability_impact)
     WHERE milestone_id = :milestone_id AND id = :id`,
  ).run({
    ":milestone_id": milestoneId,
    ":id": sliceId,
    ":goal": planning.goal ?? null,
    ":success_criteria": planning.successCriteria ?? null,
    ":proof_level": planning.proofLevel ?? null,
    ":integration_closure": planning.integrationClosure ?? null,
    ":observability_impact": planning.observabilityImpact ?? null,
  });
}

export function getSlice(milestoneId: string, sliceId: string): SliceRow | null {
  const db = _getCurrentDb();
  if (!db) return null;
  const row = db.prepare("SELECT * FROM slices WHERE milestone_id = :mid AND id = :sid").get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToSlice(row);
}

export function updateSliceStatus(milestoneId: string, sliceId: string, status: string, completedAt?: string): void {
  const db = _getCurrentDb();
  if (!db) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  db.prepare(
    `UPDATE slices SET status = :status, completed_at = :completed_at
     WHERE milestone_id = :milestone_id AND id = :id`,
  ).run({
    ":status": status,
    ":completed_at": completedAt ?? null,
    ":milestone_id": milestoneId,
    ":id": sliceId,
  });
}

export function setSliceSummaryMd(milestoneId: string, sliceId: string, summaryMd: string, uatMd: string): void {
  const db = _getCurrentDb();
  if (!db) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  db.prepare(
    `UPDATE slices SET full_summary_md = :summary_md, full_uat_md = :uat_md WHERE milestone_id = :mid AND id = :sid`,
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":summary_md": summaryMd, ":uat_md": uatMd });
}

export function getMilestoneSlices(milestoneId: string): SliceRow[] {
  const db = _getCurrentDb();
  if (!db) return [];
  const rows = db.prepare("SELECT * FROM slices WHERE milestone_id = :mid ORDER BY sequence, id").all({ ":mid": milestoneId });
  return rows.map(rowToSlice);
}

export function updateSliceFields(milestoneId: string, sliceId: string, fields: {
  title?: string;
  risk?: string;
  depends?: string[];
  demo?: string;
}): void {
  const db = _getCurrentDb();
  if (!db) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  db.prepare(
    `UPDATE slices SET
      title = COALESCE(:title, title),
      risk = COALESCE(:risk, risk),
      depends = COALESCE(:depends, depends),
      demo = COALESCE(:demo, demo)
     WHERE milestone_id = :milestone_id AND id = :id`,
  ).run({
    ":milestone_id": milestoneId,
    ":id": sliceId,
    ":title": fields.title ?? null,
    ":risk": fields.risk ?? null,
    ":depends": fields.depends ? JSON.stringify(fields.depends) : null,
    ":demo": fields.demo ?? null,
  });
}

export function deleteSlice(milestoneId: string, sliceId: string): void {
  const db = _getCurrentDb();
  if (!db) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    const d = _getCurrentDb()!;
    // Cascade-style manual deletion: evidence → tasks → dependencies → slice
    d.prepare(
      `DELETE FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    d.prepare(
      `DELETE FROM tasks WHERE milestone_id = :mid AND slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    d.prepare(
      `DELETE FROM slice_dependencies WHERE milestone_id = :mid AND slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    d.prepare(
      `DELETE FROM slice_dependencies WHERE milestone_id = :mid AND depends_on_slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    d.prepare(
      `DELETE FROM slices WHERE milestone_id = :mid AND id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
  });
}
