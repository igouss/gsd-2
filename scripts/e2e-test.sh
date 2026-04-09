#!/usr/bin/env bash
# e2e-test.sh — Set up a throwaway project and run gsd-run against it.
# Usage: ./scripts/e2e-test.sh [--model <model>] [--timeout <seconds>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="/tmp/gsd-test-project"
MODEL="${GSD_MODEL:-claude-sonnet-4-6}"
TIMEOUT=360  # 6 minutes

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)  MODEL="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *)        echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "=== GSD E2E Test ==="
echo "Project:  $PROJECT_DIR"
echo "Model:    $MODEL"
echo "Timeout:  ${TIMEOUT}s"
echo ""

# ── 1. Clean slate ────────────────────────────────────────────────────────────
echo "→ Removing $PROJECT_DIR..."
rm -rf "$PROJECT_DIR"

# ── 2. Create project skeleton ────────────────────────────────────────────────
echo "→ Setting up test project..."
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"
git init --quiet
echo "node_modules/" > .gitignore

# Minimal package.json so the agent has a real project
cat > package.json <<'PKGJSON'
{
  "name": "gsd-e2e-test",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "node --test src/**/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0"
  }
}
PKGJSON

cat > tsconfig.json <<'TSCONFIG'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
TSCONFIG

mkdir -p src
cat > src/index.ts <<'SRC'
// Entry point — will be implemented by the agent
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
SRC

# Initial commit so the agent has a clean git state
git add -A
git commit -m "Initial project skeleton" --quiet

# ── 3. Set up .gsd/ structure ─────────────────────────────────────────────────
echo "→ Creating .gsd/ structure..."
GSD="$PROJECT_DIR/.gsd"
mkdir -p "$GSD/milestones/M001/slices/S01/tasks"

# ── PROJECT.md ──
cat > "$GSD/PROJECT.md" <<'PROJECT'
# Project

## What This Is

A simple CLI word-counter tool. Reads text from stdin or a file and prints word count, line count, and character count.

## Core Value

Accurate word/line/char counting with clean, tested TypeScript code.

## Current State

Empty project skeleton with package.json and tsconfig.json. No implementation yet.

## Architecture / Key Patterns

- Pure TypeScript, Node.js ESM
- `src/counter.ts` — core counting logic (pure functions)
- `src/cli.ts` — CLI entry point using process.argv
- `src/index.ts` — public API exports
- Tests use node:test

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract.

## Milestone Sequence

- [ ] M001: Word Counter CLI — Build a working word/line/char counter CLI tool
PROJECT

# ── DECISIONS.md ──
cat > "$GSD/DECISIONS.md" <<'DECISIONS'
# Decisions

(none yet)
DECISIONS

# ── REQUIREMENTS.md ──
cat > "$GSD/REQUIREMENTS.md" <<'REQUIREMENTS'
# Requirements

- R001: Count words, lines, and characters from stdin or file input — **active**
- R002: Output format: `<lines> <words> <chars> [filename]` — **active**
- R003: Exit code 0 on success, 1 on error — **active**
REQUIREMENTS

# ── STATE.md ──
cat > "$GSD/STATE.md" <<'STATE'
# GSD State

**Active Milestone:** M001: Word Counter CLI
**Active Slice:** S01: Core Counting Logic + CLI
**Active Task:** none
**Phase:** planning
**Next Action:** Plan slice S01 tasks
**Last Updated:** 2026-04-09
**Requirements Status:** 3 active · 0 validated · 0 deferred · 0 out of scope

## Recent Decisions

- (none)

## Blockers

- (none)
STATE

# ── M001 CONTEXT ──
cat > "$GSD/milestones/M001/M001-CONTEXT.md" <<'CONTEXT'
# M001: Word Counter CLI

**Gathered:** 2026-04-09
**Status:** Ready for planning

## Project Description

A simple CLI word-counter tool that reads text from stdin or a file and prints word count, line count, and character count.

## Why This Milestone

This is the only milestone — it delivers the complete working tool.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Run `echo "hello world" | node dist/cli.js` and see `1 2 11`
- Run `node dist/cli.js README.md` and see counts for that file

### Entry point / environment

- Entry point: `node dist/cli.js [file]`
- Environment: local dev / CLI
- Live dependencies involved: none

## Completion Class

- Contract complete means: unit tests pass for counting logic and CLI integration
- Integration complete means: CLI reads real files and stdin
- Operational complete means: none

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- `echo "hello world" | node dist/cli.js` outputs correct counts
- `node dist/cli.js tsconfig.json` outputs correct counts for an existing file

## Risks and Unknowns

- None — this is a straightforward CLI tool

## Existing Codebase / Prior Art

- `src/index.ts` — empty entry point placeholder

## Relevant Requirements

- R001 — core counting capability
- R002 — output format
- R003 — exit codes

## Scope

### In Scope

- Word, line, and character counting
- File and stdin input
- Clean error messages

### Out of Scope / Non-Goals

- Unicode normalization
- Recursive directory scanning
- Performance optimization for large files

## Technical Constraints

- Node.js ESM, TypeScript strict mode
- No external dependencies for core logic
CONTEXT

# ── M001 ROADMAP ──
cat > "$GSD/milestones/M001/M001-ROADMAP.md" <<'ROADMAP'
# M001: Word Counter CLI

**Vision:** A working CLI word/line/char counter tool with tests.

## Success Criteria

- User can count words, lines, and chars from stdin
- User can count words, lines, and chars from a file argument
- Output matches format: `<lines> <words> <chars> [filename]`
- All core logic has unit tests

