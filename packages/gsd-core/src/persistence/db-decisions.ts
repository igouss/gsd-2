// WTF Database — Decision + Requirement CRUD

import type { Decision, Requirement } from "../domain/types.ts";
import { WTFError, WTF_STALE_STATE } from "../domain/errors.ts";
import { _getCurrentDb } from "./db-core.ts";

export function getRequirementById(id: string): Requirement | null {
  const db = _getCurrentDb();
  if (!db) return null;
  const row = db.prepare("SELECT * FROM requirements WHERE id = ?").get(id);
  if (!row) return null;
  return {
    id: row["id"] as string,
    class: row["class"] as string,
    status: row["status"] as string,
    description: row["description"] as string,
    why: row["why"] as string,
    source: row["source"] as string,
    primary_owner: row["primary_owner"] as string,
    supporting_slices: row["supporting_slices"] as string,
    validation: row["validation"] as string,
    notes: row["notes"] as string,
    full_content: row["full_content"] as string,
    superseded_by: (row["superseded_by"] as string) ?? null,
  };
}

export function upsertDecision(d: Omit<Decision, "seq">): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  // Use ON CONFLICT DO UPDATE instead of INSERT OR REPLACE to preserve the
  // seq column. INSERT OR REPLACE deletes then reinserts, resetting seq and
  // corrupting decision ordering in DECISIONS.md after reconcile replay.
  db.prepare(
    `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :made_by, :superseded_by)
     ON CONFLICT(id) DO UPDATE SET
       when_context = excluded.when_context,
       scope = excluded.scope,
       decision = excluded.decision,
       choice = excluded.choice,
       rationale = excluded.rationale,
       revisable = excluded.revisable,
       made_by = excluded.made_by,
       superseded_by = excluded.superseded_by`,
  ).run({
    ":id": d.id,
    ":when_context": d.when_context,
    ":scope": d.scope,
    ":decision": d.decision,
    ":choice": d.choice,
    ":rationale": d.rationale,
    ":revisable": d.revisable,
    ":made_by": d.made_by ?? "agent",
    ":superseded_by": d.superseded_by ?? null,
  });
}

export function upsertRequirement(r: Requirement): void {
  const db = _getCurrentDb();
  if (!db) throw new WTFError(WTF_STALE_STATE, "wtf-db: No database open");
  db.prepare(
    `INSERT OR REPLACE INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
     VALUES (:id, :class, :status, :description, :why, :source, :primary_owner, :supporting_slices, :validation, :notes, :full_content, :superseded_by)`,
  ).run({
    ":id": r.id,
    ":class": r.class,
    ":status": r.status,
    ":description": r.description,
    ":why": r.why,
    ":source": r.source,
    ":primary_owner": r.primary_owner,
    ":supporting_slices": r.supporting_slices,
    ":validation": r.validation,
    ":notes": r.notes,
    ":full_content": r.full_content,
    ":superseded_by": r.superseded_by ?? null,
  });
}
