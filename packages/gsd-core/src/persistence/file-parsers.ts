// GSD Extension - File Parsers
// Parsers for secrets manifest, task plan, summary, and continue files.

import type {
  TaskPlanFile, TaskPlanFrontmatter,
  Summary, SummaryFrontmatter, FileModified,
  Continue, ContinueFrontmatter, ContinueStatus,
  SecretsManifest, SecretsManifestEntry, SecretsManifestEntryStatus,
} from '../domain/types.js';

import { nativeParseSummaryFile } from '../git/native-parser-bridge.js';
import { splitFrontmatter, parseFrontmatterMap } from "../shared/frontmatter.js";
import {
  cachedParse,
  extractSection,
  extractAllSections,
  extractBoldField,
  parseBullets,
} from './file-helpers.js';

// ─── Secrets Manifest Parser ───────────────────────────────────────────────

const VALID_STATUSES = new Set<SecretsManifestEntryStatus>(['pending', 'collected', 'skipped']);

export function parseSecretsManifest(content: string): SecretsManifest {
  const milestone = extractBoldField(content, 'Milestone') || '';
  const generatedAt = extractBoldField(content, 'Generated') || '';

  const h3Sections = extractAllSections(content, 3);
  const entries: SecretsManifestEntry[] = [];

  for (const [heading, sectionContent] of h3Sections) {
    const key = heading.trim();
    if (!key) continue;

    const service = extractBoldField(sectionContent, 'Service') || '';
    const dashboardUrl = extractBoldField(sectionContent, 'Dashboard') || '';
    const formatHint = extractBoldField(sectionContent, 'Format hint') || '';
    const rawStatus = (extractBoldField(sectionContent, 'Status') || 'pending').toLowerCase().trim() as SecretsManifestEntryStatus;
    const status: SecretsManifestEntryStatus = VALID_STATUSES.has(rawStatus) ? rawStatus : 'pending';
    const destination = extractBoldField(sectionContent, 'Destination') || 'dotenv';

    // Extract numbered guidance list (lines matching "1. ...", "2. ...", etc.)
    const guidance: string[] = [];
    for (const line of sectionContent.split('\n')) {
      const numMatch = line.match(/^\s*\d+\.\s+(.+)/);
      if (numMatch) {
        guidance.push(numMatch[1].trim());
      }
    }

    entries.push({ key, service, dashboardUrl, guidance, formatHint, status, destination });
  }

  return { milestone, generatedAt, entries };
}

// ─── Secrets Manifest Formatter ───────────────────────────────────────────

