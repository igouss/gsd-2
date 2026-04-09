/**
 * metrics.ts — Harness-free metrics types and utilities.
 *
 * The full metrics module in pi-mono depends on ExtensionContext for
 * session entry scanning. This file extracts the types and pure functions
 * that gsd-core files actually import.
 */

import { join } from "node:path";
import { gsdRoot } from "../persistence/paths.js";
import { loadJsonFileOrNull } from "../persistence/json-persistence.js";
import { parseUnitId } from "../domain/unit-id.js";

// Re-export from shared
export { formatTokenCount } from '../shared/format-utils.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UnitMetrics {
  type: string;
  id: string;
  model: string;
  startedAt: number;
  finishedAt: number;
  tokens: TokenCounts;
  cost: number;
  toolCalls: number;
  assistantMessages: number;
  userMessages: number;
  apiRequests?: number;
  contextWindowTokens?: number;
  truncationSections?: number;
  continueHereFired?: boolean;
  promptCharCount?: number;
  baselineCharCount?: number;
  tier?: string;
  modelDowngraded?: boolean;
  skills?: string[];
  cacheHitRate?: number;
  compressionSavings?: number;
}

export interface BudgetInfo {
  contextWindowTokens?: number;
  truncationSections?: number;
  continueHereFired?: boolean;
}

export interface MetricsLedger {
  version: 1;
  projectStartedAt: number;
  units: UnitMetrics[];
}

export type MetricsPhase = "research" | "discussion" | "planning" | "execution" | "completion" | "reassessment";

export function classifyUnitPhase(unitType: string): MetricsPhase {
  switch (unitType) {
    case "research-milestone":
    case "research-slice":
      return "research";
    case "discuss-milestone":
    case "discuss-slice":
      return "discussion";
    case "plan-milestone":
    case "plan-slice":
      return "planning";
    case "execute-task":
      return "execution";
    case "complete-slice":
      return "completion";
    case "reassess-roadmap":
      return "reassessment";
    default:
      return "execution";
  }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function formatCost(cost: number): string {
  const n = Number(cost) || 0;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

// ─── Disk I/O ────────────────────────────────────────────────────────────────

function metricsPath(base: string): string {
  return join(gsdRoot(base), "metrics.json");
}

function isMetricsLedger(data: unknown): data is MetricsLedger {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as MetricsLedger).version === 1 &&
    Array.isArray((data as MetricsLedger).units)
  );
}

export function loadLedgerFromDisk(base: string): MetricsLedger | null {
  return loadJsonFileOrNull(metricsPath(base), isMetricsLedger);
}

export function pruneMetricsLedger(_base: string, _keepCount: number): number {
  // Stub — real implementation prunes in-memory + on-disk ledger
  return 0;
}

// ─── In-memory state (stub — real impl has module-level ledger) ──────────────

let ledger: MetricsLedger | null = null;

export function getLedger(): MetricsLedger | null {
  return ledger;
}

// ─── Aggregate types ─────────────────────────────────────────────────────────

export interface PhaseAggregate {
  phase: MetricsPhase;
  units: number;
  tokens: TokenCounts;
  cost: number;
  duration: number;
}

export interface SliceAggregate {
  sliceId: string;
  units: number;
  tokens: TokenCounts;
  cost: number;
  duration: number;
}

export interface ModelAggregate {
  model: string;
  units: number;
  tokens: TokenCounts;
  cost: number;
  contextWindowTokens?: number;
}

export interface ProjectTotals {
  units: number;
  tokens: TokenCounts;
  cost: number;
  duration: number;
  toolCalls: number;
  assistantMessages: number;
  userMessages: number;
  apiRequests: number;
  totalTruncationSections: number;
  continueHereFiredCount: number;
}

export interface TierAggregate {
  tier: string;
  units: number;
  tokens: TokenCounts;
  cost: number;
  downgraded: number;
}

// ─── Aggregation helpers ─────────────────────────────────────────────────────

function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}

