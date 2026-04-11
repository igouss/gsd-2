/**
 * @igouss/mcp-server — MCP server exposing WTF state-mutation tools.
 *
 * The interactive session server (SessionManager, createMcpServer) depends on
 * @igouss/rpc-client which is not available in this repo. Those modules
 * have been removed. This package now exports only the unit-tools server
 * and read-only state readers.
 */

export { createUnitToolsServer } from './unit-tools-server.ts';
export type {
  SessionStatus,
  ExecuteOptions,
  CostAccumulator,
} from './types.ts';
export { MAX_EVENTS, INIT_TIMEOUT_MS } from './types.ts';

// Read-only state readers (usable without a running session)
export { readProgress } from './readers/state.ts';
export type { ProgressResult } from './readers/state.ts';
export { readRoadmap } from './readers/roadmap.ts';
export type { RoadmapResult, MilestoneInfo, SliceInfo, TaskInfo } from './readers/roadmap.ts';
export { readHistory } from './readers/metrics.ts';
export type { HistoryResult, MetricsUnit } from './readers/metrics.ts';
export { readCaptures } from './readers/captures.ts';
export type { CapturesResult, CaptureEntry } from './readers/captures.ts';
export { readKnowledge } from './readers/knowledge.ts';
export type { KnowledgeResult, KnowledgeEntry } from './readers/knowledge.ts';
export { runDoctorLite } from './readers/doctor-lite.ts';
export type { DoctorResult, DoctorIssue } from './readers/doctor-lite.ts';
