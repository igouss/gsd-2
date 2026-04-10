// GSD Extension - Knowledge and Overrides
// CRUD for overrides, knowledge entries, and manifest status.

import { resolve } from 'node:path';
import { resolveMilestoneFile, resolveGsdRootFile } from './paths.ts';

import type {
  ManifestStatus,
} from '../domain/types.ts';

import { checkExistingEnvKeys } from '../shared/env-utils.ts';
import { parseSecretsManifest } from './file-parsers.ts';
import { loadFile, saveFile } from './file-io.ts';

// ─── Manifest Status ──────────────────────────────────────────────────────

/**
 * Read a secrets manifest from disk and cross-reference each entry's status
 * with the current environment (.env + process.env).
 *
 * Returns `null` when no manifest file exists (path resolution failure or
 * file not on disk) - callers can distinguish "no manifest" from "empty manifest".
 */
export async function getManifestStatus(
  base: string, milestoneId: string, projectRoot?: string,
): Promise<ManifestStatus | null> {
  const resolvedPath = resolveMilestoneFile(base, milestoneId, 'SECRETS');
  if (!resolvedPath) return null;

  const content = await loadFile(resolvedPath);
  if (!content) return null;

  const manifest = parseSecretsManifest(content);
  const keys = manifest.entries.map(e => e.key);

  // Check both the base path .env AND the project root .env (#1387).
  // In worktree mode, base is the worktree path which may not have .env.
  // The project root's .env is where the user actually defined their keys.
  const existingKeys = await checkExistingEnvKeys(keys, resolve(base, '.env'));
  const existingSet = new Set(existingKeys);

  if (projectRoot && projectRoot !== base) {
    const rootKeys = await checkExistingEnvKeys(keys, resolve(projectRoot, '.env'));
    for (const k of rootKeys) existingSet.add(k);
  }

  const result: ManifestStatus = {
    pending: [],
    collected: [],
    skipped: [],
    existing: [],
  };

  for (const entry of manifest.entries) {
    if (existingSet.has(entry.key)) {
      result.existing.push(entry.key);
    } else {
      result[entry.status].push(entry.key);
    }
  }

  return result;
}

// ─── Overrides ──────────────────────────────────────────────────────────────

export interface Override {
  timestamp: string;
  change: string;
  scope: "active" | "resolved";
  appliedAt: string;
}

export async function appendOverride(basePath: string, change: string, appliedAt: string): Promise<void> {
  const overridesPath = resolveGsdRootFile(basePath, "OVERRIDES");
  const timestamp = new Date().toISOString();
  const entry = [
    `## Override: ${timestamp}`,
    "",
    `**Change:** ${change}`,
    `**Scope:** active`,
    `**Applied-at:** ${appliedAt}`,
    "",
    "---",
    "",
  ].join("\n");

  const existing = await loadFile(overridesPath);
  if (existing) {
    await saveFile(overridesPath, existing.trimEnd() + "\n\n" + entry);
  } else {
    const header = [
      "# GSD Overrides",
      "",
      "User-issued overrides that supersede plan document content.",
      "",
      "---",
      "",
    ].join("\n");
    await saveFile(overridesPath, header + entry);
  }
}