export function aggregateByPhase(units: UnitMetrics[]): PhaseAggregate[] {
  const map = new Map<MetricsPhase, PhaseAggregate>();
  for (const u of units) {
    const phase = classifyUnitPhase(u.type);
    let agg = map.get(phase);
    if (!agg) {
      agg = { phase, units: 0, tokens: emptyTokens(), cost: 0, duration: 0 };
      map.set(phase, agg);
    }
    agg.units++;
    agg.tokens = addTokens(agg.tokens, u.tokens);
    agg.cost += u.cost;
    agg.duration += u.finishedAt - u.startedAt;
  }
  const order: MetricsPhase[] = ["research", "discussion", "planning", "execution", "completion", "reassessment"];
  return order.map(p => map.get(p)).filter((a): a is PhaseAggregate => !!a);
}

export function aggregateBySlice(units: UnitMetrics[]): SliceAggregate[] {
  const map = new Map<string, SliceAggregate>();
  for (const u of units) {
    const { milestone, slice } = parseUnitId(u.id);
    const sliceId = slice ? `${milestone}/${slice}` : milestone;
    let agg = map.get(sliceId);
    if (!agg) {
      agg = { sliceId, units: 0, tokens: emptyTokens(), cost: 0, duration: 0 };
      map.set(sliceId, agg);
    }
    agg.units++;
    agg.tokens = addTokens(agg.tokens, u.tokens);
    agg.cost += u.cost;
    agg.duration += u.finishedAt - u.startedAt;
  }
  return Array.from(map.values()).sort((a, b) => a.sliceId.localeCompare(b.sliceId));
}

export function aggregateByModel(units: UnitMetrics[]): ModelAggregate[] {
  const map = new Map<string, ModelAggregate>();
  for (const u of units) {
    let agg = map.get(u.model);
    if (!agg) {
      agg = { model: u.model, units: 0, tokens: emptyTokens(), cost: 0 };
      map.set(u.model, agg);
    }
    agg.units++;
    agg.tokens = addTokens(agg.tokens, u.tokens);
    agg.cost += u.cost;
    if (u.contextWindowTokens !== undefined && agg.contextWindowTokens === undefined) {
      agg.contextWindowTokens = u.contextWindowTokens;
    }
  }
  return Array.from(map.values()).sort((a, b) => b.cost - a.cost);
}

export function getProjectTotals(units: UnitMetrics[]): ProjectTotals {
  const totals: ProjectTotals = {
    units: units.length,
    tokens: emptyTokens(),
    cost: 0,
    duration: 0,
    toolCalls: 0,
    assistantMessages: 0,
    userMessages: 0,
    apiRequests: 0,
    totalTruncationSections: 0,
    continueHereFiredCount: 0,
  };
  for (const u of units) {
    totals.tokens = addTokens(totals.tokens, u.tokens);
    totals.cost += u.cost;
    totals.duration += u.finishedAt - u.startedAt;
    totals.toolCalls += u.toolCalls;
    totals.assistantMessages += u.assistantMessages;
    totals.userMessages += u.userMessages;
    totals.apiRequests += u.apiRequests ?? u.assistantMessages;
    totals.totalTruncationSections += u.truncationSections ?? 0;
    if (u.continueHereFired) totals.continueHereFiredCount++;
  }
  return totals;
}

export function aggregateByTier(units: UnitMetrics[]): TierAggregate[] {
  const map = new Map<string, TierAggregate>();
  for (const u of units) {
    const tier = u.tier ?? "unknown";
    let agg = map.get(tier);
    if (!agg) {
      agg = { tier, units: 0, tokens: emptyTokens(), cost: 0, downgraded: 0 };
      map.set(tier, agg);
    }
    agg.units++;
    agg.tokens = addTokens(agg.tokens, u.tokens);
    agg.cost += u.cost;
    if (u.modelDowngraded) agg.downgraded++;
  }
  const order = ["light", "standard", "heavy", "unknown"];
  return order.map(t => map.get(t)).filter((a): a is TierAggregate => !!a);
}

export function formatTierSavings(units: UnitMetrics[]): string {
  const downgraded = units.filter(u => u.modelDowngraded);
  if (downgraded.length === 0) return "";
  const downgradedCost = downgraded.reduce((sum, u) => sum + u.cost, 0);
  const totalUnits = units.filter(u => u.tier).length;
  const pct = totalUnits > 0 ? Math.round((downgraded.length / totalUnits) * 100) : 0;
  return `Dynamic routing: ${downgraded.length}/${totalUnits} units downgraded (${pct}%), cost: ${formatCost(downgradedCost)}`;
}
