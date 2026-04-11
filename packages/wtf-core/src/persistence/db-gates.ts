// WTF Database — Quality gate operations

import type { GateRow, GateId, GateScope, GateStatus, GateVerdict } from "../domain/types.ts";
import { WTFError, WTF_STALE_STATE } from "../domain/errors.ts";
import { _getCurrentDb } from "./db-core.ts";
import { rowToGate } from "./row-mappers.ts";

export function insertGateRow(g: {
  milestoneId: string;
  sliceId: string;
  gateId: GateId;
  scope: GateScope;
  taskId?: string | null;
  status?: GateStatus;
}): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  db.prepare(
    `INSERT OR IGNORE INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
     VALUES (:mid, :sid, :gid, :scope, :tid, :status)`,
  ).run({
    ":mid": g.milestoneId,
    ":sid": g.sliceId,
    ":gid": g.gateId,
    ":scope": g.scope,
    ":tid": g.taskId ?? "",
    ":status": g.status ?? "pending",
  });
}

export function saveGateResult(g: {
  milestoneId: string;
  sliceId: string;
  gateId: string;
  taskId?: string | null;
  verdict: GateVerdict;
  rationale: string;
  findings: string;
}): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  db.prepare(
    `UPDATE quality_gates
     SET status = 'complete', verdict = :verdict, rationale = :rationale,
         findings = :findings, evaluated_at = :evaluated_at
     WHERE milestone_id = :mid AND slice_id = :sid AND gate_id = :gid
       AND task_id = :tid`,
  ).run({
    ":mid": g.milestoneId,
    ":sid": g.sliceId,
    ":gid": g.gateId,
    ":tid": g.taskId ?? "",
    ":verdict": g.verdict,
    ":rationale": g.rationale,
    ":findings": g.findings,
    ":evaluated_at": new Date().toISOString(),
  });
}

export function getPendingGates(milestoneId: string, sliceId: string, scope?: GateScope): GateRow[] {
  const db = _getCurrentDb();
  if (!db) return [];
  const sql = scope
    ? `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND scope = :scope AND status = 'pending'`
    : `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND status = 'pending'`;
  const params: Record<string, unknown> = { ":mid": milestoneId, ":sid": sliceId };
  if (scope) params[":scope"] = scope;
  return db.prepare(sql).all(params).map(rowToGate);
}

export function getGateResults(milestoneId: string, sliceId: string, scope?: GateScope): GateRow[] {
  const db = _getCurrentDb();
  if (!db) return [];
  const sql = scope
    ? `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND scope = :scope`
    : `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid`;
  const params: Record<string, unknown> = { ":mid": milestoneId, ":sid": sliceId };
  if (scope) params[":scope"] = scope;
  return db.prepare(sql).all(params).map(rowToGate);
}

export function markAllGatesOmitted(milestoneId: string, sliceId: string): void {
  const db = _getCurrentDb();
  if (!db) return;
  db.prepare(
    `UPDATE quality_gates SET status = 'omitted', verdict = 'omitted', evaluated_at = :now
     WHERE milestone_id = :mid AND slice_id = :sid AND status = 'pending'`,
  ).run({
    ":mid": milestoneId,
    ":sid": sliceId,
    ":now": new Date().toISOString(),
  });
}

export function getPendingSliceGateCount(milestoneId: string, sliceId: string): number {
  const db = _getCurrentDb();
  if (!db) return 0;
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM quality_gates
     WHERE milestone_id = :mid AND slice_id = :sid AND scope = 'slice' AND status = 'pending'`,
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  return row ? (row["cnt"] as number) : 0;
}
