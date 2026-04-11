// WTF Extension - File Parsing Helpers
// Parse cache, markdown section extraction, and utility functions.
// Pure functions, zero Pi dependencies.

import { nativeExtractSection, NATIVE_UNAVAILABLE } from '../git/native-parser-bridge.ts';
import { CACHE_MAX } from '../domain/constants.ts';
import { splitFrontmatter, parseFrontmatterMap } from "../shared/frontmatter.ts";

// Re-export for downstream consumers
export { splitFrontmatter, parseFrontmatterMap };

// ─── Parse Cache ──────────────────────────────────────────────────────────

/** Fast composite key: length + first/mid/last 100 chars. The middle sample
 *  prevents collisions when only a few characters change in the interior of
 *  a file (e.g., a checkbox [ ] → [x] that doesn't alter length or endpoints). */
function cacheKey(content: string): string {
  const len = content.length;
  const head = content.slice(0, 100);
  const midStart = Math.max(0, Math.floor(len / 2) - 50);
  const mid = len > 200 ? content.slice(midStart, midStart + 100) : '';
  const tail = len > 100 ? content.slice(-100) : '';
  return `${len}:${head}:${mid}:${tail}`;
}

const _parseCache = new Map<string, unknown>();

export function cachedParse<T>(content: string, tag: string, parseFn: (c: string) => T): T {
  const key = tag + '|' + cacheKey(content);
  if (_parseCache.has(key)) return _parseCache.get(key) as T;
  if (_parseCache.size >= CACHE_MAX) _parseCache.clear();
  const result = parseFn(content);
  _parseCache.set(key, result);
  return result;
}

// ─── Cross-module cache clear registry ────────────────────────────────────
// md-parsers.ts registers its cache-clear callback here at module init
// to avoid circular imports. clearParseCache() calls all registered callbacks.
const _cacheClearCallbacks: (() => void)[] = [];

/** Register a callback to be invoked when clearParseCache() is called.
 *  Used by md-parsers.ts to synchronously clear its own cache. */
export function registerCacheClearCallback(cb: () => void): void {
  _cacheClearCallbacks.push(cb);
}

/** Clear the module-scoped parse cache. Call when files change on disk.
 *  Also clears any registered external caches (e.g. md-parsers.ts). */
export function clearParseCache(): void {
  _parseCache.clear();
  for (const cb of _cacheClearCallbacks) cb();
}

// ─── Platform shortcuts ───────────────────────────────────────────────────

const IS_MAC = process.platform === "darwin";

/**
 * Format a keyboard shortcut for the current OS.
 * Input: modifier key combo like "Ctrl+Alt+G"
 * Output: "⌃⌥G" on macOS, "Ctrl+Alt+G" on Windows/Linux.
 */
export function formatShortcut(combo: string): string {
  if (!IS_MAC) return combo;
  return combo
    .replace(/Ctrl\+Alt\+/i, "⌃⌥")
    .replace(/Ctrl\+/i, "⌃")
    .replace(/Alt\+/i, "⌥")
    .replace(/Shift\+/i, "⇧")
    .replace(/Cmd\+/i, "⌘");
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract the text after a heading at a given level, up to the next heading of same or higher level. */
export function extractSection(body: string, heading: string, level: number = 2): string | null {
  // Try native parser first for better performance on large files
  const nativeResult = nativeExtractSection(body, heading, level);
  if (nativeResult !== NATIVE_UNAVAILABLE) return nativeResult as string | null;

  const prefix = '#'.repeat(level) + ' ';
  const regex = new RegExp(`^${prefix}${escapeRegex(heading)}\\s*$`, 'm');
  const match = regex.exec(body);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = body.slice(start);

  const nextHeading = rest.match(new RegExp(`^#{1,${level}} `, 'm'));
  const end = nextHeading ? nextHeading.index! : rest.length;

  return rest.slice(0, end).trim();
}

/** Extract all sections at a given level, returning heading -> content map. */
export function extractAllSections(body: string, level: number = 2): Map<string, string> {
  const prefix = '#'.repeat(level) + ' ';
  const regex = new RegExp(`^${prefix}(.+)$`, 'gm');
  const sections = new Map<string, string>();
  const matches = [...body.matchAll(regex)];

  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i]![1]!.trim();
    const start = matches[i]!.index! + matches[i]![0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : body.length;
    sections.set(heading, body.slice(start, end).trim());
  }

  return sections;
}

/** Parse bullet list items from a text block. */
export function parseBullets(text: string): string[] {
  return text.split('\n')
    .map(l => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
}

/** Extract key: value from bold-prefixed lines like "**Key:** Value" */
export function extractBoldField(text: string, key: string): string | null {
  const regex = new RegExp(`^\\*\\*${escapeRegex(key)}:\\*\\*\\s*(.+)$`, 'm');
  const match = regex.exec(text);
  return match ? match[1]!.trim() : null;
}
