// WTF Database — Task CRUD

import { WTFError, WTF_STALE_STATE } from "../domain/errors.ts";
import { _getCurrentDb } from "./db-core.ts";
import { transaction } from "./db-core.ts";

export interface TaskPlanningRecord {
  title?: string;
  description: string;
  estimate: string;
  files: string[];
  verify: string;
  inputs: string[];
  expectedOutput: string[];
  observabilityImpact: string;
  fullPlanMd?: string;
}

export interface TaskRow {
  milestone_id: string;
  slice_id: string;
  id: string;
  title: string;
  status: string;
  one_liner: string;
  narrative: string;
  verification_result: string;
  duration: string;
  completed_at: string | null;
  blocker_discovered: boolean;
  deviations: string;
  known_issues: string;
  key_files: string[];
  key_decisions: string[];
  full_summary_md: string;
  description: string;
  estimate: string;
  files: string[];
  verify: string;
  inputs: string[];
  expected_output: string[];
  observability_impact: string;
  full_plan_md: string;
  sequence: number;
}

function rowToTask(row: Record<string, unknown>): TaskRow {
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

export function insertTask(t: {
  id: string;
  sliceId: string;
  milestoneId: string;
  title?: string;
  status?: string;
  oneLiner?: string;
  narrative?: string;
  verificationResult?: string;
  duration?: string;
  blockerDiscovered?: boolean;
  deviations?: string;
  knownIssues?: string;
  keyFiles?: string[];
  keyDecisions?: string[];
  fullSummaryMd?: string;
  sequence?: number;
  planning?: Partial<TaskPlanningRecord>;
}): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  db.prepare(
    `INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, one_liner, narrative,
      verification_result, duration, completed_at, blocker_discovered,
      deviations, known_issues, key_files, key_decisions, full_summary_md,
      description, estimate, files, verify, inputs, expected_output, observability_impact, sequence
    ) VALUES (
      :milestone_id, :slice_id, :id, :title, :status, :one_liner, :narrative,
      :verification_result, :duration, :completed_at, :blocker_discovered,
      :deviations, :known_issues, :key_files, :key_decisions, :full_summary_md,
      :description, :estimate, :files, :verify, :inputs, :expected_output, :observability_impact, :sequence
    )
    ON CONFLICT(milestone_id, slice_id, id) DO UPDATE SET
      title = CASE WHEN NULLIF(:title, '') IS NOT NULL THEN :title ELSE tasks.title END,
      status = :status,
      one_liner = :one_liner,
      narrative = :narrative,
      verification_result = :verification_result,
      duration = :duration,
      completed_at = :completed_at,
      blocker_discovered = :blocker_discovered,
      deviations = :deviations,
      known_issues = :known_issues,
      key_files = :key_files,
      key_decisions = :key_decisions,
      full_summary_md = :full_summary_md,
      description = CASE WHEN NULLIF(:description, '') IS NOT NULL THEN :description ELSE tasks.description END,
      estimate = CASE WHEN NULLIF(:estimate, '') IS NOT NULL THEN :estimate ELSE tasks.estimate END,
      files = CASE WHEN NULLIF(:files, '[]') IS NOT NULL THEN :files ELSE tasks.files END,
      verify = CASE WHEN NULLIF(:verify, '') IS NOT NULL THEN :verify ELSE tasks.verify END,
      inputs = CASE WHEN NULLIF(:inputs, '[]') IS NOT NULL THEN :inputs ELSE tasks.inputs END,
      expected_output = CASE WHEN NULLIF(:expected_output, '[]') IS NOT NULL THEN :expected_output ELSE tasks.expected_output END,
      observability_impact = CASE WHEN NULLIF(:observability_impact, '') IS NOT NULL THEN :observability_impact ELSE tasks.observability_impact END,
      sequence = :sequence`,
  ).run({
    ":milestone_id": t.milestoneId,
    ":slice_id": t.sliceId,
    ":id": t.id,
    ":title": t.title ?? "",
    ":status": t.status ?? "pending",
    ":one_liner": t.oneLiner ?? "",
    ":narrative": t.narrative ?? "",
    ":verification_result": t.verificationResult ?? "",
    ":duration": t.duration ?? "",
    ":completed_at": t.status === "done" || t.status === "complete" ? new Date().toISOString() : null,
    ":blocker_discovered": t.blockerDiscovered ? 1 : 0,
    ":deviations": t.deviations ?? "",
    ":known_issues": t.knownIssues ?? "",
    ":key_files": JSON.stringify(t.keyFiles ?? []),
    ":key_decisions": JSON.stringify(t.keyDecisions ?? []),
    ":full_summary_md": t.fullSummaryMd ?? "",
    ":description": t.planning?.description ?? "",
    ":estimate": t.planning?.estimate ?? "",
    ":files": JSON.stringify(t.planning?.files ?? []),
    ":verify": t.planning?.verify ?? "",
    ":inputs": JSON.stringify(t.planning?.inputs ?? []),
    ":expected_output": JSON.stringify(t.planning?.expectedOutput ?? []),
    ":observability_impact": t.planning?.observabilityImpact ?? "",
    ":sequence": t.sequence ?? 0,
  });
}

