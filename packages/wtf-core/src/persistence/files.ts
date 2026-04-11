// WTF Extension - File Parsing and I/O (barrel)
// Re-exports from focused sub-modules. All downstream imports unchanged.

export {
  splitFrontmatter, parseFrontmatterMap,
  cacheKey, cachedParse,
  registerCacheClearCallback, clearParseCache,
  formatShortcut,
  extractSection, extractAllSections,
  parseBullets, extractBoldField,
} from './file-helpers.ts';

export {
  parseSecretsManifest, formatSecretsManifest,
  parseTaskPlanFile,
  parseSummary,
  parseContinue, formatContinue,
  parseTaskPlanMustHaves, countMustHavesMentionedInSummary,
} from './file-parsers.ts';

export {
  loadFile, saveFile,
  parseRequirementCounts,
  parseTaskPlanIO,
  extractUatType,
  parseContextDependsOn,
  inlinePriorMilestoneSummary,
} from './file-io.ts';
export type { UatType } from './file-io.ts';

export {
  getManifestStatus,
  appendOverride, appendKnowledge,
  loadActiveOverrides, parseOverrides,
  formatOverridesSection, resolveAllOverrides,
} from './file-knowledge.ts';
export type { Override } from './file-knowledge.ts';