export function formatSecretsManifest(manifest: SecretsManifest): string {
  const lines: string[] = [];

  lines.push('# Secrets Manifest');
  lines.push('');
  lines.push(`**Milestone:** ${manifest.milestone}`);
  lines.push(`**Generated:** ${manifest.generatedAt}`);

  for (const entry of manifest.entries) {
    lines.push('');
    lines.push(`### ${entry.key}`);
    lines.push('');
    lines.push(`**Service:** ${entry.service}`);
    if (entry.dashboardUrl) {
      lines.push(`**Dashboard:** ${entry.dashboardUrl}`);
    }
    if (entry.formatHint) {
      lines.push(`**Format hint:** ${entry.formatHint}`);
    }
    lines.push(`**Status:** ${entry.status}`);
    lines.push(`**Destination:** ${entry.destination}`);
    lines.push('');
    for (let i = 0; i < entry.guidance.length; i++) {
      lines.push(`${i + 1}. ${entry.guidance[i]}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ─── Slice Plan Parser ─────────────────────────────────────────────────────

function normalizeTaskPlanFrontmatter(frontmatter: Record<string, unknown>): TaskPlanFrontmatter {
  const estimatedStepsRaw = frontmatter.estimated_steps;
  const estimatedFilesRaw = frontmatter.estimated_files;
  const skillsUsedRaw = frontmatter.skills_used;

  const parseOptionalNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };

  const estimated_steps = parseOptionalNumber(estimatedStepsRaw);
  const estimated_files = parseOptionalNumber(estimatedFilesRaw);
  const skills_used = Array.isArray(skillsUsedRaw)
    ? skillsUsedRaw.map(v => String(v).trim()).filter(Boolean)
    : typeof skillsUsedRaw === 'string' && skillsUsedRaw.trim()
      ? [skillsUsedRaw.trim()]
      : [];

  return {
    ...(estimated_steps !== undefined ? { estimated_steps } : {}),
    ...(estimated_files !== undefined ? { estimated_files } : {}),
    skills_used,
  };
}

export function parseTaskPlanFile(content: string): TaskPlanFile {
  const [fmLines] = splitFrontmatter(content);
  const fm = fmLines ? parseFrontmatterMap(fmLines) : {};
  return {
    frontmatter: normalizeTaskPlanFrontmatter(fm),
  };
}

// ─── Summary Parser ────────────────────────────────────────────────────────

export function parseSummary(content: string): Summary {
  return cachedParse(content, 'summary', _parseSummaryImpl);
}

function _parseSummaryImpl(content: string): Summary {
  // Try native parser first for better performance
  const nativeResult = nativeParseSummaryFile(content);
  if (nativeResult) {
    const nfm = nativeResult.frontmatter;
    return {
      frontmatter: {
        id: nfm.id,
        parent: nfm.parent,
        milestone: nfm.milestone,
        provides: nfm.provides,
        requires: nfm.requires,
        affects: nfm.affects,
        key_files: nfm.keyFiles,
        key_decisions: nfm.keyDecisions,
        patterns_established: nfm.patternsEstablished,
        drill_down_paths: nfm.drillDownPaths,
        observability_surfaces: nfm.observabilitySurfaces,
        duration: nfm.duration,
        verification_result: nfm.verificationResult,
        completed_at: nfm.completedAt,
        blocker_discovered: nfm.blockerDiscovered,
      },
      title: nativeResult.title,
      oneLiner: nativeResult.oneLiner,
      whatHappened: nativeResult.whatHappened,
      deviations: nativeResult.deviations,
      filesModified: nativeResult.filesModified,
      followUps: extractSection(content, 'Follow-ups') ?? '',
      knownLimitations: extractSection(content, 'Known Limitations') ?? '',
    };
  }

  const [fmLines, body] = splitFrontmatter(content);

  const fm = fmLines ? parseFrontmatterMap(fmLines) : {};
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v : (typeof v === 'string' && v ? [v] : []);
  const frontmatter: SummaryFrontmatter = {
    id: (fm.id as string) || '',
    parent: (fm.parent as string) || '',
    milestone: (fm.milestone as string) || '',
    provides: asStringArray(fm.provides),
    requires: ((fm.requires as Array<Record<string, string>>) || []).map(r => ({
      slice: r.slice || '',
      provides: r.provides || '',
    })),
    affects: asStringArray(fm.affects),
    key_files: asStringArray(fm.key_files),
    key_decisions: asStringArray(fm.key_decisions),
    patterns_established: asStringArray(fm.patterns_established),
    drill_down_paths: asStringArray(fm.drill_down_paths),
    observability_surfaces: asStringArray(fm.observability_surfaces),
    duration: (fm.duration as string) || '',
    verification_result: (fm.verification_result as string) || 'untested',
    completed_at: (fm.completed_at as string) || '',
    blocker_discovered: fm.blocker_discovered === 'true' || fm.blocker_discovered === true,
  };

  const bodyLines = body.split('\n');
  const h1 = bodyLines.find(l => l.startsWith('# '));
  const title = h1 ? h1.slice(2).trim() : '';

  const h1Idx = bodyLines.indexOf(h1 || '');
  let oneLiner = '';
  for (let i = h1Idx + 1; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim();
    if (!line) continue;
    if (line.startsWith('**') && line.endsWith('**')) {
      oneLiner = line.slice(2, -2);
    }
    break;
  }

  const whatHappened = extractSection(body, 'What Happened') || '';
  const deviations = extractSection(body, 'Deviations') || '';

  const filesSection = extractSection(body, 'Files Created/Modified') || extractSection(body, 'Files Modified');
  const filesModified: FileModified[] = [];
  if (filesSection) {
    for (const line of filesSection.split('\n')) {
      const trimmed = line.replace(/^\s*[-*]\s+/, '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const fileMatch = trimmed.match(/^`([^`]+)`\s*[—–-]\s*(.+)/);
      if (fileMatch) {
        filesModified.push({ path: fileMatch[1], description: fileMatch[2].trim() });
      }
    }
  }

  const followUps = extractSection(body, 'Follow-ups') ?? '';
  const knownLimitations = extractSection(body, 'Known Limitations') ?? '';

  return { frontmatter, title, oneLiner, whatHappened, deviations, filesModified, followUps, knownLimitations };
}

// ─── Continue Parser ───────────────────────────────────────────────────────

export function parseContinue(content: string): Continue {
  return cachedParse(content, 'continue', _parseContinueImpl);
}

function _parseContinueImpl(content: string): Continue {
  const [fmLines, body] = splitFrontmatter(content);

  const fm = fmLines ? parseFrontmatterMap(fmLines) : {};
  const frontmatter: ContinueFrontmatter = {
    milestone: (fm.milestone as string) || '',
    slice: (fm.slice as string) || '',
    task: (fm.task as string) || '',
    step: typeof fm.step === 'string' ? parseInt(fm.step) : (fm.step as number) || 0,
    totalSteps: typeof fm.total_steps === 'string' ? parseInt(fm.total_steps) : (fm.total_steps as number) ||
      (typeof fm.totalSteps === 'string' ? parseInt(fm.totalSteps) : (fm.totalSteps as number) || 0),
    status: ((fm.status as string) || 'in_progress') as ContinueStatus,
    savedAt: (fm.saved_at as string) || (fm.savedAt as string) || '',
  };

  const completedWork = extractSection(body, 'Completed Work') || '';
  const remainingWork = extractSection(body, 'Remaining Work') || '';
  const decisions = extractSection(body, 'Decisions Made') || '';
  const context = extractSection(body, 'Context') || '';
  const nextAction = extractSection(body, 'Next Action') || '';

  return { frontmatter, completedWork, remainingWork, decisions, context, nextAction };
}

// ─── Continue Formatter ────────────────────────────────────────────────────

function formatFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = ['---'];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (typeof value[0] === 'object' && value[0] !== null) {
        lines.push(`${key}:`);
        for (const obj of value) {
          const entries = Object.entries(obj as Record<string, unknown>);
          if (entries.length > 0) {
            lines.push(`  - ${entries[0][0]}: ${entries[0][1]}`);
            for (let i = 1; i < entries.length; i++) {
              lines.push(`    ${entries[i][0]}: ${entries[i][1]}`);
            }
          }
        }
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

export function formatContinue(cont: Continue): string {
  const fm = cont.frontmatter;
  const fmData: Record<string, unknown> = {
    milestone: fm.milestone,
    slice: fm.slice,
    task: fm.task,
    step: fm.step,
    total_steps: fm.totalSteps,
    status: fm.status,
    saved_at: fm.savedAt,
  };

  const lines: string[] = [];
  lines.push(formatFrontmatter(fmData));
  lines.push('');
  lines.push('## Completed Work');
  lines.push(cont.completedWork);
  lines.push('');
  lines.push('## Remaining Work');
  lines.push(cont.remainingWork);
  lines.push('');
  lines.push('## Decisions Made');
  lines.push(cont.decisions);
  lines.push('');
  lines.push('## Context');
  lines.push(cont.context);
  lines.push('');
  lines.push('## Next Action');
  lines.push(cont.nextAction);

  return lines.join('\n');
}

// ─── Task Plan Must-Haves Parser ───────────────────────────────────────────

/**
 * Parse must-have items from a task plan's `## Must-Haves` section.
 * Returns structured items with checkbox state. Handles YAML frontmatter,
 * all common checkbox variants (`[ ]`, `[x]`, `[X]`), plain bullets (no checkbox),
 * and indented variants. Returns empty array when the section is missing or empty.
 */
export function parseTaskPlanMustHaves(content: string): Array<{ text: string; checked: boolean }> {
  const [, body] = splitFrontmatter(content);
  const sectionText = extractSection(body, 'Must-Haves');
  if (!sectionText) return [];

  const bullets = parseBullets(sectionText);
  if (bullets.length === 0) return [];

  return bullets.map(line => {
    const cbMatch = line.match(/^\[([xX ])\]\s+(.+)/);
    if (cbMatch) {
      return {
        text: cbMatch[2].trim(),
        checked: cbMatch[1].toLowerCase() === 'x',
      };
    }
    // No checkbox - treat as unchecked with full line as text
    return { text: line.trim(), checked: false };
  });
}

// ─── Must-Have Summary Matching ────────────────────────────────────────────

/** Common short words to exclude from substring matching. */
const COMMON_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her',
  'was', 'one', 'our', 'out', 'has', 'its', 'let', 'say', 'she', 'too', 'use',
  'with', 'have', 'from', 'this', 'that', 'they', 'been', 'each', 'when', 'will',
  'does', 'into', 'also', 'than', 'them', 'then', 'some', 'what', 'only', 'just',
  'more', 'make', 'like', 'made', 'over', 'such', 'take', 'most', 'very', 'must',
  'file', 'test', 'tests', 'task', 'new', 'add', 'added', 'existing',
]);

/**
 * Count how many must-have items are mentioned in a summary.
 */
export function countMustHavesMentionedInSummary(
  mustHaves: Array<{ text: string; checked: boolean }>,
  summaryContent: string,
): number {
  if (!summaryContent || mustHaves.length === 0) return 0;

  const summaryLower = summaryContent.toLowerCase();
  let count = 0;

  for (const mh of mustHaves) {
    // Extract backtick-enclosed code tokens
    const codeTokens: string[] = [];
    const codeRegex = /`([^`]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = codeRegex.exec(mh.text)) !== null) {
      codeTokens.push(match[1]);
    }

    if (codeTokens.length > 0) {
      // Strategy 1: any code token found in summary (case-insensitive)
      const found = codeTokens.some(token => summaryLower.includes(token.toLowerCase()));
      if (found) count++;
    } else {
      // Strategy 2: significant substring matching
      const words = mh.text.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w =>
        w.length >= 4 && !COMMON_WORDS.has(w.toLowerCase())
      );
      const found = words.some(word => summaryLower.includes(word.toLowerCase()));
      if (found) count++;
    }
  }

  return count;
}
