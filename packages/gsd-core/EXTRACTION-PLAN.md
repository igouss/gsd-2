# Phase 2: Extract harness-free files into gsd-core

## Context

We're extracting GSD from pi-mono into a standalone, harness-agnostic package.
`packages/gsd-core/` already exists with `src/harness-adapter.ts` (the adapter
interface) and `src/index.ts`. The package compiles clean with zero `@gsd/pi-*` deps.

This phase moves the ~186 harness-free files from `src/resources/extensions/gsd/`
into `packages/gsd-core/src/`, preserving the same relative directory structure.
These files have ZERO imports from `@gsd/pi-coding-agent`, `@gsd/pi-tui`, or `@gsd/pi-ai`.

**One exception**: `auto-prompts.ts` imports `getLoadedSkills` and `Skill` from
`@gsd/pi-coding-agent`. This single import must be replaced with a callback
parameter (see fixup section below).

## Branch

Work on branch `feat/gsd-core-extraction` (already exists, checked out from main).

## What to do

### Step 1: Copy the harness-free files

Copy (not move — we'll update imports later) these 186 files from
`src/resources/extensions/gsd/` to `packages/gsd-core/src/`, preserving
subdirectory structure. Create subdirectories as needed.

```bash
SRC=src/resources/extensions/gsd
DST=packages/gsd-core/src

# Create subdirectory structure
mkdir -p $DST/{auto,bootstrap,commands,migrate,safety,tools}
```

**Files to copy** (relative to `src/resources/extensions/gsd/`):

#### Root-level files (143):
```
atomic-write.ts
auto-artifact-paths.ts
auto-budget.ts
auto-dispatch.ts
auto-loop.ts
auto-prompts.ts
auto-supervisor.ts
auto-tool-tracking.ts
auto-utils.ts
auto-worktree.ts
branch-patterns.ts
cache.ts
captures.ts
codebase-generator.ts
collision-diagnostics.ts
commands.ts
complexity-classifier.ts
constants.ts
context-budget.ts
context-injector.ts
context-masker.ts
context-store.ts
crash-recovery.ts
custom-execution-policy.ts
custom-verification.ts
custom-workflow-engine.ts
db-writer.ts
debug-logger.ts
definition-loader.ts
detection.ts
dev-execution-policy.ts
dev-workflow-engine.ts
diff-context.ts
dispatch-guard.ts
doctor-checks.ts
doctor-engine-checks.ts
doctor-environment.ts
doctor-format.ts
doctor-git-checks.ts
doctor-global-checks.ts
doctor-proactive.ts
doctor-runtime-checks.ts
doctor.ts
doctor-types.ts
engine-resolver.ts
engine-types.ts
error-classifier.ts
errors.ts
error-utils.ts
execution-policy.ts
export-html.ts
files.ts
git-constants.ts
gitignore.ts
git-self-heal.ts
git-service.ts
graph.ts
gsd-db.ts
health-widget-core.ts
journal.ts
jsonl-utils.ts
json-persistence.ts
markdown-renderer.ts
marketplace-discovery.ts
md-importer.ts
memory-store.ts
migrate-external.ts
milestone-actions.ts
milestone-ids.ts
milestone-id-utils.ts
milestone-validation-gates.ts
model-cost-table.ts
model-router.ts
namespaced-registry.ts
namespaced-resolver.ts
native-git-bridge.ts
native-parser-bridge.ts
notification-store.ts
notifications.ts
observability-validator.ts
parallel-eligibility.ts
parallel-merge.ts
parallel-orchestrator.ts
parsers-legacy.ts
paths.ts
phase-anchor.ts
plugin-importer.ts
post-execution-checks.ts
post-unit-hooks.ts
pre-execution-checks.ts
preferences-models.ts
preferences-skills.ts
preferences.ts
preferences-types.ts
preferences-validation.ts
preparation.ts
progress-score.ts
prompt-cache-optimizer.ts
prompt-loader.ts
prompt-ordering.ts
prompt-validation.ts
provider-error-pause.ts
queue-order.ts
reactive-graph.ts
repo-identity.ts
reports.ts
roadmap-mutations.ts
roadmap-slices.ts
routing-history.ts
rule-registry.ts
rule-types.ts
run-manager.ts
safe-fs.ts
session-forensics.ts
session-lock.ts
session-status-io.ts
skill-discovery.ts
skill-health.ts
skill-telemetry.ts
slice-parallel-conflict.ts
slice-parallel-eligibility.ts
slice-parallel-orchestrator.ts
state.ts
status-guards.ts
structured-data-formatter.ts
sync-lock.ts
token-counter.ts
triage-resolution.ts
types.ts
unit-id.ts
unit-ownership.ts
unit-runtime.ts
validate-directory.ts
validation.ts
verdict-parser.ts
verification-evidence.ts
verification-gate.ts
visualizer-data.ts
workflow-engine.ts
workflow-events.ts
workflow-logger.ts
workflow-manifest.ts
workflow-migration.ts
workflow-projections.ts
workflow-reconcile.ts
workflow-templates.ts
workspace-index.ts
worktree-health.ts
worktree-manager.ts
worktree-resolver.ts
worktree.ts
write-intercept.ts
```

#### auto/ subdirectory (5):
```
auto/detect-stuck.ts
auto/finalize-timeout.ts
auto/infra-errors.ts
auto/resolve.ts
```

#### bootstrap/ subdirectory (3):
```
bootstrap/sanitize-complete-milestone.ts
bootstrap/tool-call-loop-guard.ts
bootstrap/write-gate.ts
```

#### commands/ subdirectory (1):
```
commands/catalog.ts
```

#### migrate/ subdirectory (7):
```
migrate/index.ts
migrate/parsers.ts
migrate/parser.ts
migrate/preview.ts
migrate/transformer.ts
migrate/types.ts
migrate/validator.ts
migrate/writer.ts
```

#### safety/ subdirectory (7):
```
safety/content-validator.ts
safety/destructive-guard.ts
safety/evidence-collector.ts
safety/evidence-cross-ref.ts
safety/file-change-validator.ts
safety/git-checkpoint.ts
safety/safety-harness.ts
```

#### tools/ subdirectory (12):
```
tools/complete-milestone.ts
tools/complete-slice.ts
tools/complete-task.ts
tools/plan-milestone.ts
tools/plan-slice.ts
tools/plan-task.ts
tools/reassess-roadmap.ts
tools/reopen-milestone.ts
tools/reopen-slice.ts
tools/reopen-task.ts
tools/replan-slice.ts
tools/validate-milestone.ts
```

#### prompts/ directory (all .md files):
Copy the entire `prompts/` directory as-is:
```bash
cp -r $SRC/prompts $DST/prompts
```

#### templates/ directory:
Copy the entire `templates/` directory as-is:
```bash
cp -r $SRC/templates $DST/templates
```

### Step 2: Fix the one pi-mono import in auto-prompts.ts

In `packages/gsd-core/src/auto-prompts.ts`, find:
```typescript
import { getLoadedSkills } from "@gsd/pi-coding-agent";
// or
import type { Skill } from "@gsd/pi-coding-agent";
```

Replace with a local type definition and ensure all usages of `getLoadedSkills()`
are replaced with a `skillsProvider` parameter that gets passed in from callers.

The exact fix depends on what `Skill` looks like and how `getLoadedSkills` is
called. The key constraint: **no imports from `@gsd/pi-coding-agent` in gsd-core**.

### Step 3: Verify no harness imports leaked in

Run this from the repo root:
```bash
grep -r "@gsd/pi-coding-agent\|@gsd/pi-tui\|@gsd/pi-ai" packages/gsd-core/src/ --include="*.ts"
```

This MUST return zero results.

### Step 4: Verify gsd-core compiles

```bash
cd packages/gsd-core && npx tsc --noEmit
```

Fix any import path issues. The copied files use relative imports like
`"./types.js"` and `"../files.js"` which should still work since we preserved
the directory structure. Some files may import from other files that stayed
behind in the harness-coupled set — those imports will fail and indicate files
that need a cross-package import or need to be moved too.

**Expected issues**:
- Some harness-free files may import from harness-coupled files (e.g. a utility
  importing from `auto.ts` which is coupled). These need to be resolved by:
  1. Extracting the specific type/function that's needed into gsd-core
  2. Or adding it to the adapter interface
  3. Or moving the dependency too if it turns out to be harness-free after all

### Step 5: Update index.ts exports

Add key exports to `packages/gsd-core/src/index.ts` as you discover which
types and functions are part of the public API. At minimum:
- Types from `types.ts` (GSDState, etc.)
- Tool handlers from `tools/*.ts`
- State derivation from `state.ts`
- DB operations from `gsd-db.ts`, `db-writer.ts`

### DO NOT

- Do NOT move the 89 harness-coupled files
- Do NOT modify files in `src/resources/extensions/gsd/` — those stay as-is for now
- Do NOT update imports in the extension directory to point to gsd-core yet
- Do NOT add any `@gsd/pi-*` dependencies to gsd-core's package.json
- Do NOT worry about making the full auto-loop work from gsd-core yet — that's Phase 3

### Success criteria

1. All 186 files + prompts/ + templates/ copied to `packages/gsd-core/src/`
2. Zero grep hits for `@gsd/pi-coding-agent`, `@gsd/pi-tui`, or `@gsd/pi-ai` in `packages/gsd-core/src/`
3. `npx tsc --noEmit` in `packages/gsd-core/` passes (or has only cross-package import errors from coupled files, which is expected and documented)
4. No changes to `src/resources/extensions/gsd/` (original files untouched)