export async function appendKnowledge(
  basePath: string,
  type: "rule" | "pattern" | "lesson",
  entry: string,
  scope: string,
): Promise<void> {
  const knowledgePath = resolveGsdRootFile(basePath, "KNOWLEDGE");
  const existing = await loadFile(knowledgePath);

  if (existing) {
    // Find the next ID for this type
    const prefix = type === "rule" ? "K" : type === "pattern" ? "P" : "L";
    const idPattern = new RegExp(`^\\| ${prefix}(\\d+)`, "gm");
    let maxId = 0;
    let match;
    while ((match = idPattern.exec(existing)) !== null) {
      const num = parseInt(match[1], 10);
      if (num > maxId) maxId = num;
    }
    const nextId = `${prefix}${String(maxId + 1).padStart(3, "0")}`;

    // Build the table row
    let row: string;
    if (type === "rule") {
      row = `| ${nextId} | ${scope} | ${entry} | — | manual |`;
    } else if (type === "pattern") {
      row = `| ${nextId} | ${entry} | — | ${scope} |`;
    } else {
      row = `| ${nextId} | ${entry} | — | — | ${scope} |`;
    }

    // Find the right section and append after the table header
    const sectionHeading = type === "rule" ? "## Rules" : type === "pattern" ? "## Patterns" : "## Lessons Learned";
    const sectionIdx = existing.indexOf(sectionHeading);
    if (sectionIdx !== -1) {
      // Find the end of the table header row (the |---|...| line)
      const afterHeading = existing.indexOf("\n", sectionIdx);
      // Find the next section or end
      const nextSection = existing.indexOf("\n## ", afterHeading + 1);
      const insertPoint = nextSection !== -1 ? nextSection : existing.length;

      // Insert row before the next section (or at end)
      const before = existing.slice(0, insertPoint).trimEnd();
      const after = existing.slice(insertPoint);
      await saveFile(knowledgePath, before + "\n" + row + "\n" + after);
    } else {
      // Section not found — append at end
      await saveFile(knowledgePath, existing.trimEnd() + "\n\n" + row + "\n");
    }
  } else {
    // Create file from scratch with template header
    const header = [
      "# Project Knowledge",
      "",
      "Append-only register of project-specific rules, patterns, and lessons learned.",
      "Agents read this before every unit. Add entries when you discover something worth remembering.",
      "",
    ].join("\n");

    let content: string;
    if (type === "rule") {
      content = header + [
        "## Rules",
        "",
        "| # | Scope | Rule | Why | Added |",
        "|---|-------|------|-----|-------|",
        `| K001 | ${scope} | ${entry} | — | manual |`,
        "",
        "## Patterns",
        "",
        "| # | Pattern | Where | Notes |",
        "|---|---------|-------|-------|",
        "",
        "## Lessons Learned",
        "",
        "| # | What Happened | Root Cause | Fix | Scope |",
        "|---|--------------|------------|-----|-------|",
        "",
      ].join("\n");
    } else if (type === "pattern") {
      content = header + [
        "## Rules",
        "",
        "| # | Scope | Rule | Why | Added |",
        "|---|-------|------|-----|-------|",
        "",
        "## Patterns",
        "",
        "| # | Pattern | Where | Notes |",
        "|---|---------|-------|-------|",
        `| P001 | ${entry} | — | ${scope} |`,
        "",
        "## Lessons Learned",
        "",
        "| # | What Happened | Root Cause | Fix | Scope |",
        "|---|--------------|------------|-----|-------|",
        "",
      ].join("\n");
    } else {
      content = header + [
        "## Rules",
        "",
        "| # | Scope | Rule | Why | Added |",
        "|---|-------|------|-----|-------|",
        "",
        "## Patterns",
        "",
        "| # | Pattern | Where | Notes |",
        "|---|---------|-------|-------|",
        "",
        "## Lessons Learned",
        "",
        "| # | What Happened | Root Cause | Fix | Scope |",
        "|---|--------------|------------|-----|-------|",
        `| L001 | ${entry} | — | — | ${scope} |`,
        "",
      ].join("\n");
    }
    await saveFile(knowledgePath, content);
  }
}

export async function loadActiveOverrides(basePath: string): Promise<Override[]> {
  const overridesPath = resolveGsdRootFile(basePath, "OVERRIDES");
  const content = await loadFile(overridesPath);
  if (!content) return [];
  return parseOverrides(content).filter(o => o.scope === "active");
}

export function parseOverrides(content: string): Override[] {
  const overrides: Override[] = [];
  const blocks = content.split(/^## Override: /m).slice(1);

  for (const block of blocks) {
    const lines = block.split("\n");
    const timestamp = lines[0]?.trim() ?? "";
    let change = "";
    let scope: "active" | "resolved" = "active";
    let appliedAt = "";

    for (const line of lines) {
      const changeMatch = line.match(/^\*\*Change:\*\*\s*(.+)$/);
      if (changeMatch) change = changeMatch[1].trim();
      const scopeMatch = line.match(/^\*\*Scope:\*\*\s*(.+)$/);
      if (scopeMatch) scope = scopeMatch[1].trim() as "active" | "resolved";
      const appliedMatch = line.match(/^\*\*Applied-at:\*\*\s*(.+)$/);
      if (appliedMatch) appliedAt = appliedMatch[1].trim();
    }

    if (change) {
      overrides.push({ timestamp, change, scope, appliedAt });
    }
  }

  return overrides;
}

export function formatOverridesSection(overrides: Override[]): string {
  if (overrides.length === 0) return "";

  const entries = overrides.map((o, i) => [
    `${i + 1}. **${o.change}**`,
    `   _Issued: ${o.timestamp} during ${o.appliedAt}_`,
  ].join("\n")).join("\n");

  return [
    "## Active Overrides (supersede plan content)",
    "",
    "The following overrides were issued by the user and supersede any conflicting content in plan documents below. Follow these overrides even if they contradict the inlined task plan.",
    "",
    entries,
    "",
  ].join("\n");
}

export async function resolveAllOverrides(basePath: string): Promise<void> {
  const overridesPath = resolveGsdRootFile(basePath, "OVERRIDES");
  const content = await loadFile(overridesPath);
  if (!content) return;
  const updated = content.replace(/\*\*Scope:\*\* active/g, "**Scope:** resolved");
  await saveFile(overridesPath, updated);
}
