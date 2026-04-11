/**
 * MCP Server types — shared types for unit-tools server and readers.
 */

// ---------------------------------------------------------------------------
// Session Status
// ---------------------------------------------------------------------------

export type SessionStatus = 'starting' | 'running' | 'blocked' | 'completed' | 'error' | 'cancelled';

// ---------------------------------------------------------------------------
// Cost Accumulator (K004 — cumulative-max)
// ---------------------------------------------------------------------------

export interface CostAccumulator {
  totalCost: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

// ---------------------------------------------------------------------------
// Execute Options
// ---------------------------------------------------------------------------

export interface ExecuteOptions {
  /** Command to send after '/wtf auto' (default: none) */
  command?: string;

  /** Model ID override */
  model?: string;

  /** Run in bare mode (skip user config) */
  bare?: boolean;

  /** Path to CLI binary (overrides WTF_CLI_PATH and which resolution) */
  cliPath?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of events kept in the ring buffer */
export const MAX_EVENTS = 50;

/** Timeout for RpcClient initialization (ms) */
export const INIT_TIMEOUT_MS = 30_000;
