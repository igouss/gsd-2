// GSD Extension - File Parsing and I/O (barrel)
// Re-exports from focused sub-modules. All downstream imports unchanged.

export {
  splitFrontmatter, parseFrontmatterMap,
  cachedParse,
  registerCacheClearCallback, clearParseCache,
  formatShortcut,
  extractSection, extractAllSections,
  parseBullets, extractBoldField,
} from './file-helpers.js';

export {
  parseSecretsManifest, formatSecretsManifest,
  parseTaskPlanFile,
  parseSummary,
  parseContinue, formatContinue,
  parseTaskPlanMustHaves, countMustHavesMentionedInSummary,
} from './file-parsers.js';

export {
  loadFile, saveFile,
  parseRequirementCounts,
  parseTaskPlanIO,
  extractUatType,
  parseContextDependsOn,
  inlinePriorMilestoneSummary,
} from './file-io.js';
export type { UatType } from './file-io.js';

export {
  getManifestStatus,
  appendOverride, appendKnowledge,
  loadActiveOverrides, parseOverrides,
  formatOverridesSection, resolveAllOverrides,
} from './file-knowledge.js';
export type { Override } from './file-knowledge.js';
