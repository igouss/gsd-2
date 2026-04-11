/**
 * WTF branch naming patterns — single source of truth.
 *
 * wtf/<worktree>/<milestone>/<slice>  → SLICE_BRANCH_RE
 * wtf/quick/<id>-<slug>               → QUICK_BRANCH_RE
 * wtf/<workflow>/<...>                 → WORKFLOW_BRANCH_RE (non-milestone wtf/ branches)
 */

/** Matches wtf/ slice branches: wtf/[worktree/]M001[-hash]/S01 */
export const SLICE_BRANCH_RE: RegExp = /^wtf\/(?:([a-zA-Z0-9_-]+)\/)?(M\d+(?:-[a-z0-9]{6})?)\/(S\d+)$/;

/** Matches wtf/quick/ task branches */
export const QUICK_BRANCH_RE: RegExp = /^wtf\/quick\//;

/** Matches wtf/ workflow branches (non-milestone, e.g. wtf/workflow-name/...) */
export const WORKFLOW_BRANCH_RE: RegExp = /^wtf\/(?!M\d)[\w-]+\//;