export function updateTaskStatus(milestoneId: string, sliceId: string, taskId: string, status: string, completedAt?: string): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  db.prepare(
    `UPDATE tasks SET status = :status, completed_at = :completed_at
     WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id`,
  ).run({
    ":status": status,
    ":completed_at": completedAt ?? null,
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":id": taskId,
  });
}

export function setTaskBlockerDiscovered(milestoneId: string, sliceId: string, taskId: string, discovered: boolean): void {
  const db = _getCurrentDb();
  if (!db) return;
  db.prepare(
    `UPDATE tasks SET blocker_discovered = :discovered WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":discovered": discovered ? 1 : 0, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}

export function upsertTaskPlanning(milestoneId: string, sliceId: string, taskId: string, planning: Partial<TaskPlanningRecord>): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  db.prepare(
    `UPDATE tasks SET
      title = COALESCE(:title, title),
      description = COALESCE(:description, description),
      estimate = COALESCE(:estimate, estimate),
      files = COALESCE(:files, files),
      verify = COALESCE(:verify, verify),
      inputs = COALESCE(:inputs, inputs),
      expected_output = COALESCE(:expected_output, expected_output),
      observability_impact = COALESCE(:observability_impact, observability_impact),
      full_plan_md = COALESCE(:full_plan_md, full_plan_md)
     WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id`,
  ).run({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":id": taskId,
    ":title": planning.title ?? null,
    ":description": planning.description ?? null,
    ":estimate": planning.estimate ?? null,
    ":files": planning.files ? JSON.stringify(planning.files) : null,
    ":verify": planning.verify ?? null,
    ":inputs": planning.inputs ? JSON.stringify(planning.inputs) : null,
    ":expected_output": planning.expectedOutput ? JSON.stringify(planning.expectedOutput) : null,
    ":observability_impact": planning.observabilityImpact ?? null,
    ":full_plan_md": planning.fullPlanMd ?? null,
  });
}

export function getTask(milestoneId: string, sliceId: string, taskId: string): TaskRow | null {
  const db = _getCurrentDb();
  if (!db) return null;
  const row = db.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid",
  ).get({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  if (!row) return null;
  return rowToTask(row);
}

export function getSliceTasks(milestoneId: string, sliceId: string): TaskRow[] {
  const db = _getCurrentDb();
  if (!db) return [];
  const rows = db.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid ORDER BY sequence, id",
  ).all({ ":mid": milestoneId, ":sid": sliceId });
  return rows.map(rowToTask);
}

export function setTaskSummaryMd(milestoneId: string, sliceId: string, taskId: string, md: string): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  db.prepare(
    `UPDATE tasks SET full_summary_md = :md WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId, ":md": md });
}

export function deleteTask(milestoneId: string, sliceId: string, taskId: string): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  transaction(() => {
    const d = _getCurrentDb()!;
    // Must delete verification_evidence first (FK constraint)
    d.prepare(
      `DELETE FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
    d.prepare(
      `DELETE FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  });
}
