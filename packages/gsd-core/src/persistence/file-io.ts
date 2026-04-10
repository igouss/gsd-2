// GSD Extension - File I/O
// Load/save files, requirement counting, task plan IO extraction,
// UAT type extraction, context dependency parsing, milestone summary inlining.

import { promises as fs } from 'node:fs';
import { atomicWriteAsync } from './atomic-write.ts';
import { resolveMilestoneFile, relMilestoneFile } from './paths.ts';
import { findMilestoneIds } from '../milestone/milestone-ids.ts';

import type {
  RequirementCounts,
} from '../domain/types.ts';

import { splitFrontmatter, parseFrontmatterMap } from "../shared/frontmatter.ts";
import { extractSection, parseBullets } from './file-helpers.ts';

// ─── File I/O ──────────────────────────────────────────────────────────────

/**
 * Load a file from disk. Returns content string or null if file doesn't exist.
 */
export async function loadFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw err;
  }
}

/**
 * Save content to a file atomically (write to temp, then rename).
 * Creates parent directories if needed.
 */
export async function saveFile(path: string, content: string): Promise<void> {
  await atomicWriteAsync(path, content);
}

export function parseRequirementCounts(content: string | null): RequirementCounts {
  const counts: RequirementCounts = {
    active: 0,
    validated: 0,
    deferred: 0,
    outOfScope: 0,
    blocked: 0,
    total: 0,
  };

  if (!content) return counts;

  const sections = [
    { key: 'active', heading: 'Active' },
    { key: 'validated', heading: 'Validated' },
    { key: 'deferred', heading: 'Deferred' },
    { key: 'outOfScope', heading: 'Out of Scope' },
  ] as const;

  for (const section of sections) {
    const text = extractSection(content, section.heading, 2);
    if (!text) continue;
    const matches = text.match(/^###\s+[A-Z][\w-]*\d+\s+—/gm);
    counts[section.key] = matches ? matches.length : 0;
  }

  const blockedMatches = content.match(/^-\s+Status:\s+blocked\s*$/gim);
  counts.blocked = blockedMatches ? blockedMatches.length : 0;
  counts.total = counts.active + counts.validated + counts.deferred + counts.outOfScope;
  return counts;
}

// ─── Task Plan IO Extractor ────────────────────────────────────────────────

/**
 * Extract input and output file paths from a task plan's `## Inputs` and
 * `## Expected Output` sections. Looks for backtick-wrapped file paths on
 * each line (e.g. `` `src/foo.ts` ``).
 *
 * Returns empty arrays for missing/empty sections — callers should treat
 * tasks with no IO as ambiguous (sequential fallback trigger).
 */
export function parseTaskPlanIO(content: string): { inputFiles: string[]; outputFiles: string[] } {
  const backtickPathRegex = /`([^`]+)`/g;

  function extractPaths(sectionText: string | null): string[] {
    if (!sectionText) return [];
    const paths: string[] = [];
    for (const line of sectionText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      let match: RegExpExecArray | null;
      backtickPathRegex.lastIndex = 0;
      while ((match = backtickPathRegex.exec(trimmed)) !== null) {
        const candidate = match[1];
        // Filter out things that look like code tokens rather than file paths
        // (e.g. `true`, `false`, `npm run test`). A file path has at least one
        // dot or slash.
        if (candidate!.includes("/") || candidate!.includes(".")) {
          paths.push(candidate!);
        }
      }
    }
    return paths;
  }

  const [, body] = splitFrontmatter(content);
  const inputSection = extractSection(body, "Inputs");
  const outputSection = extractSection(body, "Expected Output");

  return {
    inputFiles: extractPaths(inputSection),
    outputFiles: extractPaths(outputSection),
  };
}

// ─── UAT Type Extractor ────────────────────────────────────────────────────

/**
 * The four UAT classification types recognised by GSD auto-mode.
 * `undefined` is returned (not this union) when no type can be determined.
 */
export type UatType = 'artifact-driven' | 'live-runtime' | 'human-experience' | 'mixed' | 'browser-executable' | 'runtime-executable';

/**
 * Extract the UAT type from a UAT file's raw content.
 */
export function extractUatType(content: string): UatType | undefined {
  const sectionText = extractSection(content, 'UAT Type');
  if (!sectionText) return undefined;

  const bullets = parseBullets(sectionText);
  const modeBullet = bullets.find(b => b.startsWith('UAT mode:'));
  if (!modeBullet) return undefined;

  const rawValue = modeBullet.slice('UAT mode:'.length).trim().toLowerCase();

  if (rawValue.startsWith('artifact-driven')) return 'artifact-driven';
  if (rawValue.startsWith('browser-executable')) return 'browser-executable';
  if (rawValue.startsWith('runtime-executable')) return 'runtime-executable';
  if (rawValue.startsWith('live-runtime')) return 'live-runtime';
  if (rawValue.startsWith('human-experience')) return 'human-experience';
  if (rawValue.startsWith('mixed')) return 'mixed';

  return undefined;
}

/**
 * Extract the `depends_on` list from M00x-CONTEXT.md YAML frontmatter.
 * Returns [] when: content is null, no frontmatter block, field absent, or field is empty.
 * Normalizes each dep ID to uppercase (e.g. 'm001' -> 'M001').
 */
export function parseContextDependsOn(content: string | null): string[] {
  if (!content) return [];
  const [fmLines] = splitFrontmatter(content);
  if (!fmLines) return [];
  const fm = parseFrontmatterMap(fmLines);
  const raw = fm['depends_on'];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return (raw as string[]).map(s => String(s).trim()).filter(Boolean);
}

/**
 * Inline the prior milestone's SUMMARY.md as context for the current milestone's planning prompt.
 * Returns null when: (1) `mid` is the first milestone, (2) prior milestone has no SUMMARY file.
 */
export async function inlinePriorMilestoneSummary(mid: string, base: string): Promise<string | null> {
  const sorted = findMilestoneIds(base);
  if (sorted.length === 0) return null;
  const idx = sorted.indexOf(mid);
  if (idx <= 0) return null;
  const prevMid = sorted[idx - 1];
  const absPath = resolveMilestoneFile(base, prevMid!, "SUMMARY");
  const relPath = relMilestoneFile(base, prevMid!, "SUMMARY");
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) return null;
  return `### Prior Milestone Summary\nSource: \`${relPath}\`\n\n${content.trim()}`;
}
