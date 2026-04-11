// Tool input parameter types: boundary DTOs for MCP tool calls.
// These live in the adapter/tools layer, NOT domain — they represent
// the shape of data crossing the MCP boundary.

// ─── Complete Task Params (wtf_complete_task tool input) ─────────────────

export interface CompleteTaskParams {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  oneLiner: string;
  narrative: string;
  verification: string;
  /** @optional — defaults to [] when omitted by models with limited tool-calling */
  keyFiles?: string[];
  /** @optional — defaults to [] when omitted by models with limited tool-calling */
  keyDecisions?: string[];
  /** @optional — defaults to "None." when omitted */
  deviations?: string;
  /** @optional — defaults to "None." when omitted */
  knownIssues?: string;
  /** @optional — defaults to false when omitted */
  blockerDiscovered?: boolean;
  /** @optional — defaults to [] when omitted by models with limited tool-calling */
  verificationEvidence?: Array<{
    command: string;
    exitCode: number;
    verdict: string;
    durationMs: number;
  }>;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

// ─── Complete Slice Params (wtf_complete_slice tool input) ───────────────

export interface CompleteSliceParams {
  sliceId: string;
  milestoneId: string;
  sliceTitle: string;
  oneLiner: string;
  narrative: string;
  verification: string;
  uatContent: string;
  /** @optional — defaults to [] when omitted by models with limited tool-calling */
  keyFiles?: string[];
  /** @optional — defaults to [] when omitted */
  keyDecisions?: string[];
  /** @optional — defaults to [] when omitted */
  patternsEstablished?: string[];
  /** @optional — defaults to [] when omitted */
  observabilitySurfaces?: string[];
  /** @optional — defaults to "None." when omitted */
  deviations?: string;
  /** @optional — defaults to "None." when omitted */
  knownLimitations?: string;
  /** @optional — defaults to "None." when omitted */
  followUps?: string;
  /** @optional — defaults to [] when omitted */
  requirementsAdvanced?: Array<{ id: string; how: string }>;
  /** @optional — defaults to [] when omitted */
  requirementsValidated?: Array<{ id: string; proof: string }>;
  /** @optional — defaults to [] when omitted */
  requirementsSurfaced?: string[];
  /** @optional — defaults to [] when omitted */
  requirementsInvalidated?: Array<{ id: string; what: string }>;
  /** @optional — defaults to [] when omitted */
  filesModified?: Array<{ path: string; description: string }>;
  /** @optional — defaults to [] when omitted */
  provides?: string[];
  /** @optional — defaults to [] when omitted */
  requires?: Array<{ slice: string; provides: string }>;
  /** @optional — defaults to [] when omitted */
  affects?: string[];
  /** @optional — defaults to [] when omitted */
  drillDownPaths?: string[];
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}