## Key Risks / Unknowns

- None — straightforward implementation

## Proof Strategy

- (none needed)

## Verification Classes

- Contract verification: `npm test` passes
- Integration verification: CLI reads real files
- Operational verification: none
- UAT / human verification: none

## Milestone Definition of Done

This milestone is complete only when all are true:

- All slice deliverables are complete
- `npm test` passes
- `npm run typecheck` passes
- CLI works end-to-end with both stdin and file input

## Requirement Coverage

- Covers: R001, R002, R003
- Partially covers: none
- Leaves for later: none
- Orphan risks: none

## Slices

- [ ] **S01: Core Counting Logic + CLI** `risk:low` `depends:[]`
  > After this: User can run the CLI to count words/lines/chars from stdin or a file, verified by unit tests and manual CLI test

## Horizontal Checklist

(trivial milestone — omitted)

## Boundary Map

(single slice — no cross-slice boundaries)
ROADMAP

# ── S01 PLAN ──
cat > "$GSD/milestones/M001/slices/S01/S01-PLAN.md" <<'PLAN'
# S01: Core Counting Logic + CLI

**Goal:** Implement word/line/char counting and a CLI that reads from stdin or file
**Demo:** `echo "hello world" | node dist/cli.js` prints `1 2 11`

## Must-Haves

- Pure counting function that takes a string and returns {lines, words, chars}
- CLI entry point that reads from file arg or stdin
- Output format: `<lines> <words> <chars> [filename]`
- Unit tests for the counting function
- Exit code 0 on success, 1 on error

## Verification

- `npm test` — all unit tests pass
- `npm run typecheck` — no type errors
- `echo "hello world" | node dist/cli.js` outputs `1 2 11`

## Tasks

- [ ] **T01: Implement core counting function** `est:15m`
  - Why: This is the pure business logic — count words, lines, chars from a string
  - Files: `src/counter.ts`, `src/counter.test.ts`
  - Do: Create `countText(input: string): { lines: number; words: number; chars: number }`. Lines = newline count + 1 for non-empty input. Words = split on whitespace, filter empties. Chars = string length.
  - Verify: `npx tsx --test src/counter.test.ts`
  - Done when: All counting edge cases pass (empty string, single word, multi-line, trailing newline)

- [ ] **T02: Build CLI entry point** `est:15m`
  - Why: Wire the counting function to a real CLI that reads stdin or file
  - Files: `src/cli.ts`
  - Do: Read filename from process.argv[2]. If present, read file with fs.readFileSync. Otherwise read stdin. Call countText, print result in `<lines> <words> <chars> [filename]` format. Exit 0 on success, 1 on error.
  - Verify: `echo "hello world" | npx tsx src/cli.ts` outputs `1 2 11`
  - Done when: CLI works with both stdin and file input

- [ ] **T03: Add npm build and verify end-to-end** `est:10m`
  - Why: Prove the compiled JS works, not just tsx
  - Files: `package.json`, `tsconfig.json`
  - Do: Ensure `npm run build` produces dist/cli.js. Add bin entry to package.json if needed. Run compiled CLI.
  - Verify: `npm run build && echo "test line" | node dist/cli.js` outputs correct counts
  - Done when: `npm run build && npm test && npm run typecheck` all pass

## Files Likely Touched

- `src/counter.ts`
- `src/counter.test.ts`
- `src/cli.ts`
- `src/index.ts`
- `package.json`
PLAN

# Install deps so the agent doesn't have to wait
echo "→ Installing dependencies..."
cd "$PROJECT_DIR"
npm install --quiet 2>/dev/null

# Commit .gsd state
git add -A
git commit -m "Add .gsd project state" --quiet

# ── 4. Build gsd-cli if needed ────────────────────────────────────────────────
echo "→ Ensuring gsd-cli is built..."
cd "$REPO_ROOT"
if [[ ! -f packages/gsd-cli/dist/run.js ]]; then
  npm run -w packages/gsd-core build --quiet
  npm run -w packages/gsd-cli build --quiet
fi

# ── 5. Run gsd-run with timeout ───────────────────────────────────────────────
echo ""
echo "=== Starting gsd-run (timeout: ${TIMEOUT}s) ==="
echo ""

GSD_RUN="$REPO_ROOT/packages/gsd-cli/dist/run.js"

set +e
timeout "${TIMEOUT}s" node "$GSD_RUN" "$PROJECT_DIR" \
  --model "$MODEL" \
  --verbose
EXIT_CODE=$?
set -e

echo ""
echo "=== E2E Test Complete ==="
echo "Exit code: $EXIT_CODE"

if [[ $EXIT_CODE -eq 124 ]]; then
  echo "⚠ Timed out after ${TIMEOUT}s (this is expected for the timeout guard)"
elif [[ $EXIT_CODE -eq 0 ]]; then
  echo "✓ gsd-run completed successfully"
else
  echo "✗ gsd-run failed with exit code $EXIT_CODE"
fi

# ── 6. Show what the agent produced ───────────────────────────────────────────
echo ""
echo "=== Project state after run ==="
echo "--- Files created ---"
find "$PROJECT_DIR/src" -type f 2>/dev/null | sort
echo ""
echo "--- .gsd state ---"
cat "$PROJECT_DIR/.gsd/STATE.md" 2>/dev/null || echo "(no STATE.md)"
echo ""
echo "--- Git log ---"
cd "$PROJECT_DIR"
git log --oneline -10

exit $EXIT_CODE
