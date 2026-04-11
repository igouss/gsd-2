// WTF Database — Milestone CRUD

import { WTFError, WTF_STALE_STATE } from "../domain/errors.ts";
import { _getCurrentDb } from "./db-core.ts";
import { rowToMilestone } from "./row-mappers.ts";

export interface MilestonePlanningRecord {
  vision: string;
  successCriteria: string[];
  keyRisks: Array<{ risk: string; whyItMatters: string }>;
  proofStrategy: Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }>;
  verificationContract: string;
  verificationIntegration: string;
  verificationOperational: string;
  verificationUat: string;
  definitionOfDone: string[];
  requirementCoverage: string;
  boundaryMapMarkdown: string;
}

export interface MilestoneRow {
  id: string;
  title: string;
  status: string;
  depends_on: string[];
  created_at: string;
  completed_at: string | null;
  vision: string;
  success_criteria: string[];
  key_risks: Array<{ risk: string; whyItMatters: string }>;
  proof_strategy: Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }>;
  verification_contract: string;
  verification_integration: string;
  verification_operational: string;
  verification_uat: string;
  definition_of_done: string[];
  requirement_coverage: string;
  boundary_map_markdown: string;
}

export function insertMilestone(m: {
  id: string;
  title?: string;
  status?: string;
  depends_on?: string[];
  planning?: Partial<MilestonePlanningRecord>;
}): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  db.prepare(
    `INSERT OR IGNORE INTO milestones (
      id, title, status, depends_on, created_at,
      vision, success_criteria, key_risks, proof_strategy,
      verification_contract, verification_integration, verification_operational, verification_uat,
      definition_of_done, requirement_coverage, boundary_map_markdown
    ) VALUES (
      :id, :title, :status, :depends_on, :created_at,
      :vision, :success_criteria, :key_risks, :proof_strategy,
      :verification_contract, :verification_integration, :verification_operational, :verification_uat,
      :definition_of_done, :requirement_coverage, :boundary_map_markdown
    )`,
  ).run({
    ":id": m.id,
    ":title": m.title ?? "",
    // Default to "queued" — never auto-create milestones as "active" (#3380).
    // Callers that need "active" must pass it explicitly.
    ":status": m.status ?? "queued",
    ":depends_on": JSON.stringify(m.depends_on ?? []),
    ":created_at": new Date().toISOString(),
    ":vision": m.planning?.vision ?? "",
    ":success_criteria": JSON.stringify(m.planning?.successCriteria ?? []),
    ":key_risks": JSON.stringify(m.planning?.keyRisks ?? []),
    ":proof_strategy": JSON.stringify(m.planning?.proofStrategy ?? []),
    ":verification_contract": m.planning?.verificationContract ?? "",
    ":verification_integration": m.planning?.verificationIntegration ?? "",
    ":verification_operational": m.planning?.verificationOperational ?? "",
    ":verification_uat": m.planning?.verificationUat ?? "",
    ":definition_of_done": JSON.stringify(m.planning?.definitionOfDone ?? []),
    ":requirement_coverage": m.planning?.requirementCoverage ?? "",
    ":boundary_map_markdown": m.planning?.boundaryMapMarkdown ?? "",
  });
}

export function upsertMilestonePlanning(milestoneId: string, planning: Partial<MilestonePlanningRecord> & { title?: string; status?: string }): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  db.prepare(
    `UPDATE milestones SET
      title = COALESCE(NULLIF(:title, ''), title),
      status = COALESCE(NULLIF(:status, ''), status),
      vision = COALESCE(:vision, vision),
      success_criteria = COALESCE(:success_criteria, success_criteria),
      key_risks = COALESCE(:key_risks, key_risks),
      proof_strategy = COALESCE(:proof_strategy, proof_strategy),
      verification_contract = COALESCE(:verification_contract, verification_contract),
      verification_integration = COALESCE(:verification_integration, verification_integration),
      verification_operational = COALESCE(:verification_operational, verification_operational),
      verification_uat = COALESCE(:verification_uat, verification_uat),
      definition_of_done = COALESCE(:definition_of_done, definition_of_done),
      requirement_coverage = COALESCE(:requirement_coverage, requirement_coverage),
      boundary_map_markdown = COALESCE(:boundary_map_markdown, boundary_map_markdown)
     WHERE id = :id`,
  ).run({
    ":id": milestoneId,
    ":title": planning.title ?? "",
    ":status": planning.status ?? "",
    ":vision": planning.vision ?? null,
    ":success_criteria": planning.successCriteria ? JSON.stringify(planning.successCriteria) : null,
    ":key_risks": planning.keyRisks ? JSON.stringify(planning.keyRisks) : null,
    ":proof_strategy": planning.proofStrategy ? JSON.stringify(planning.proofStrategy) : null,
    ":verification_contract": planning.verificationContract ?? null,
    ":verification_integration": planning.verificationIntegration ?? null,
    ":verification_operational": planning.verificationOperational ?? null,
    ":verification_uat": planning.verificationUat ?? null,
    ":definition_of_done": planning.definitionOfDone ? JSON.stringify(planning.definitionOfDone) : null,
    ":requirement_coverage": planning.requirementCoverage ?? null,
    ":boundary_map_markdown": planning.boundaryMapMarkdown ?? null,
  });
}

export function getAllMilestones(): MilestoneRow[] {
  const db = _getCurrentDb();
  if (!db) return [];
  const rows = db.prepare("SELECT * FROM milestones ORDER BY id").all();
  return rows.map(rowToMilestone);
}

export function getMilestone(id: string): MilestoneRow | null {
  const db = _getCurrentDb();
  if (!db) return null;
  const row = db.prepare("SELECT * FROM milestones WHERE id = :id").get({ ":id": id });
  if (!row) return null;
  return rowToMilestone(row);
}

/**
 * Update a milestone's status in the database.
 * Used by park/unpark to keep the DB in sync with the filesystem marker.
 * See: https://github.com/igouss/wtf-3/issues/2694
 */
export function updateMilestoneStatus(milestoneId: string, status: string, completedAt?: string | null): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  db.prepare(
    `UPDATE milestones SET status = :status, completed_at = :completed_at WHERE id = :id`,
  ).run({ ":status": status, ":completed_at": completedAt ?? null, ":id": milestoneId });
}
