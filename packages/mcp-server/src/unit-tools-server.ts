/**
 * unit-tools-server.ts — MCP server exposing WTF state-mutation tools for
 * executing agents. This is the tool server that runs alongside the
 * orchestrator and provides agents with the ability to mutate WTF state
 * (complete tasks, save decisions, plan slices, etc.).
 *
 * Unlike the session-management server (server.ts), this server is
 * "unit-scoped" — it operates on a fixed project directory and exposes
 * tools that modify .wtf/ state directly. The executing agent (Claude Code,
 * pi-mono, or any MCP-capable harness) connects to this server via the
 * mcpConfigPath passed in UnitDispatchRequest.
 *
 * Tool handlers are imported from @gsd-build/gsd-core — pure functions
 * with zero harness dependencies.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_PKG = '@modelcontextprotocol/sdk';
const SERVER_NAME = 'wtf-unit-tools';
const SERVER_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// MCP Server type (same as server.ts — dynamic import workaround)
// ---------------------------------------------------------------------------

interface McpServerInstance {
  tool(
    name: string,
    description: string,
    params: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): unknown;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

function jsonContent(
  data: unknown,
): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorContent(
  message: string,
): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

// ---------------------------------------------------------------------------
// Imports from gsd-core — pure handler functions with zero harness deps.
// Using static imports since gsd-core is a workspace dependency.
// ---------------------------------------------------------------------------

import {
  handleCompleteTask,
  handleCompleteSlice,
  handleCompleteMilestone,
  handlePlanMilestone,
  handlePlanSlice,
  handlePlanTask,
  handleReplanSlice,
  handleReassessRoadmap,
  handleReopenTask,
  handleReopenSlice,
  handleReopenMilestone,
  handleValidateMilestone,
  saveDecisionToDb,
  saveRequirementToDb,
  updateRequirementInDb,
  saveArtifactToDb,
  updateSliceStatus,
  saveGateResult,
  deriveState,
  nextMilestoneId,
  findMilestoneIds,
  queryJournal,
} from '@gsd-build/gsd-core';

// ---------------------------------------------------------------------------
// Generic tool handler wrapper
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function wrapHandler(
  projectDir: string,
  fn: (args: Record<string, unknown>, basePath: string) => Promise<unknown>,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    try {
      const result = await fn(args, projectDir);
      if (result && typeof result === 'object' && 'error' in result) {
        return errorContent((result as { error: string }).error);
      }
      return jsonContent(result);
    } catch (err) {
      return errorContent(err instanceof Error ? err.message : String(err));
    }
  };
}

// ---------------------------------------------------------------------------
// createUnitToolsServer
// ---------------------------------------------------------------------------

/**
 * Create an MCP server with WTF state-mutation tools scoped to a project dir.
 *
 * The projectDir is baked in at creation time — all tool calls operate on that
 * directory. This is the server that executing agents connect to via mcpConfigPath.
 */
export async function createUnitToolsServer(projectDir: string): Promise<{
  server: McpServerInstance;
}> {
  const mcpMod = await import(`${MCP_PKG}/server/mcp.js`);
  const McpServer = mcpMod.McpServer;

  const server: McpServerInstance = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // Static imports — no lazy loading needed

  // =====================================================================
  // Shared schemas (reused by aliases)
  // =====================================================================

  const taskCompleteSchema = {
    taskId: z.string().describe('Task ID (e.g. "T1")'),
    sliceId: z.string().describe('Slice ID (e.g. "S1")'),
    milestoneId: z.string().describe('Milestone ID (e.g. "M1")'),
    oneLiner: z.string().describe('One-line summary of what was accomplished'),
    narrative: z.string().describe('Detailed narrative of the work done'),
    verification: z.string().describe('Verification result — what was tested and how'),
    keyFiles: z.array(z.string()).optional().describe('Key files modified'),
    keyDecisions: z.array(z.string()).optional().describe('Key decisions made during execution'),
    deviations: z.string().optional().describe('Deviations from the plan (default: "None.")'),
    knownIssues: z.string().optional().describe('Known issues (default: "None.")'),
    blockerDiscovered: z.boolean().optional().describe('Whether a blocker was discovered'),
    verificationEvidence: z.array(z.object({
      command: z.string(),
      exitCode: z.number(),
      verdict: z.string(),
      durationMs: z.number(),
    })).optional().describe('Structured verification evidence from test runs'),
  };
  const taskCompleteHandler = wrapHandler(projectDir, async (args, basePath) => {
    return handleCompleteTask(args as any, basePath);
  });

  // =====================================================================
  // TASK LIFECYCLE
  // =====================================================================

  server.tool(
    'wtf_task_complete',
    'Mark a task as complete with summary, narrative, and verification evidence. This is the primary way agents report task completion.',
    taskCompleteSchema,
    taskCompleteHandler,
  );

  server.tool(
    'wtf_complete_task',
    'Alias for wtf_task_complete.',
    taskCompleteSchema,
    taskCompleteHandler,
  );

  server.tool(
    'wtf_reopen_task',
    'Reopen a previously completed task so it can be re-executed.',
    {
      taskId: z.string().describe('Task ID'),
      sliceId: z.string().describe('Slice ID'),
      milestoneId: z.string().describe('Milestone ID'),
      reason: z.string().describe('Why the task needs to be reopened'),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      return handleReopenTask(args as any, basePath);
    }),
  );

  // =====================================================================
  // SLICE LIFECYCLE
  // =====================================================================

  server.tool(
    'wtf_slice_complete',
    'Mark a slice as complete with summary, UAT content, and requirement tracking. All tasks in the slice should be complete before calling this.',
    {
      sliceId: z.string().describe('Slice ID'),
      milestoneId: z.string().describe('Milestone ID'),
      sliceTitle: z.string().describe('Human-readable slice title'),
      oneLiner: z.string().describe('One-line summary'),
      narrative: z.string().describe('Detailed narrative'),
      verification: z.string().describe('Verification summary'),
      uatContent: z.string().describe('User acceptance test content'),
      keyFiles: z.array(z.string()).optional().describe('Key files modified'),
      keyDecisions: z.array(z.string()).optional().describe('Key decisions'),
      patternsEstablished: z.array(z.string()).optional().describe('Patterns established'),
      deviations: z.string().optional().describe('Deviations from plan'),
      knownLimitations: z.string().optional().describe('Known limitations'),
      followUps: z.string().optional().describe('Follow-up items'),
      requirementsAdvanced: z.array(z.object({ id: z.string(), how: z.string() })).optional(),
      requirementsValidated: z.array(z.object({ id: z.string(), proof: z.string() })).optional(),
      requirementsSurfaced: z.array(z.string()).optional(),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      return handleCompleteSlice(args as any, basePath);
    }),
  );

  server.tool(
    'wtf_reopen_slice',
    'Reopen a previously completed slice so it can be re-executed.',
    {
      sliceId: z.string().describe('Slice ID'),
      milestoneId: z.string().describe('Milestone ID'),
      reason: z.string().describe('Why the slice needs to be reopened'),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      return handleReopenSlice(args as any, basePath);
    }),
  );

  // =====================================================================
  // MILESTONE LIFECYCLE
  // =====================================================================

  const completeMilestoneSchema = {
    milestoneId: z.string().describe('Milestone ID'),
    title: z.string().describe('Milestone title'),
    oneLiner: z.string().describe('One-line summary of the milestone'),
    narrative: z.string().describe('Detailed completion narrative'),
    verificationPassed: z.boolean().describe('Whether all verification checks passed'),
    successCriteriaResults: z.string().optional().describe('Results of success criteria checks'),
    definitionOfDoneResults: z.string().optional().describe('Results of definition-of-done checks'),
    requirementOutcomes: z.string().optional().describe('How requirements were addressed'),
    keyDecisions: z.array(z.string()).optional().describe('Key decisions made during milestone'),
    keyFiles: z.array(z.string()).optional().describe('Key files created or modified'),
    lessonsLearned: z.array(z.string()).optional().describe('Lessons learned'),
    followUps: z.string().optional().describe('Follow-up items'),
  };
  const completeMilestoneHandler = wrapHandler(projectDir, async (args, basePath) => {
    return handleCompleteMilestone(args as any, basePath);
  });

  server.tool('wtf_complete_milestone', 'Mark a milestone as complete. All slices should be complete before calling this.', completeMilestoneSchema, completeMilestoneHandler);
  server.tool('wtf_milestone_complete', 'Alias for wtf_complete_milestone.', completeMilestoneSchema, completeMilestoneHandler);

  const validateMilestoneSchema = {
    milestoneId: z.string().describe('Milestone ID'),
    verdict: z.enum(["pass", "needs-attention", "needs-remediation"]).describe('Validation verdict'),
    remediationRound: z.number().describe('Remediation round number (1 for first validation)'),
    successCriteriaChecklist: z.string().describe('Checklist of success criteria and their status'),
    sliceDeliveryAudit: z.string().describe('Audit of each slice delivery status'),
    crossSliceIntegration: z.string().describe('Assessment of cross-slice integration'),
    requirementCoverage: z.string().describe('How requirements are covered'),
    verdictRationale: z.string().describe('Rationale for the verdict'),
    verificationClasses: z.string().optional().describe('Classification of verification evidence'),
    remediationPlan: z.string().optional().describe('Plan for fixing issues (if verdict is not pass)'),
  };
  const validateMilestoneHandler = wrapHandler(projectDir, async (args, basePath) => {
    return handleValidateMilestone(args as any, basePath);
  });

  server.tool('wtf_validate_milestone', 'Write a milestone validation report.', validateMilestoneSchema, validateMilestoneHandler);
  server.tool('wtf_milestone_validate', 'Alias for wtf_validate_milestone.', validateMilestoneSchema, validateMilestoneHandler);

  server.tool(
    'wtf_reopen_milestone',
    'Reopen a previously completed milestone.',
    {
      milestoneId: z.string().describe('Milestone ID'),
      reason: z.string().describe('Why the milestone needs to be reopened'),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      return handleReopenMilestone(args as any, basePath);
    }),
  );

  // =====================================================================
  // PLANNING
  // =====================================================================

  server.tool(
    'wtf_plan_milestone',
    'Plan a milestone with a structured roadmap of slices. Creates directory structure and ROADMAP.md.',
    {
      milestoneId: z.string().describe('Milestone ID (e.g. "M001")'),
      title: z.string().describe('Milestone title'),
      vision: z.string().describe('High-level vision for the milestone'),
      slices: z.array(z.object({
        sliceId: z.string().describe('Slice ID (e.g. "S01")'),
        title: z.string().describe('Slice title'),
        goal: z.string().describe('What this slice achieves'),
        risk: z.string().describe('Risk level: low/medium/high'),
        depends: z.array(z.string()).describe('Slice IDs this depends on'),
        demo: z.string().describe('How to demo this slice'),
        successCriteria: z.string().describe('How to know this slice is done'),
        proofLevel: z.string().describe('Evidence required: tests/manual/review'),
        integrationClosure: z.string().describe('How this integrates with other slices'),
        observabilityImpact: z.string().describe('Logging/monitoring impact'),
      })).describe('Array of slices in execution order'),
      successCriteria: z.array(z.string()).optional().describe('Milestone-level success criteria'),
      keyRisks: z.array(z.object({ risk: z.string(), whyItMatters: z.string() })).optional(),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      return handlePlanMilestone(args as any, basePath);
    }),
  );

  server.tool(
    'wtf_plan_slice',
    'Plan a slice with a structured task breakdown. Creates PLAN.md and task entries in the DB.',
    {
      milestoneId: z.string().describe('Milestone ID (e.g. "M001")'),
      sliceId: z.string().describe('Slice ID (e.g. "S01")'),
      goal: z.string().describe('What this slice achieves'),
      tasks: z.array(z.object({
        taskId: z.string().describe('Task ID (e.g. "T1")'),
        title: z.string().describe('Task title'),
        description: z.string().describe('What needs to be done'),
        estimate: z.string().describe('Time estimate (e.g. "15 min", "1 hour")'),
        files: z.array(z.string()).describe('Files to create or modify'),
        verify: z.string().describe('How to verify this task is done'),
        inputs: z.array(z.string()).optional().describe('Input dependencies'),
        expectedOutput: z.array(z.string()).optional().describe('Expected outputs/artifacts'),
      })).describe('Array of tasks in execution order'),
      successCriteria: z.string().optional().describe('Slice-level success criteria'),
      proofLevel: z.string().optional().describe('Evidence required: tests/manual/review'),
      integrationClosure: z.string().optional().describe('How this integrates with other slices'),
      observabilityImpact: z.string().optional().describe('Logging/monitoring impact'),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      return handlePlanSlice(args as any, basePath);
    }),
  );

  server.tool(
    'wtf_plan_task',
    'Write a detailed task plan. Creates TASK-PLAN.md in the task directory.',
    {
      milestoneId: z.string().describe('Milestone ID'),
      sliceId: z.string().describe('Slice ID'),
      taskId: z.string().describe('Task ID'),
      title: z.string().describe('Task title'),
      description: z.string().describe('Detailed description of what needs to be done'),
      estimate: z.string().describe('Time estimate'),
      files: z.array(z.string()).describe('Files to create or modify'),
      verify: z.string().describe('How to verify this task is done'),
      inputs: z.array(z.string()).optional().describe('Input dependencies'),
      expectedOutput: z.array(z.string()).optional().describe('Expected outputs/artifacts'),
      observabilityImpact: z.string().optional().describe('Logging/monitoring impact'),
      fullPlanMd: z.string().optional().describe('Full markdown plan content (overrides structured fields for rendering)'),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      return handlePlanTask(args as any, basePath);
    }),
  );

  const replanSliceSchema = {
    milestoneId: z.string().describe('Milestone ID'),
    sliceId: z.string().describe('Slice ID'),
    reason: z.string().describe('Why the slice needs replanning'),
    goal: z.string().describe('Updated goal'),
    tasks: z.array(z.object({
      taskId: z.string().describe('Task ID'),
      title: z.string().describe('Task title'),
      description: z.string().describe('What needs to be done'),
      estimate: z.string().describe('Time estimate'),
      files: z.array(z.string()).describe('Files to create or modify'),
      verify: z.string().describe('How to verify'),
    })).describe('New task breakdown'),
  };
  const replanSliceHandler = wrapHandler(projectDir, async (args, basePath) => {
    return handleReplanSlice(args as any, basePath);
  });

  server.tool('wtf_replan_slice', 'Rewrite a slice plan with a new task breakdown.', replanSliceSchema, replanSliceHandler);
  server.tool('wtf_slice_replan', 'Alias for wtf_replan_slice.', replanSliceSchema, replanSliceHandler);

  const reassessRoadmapSchema = {
    milestoneId: z.string().describe('Milestone ID'),
    reason: z.string().describe('Why the roadmap needs reassessment'),
    title: z.string().describe('Updated milestone title'),
    vision: z.string().describe('Updated vision'),
    slices: z.array(z.object({
      sliceId: z.string().describe('Slice ID'),
      title: z.string().describe('Slice title'),
      goal: z.string().describe('What this slice achieves'),
      risk: z.string().describe('Risk level'),
      depends: z.array(z.string()).describe('Dependencies'),
      demo: z.string().describe('How to demo'),
      successCriteria: z.string().describe('Success criteria'),
      proofLevel: z.string().describe('Proof level'),
      integrationClosure: z.string().describe('Integration notes'),
      observabilityImpact: z.string().describe('Observability impact'),
    })).describe('New slice breakdown'),
  };
  const reassessRoadmapHandler = wrapHandler(projectDir, async (args, basePath) => {
    return handleReassessRoadmap(args as any, basePath);
  });

  server.tool('wtf_reassess_roadmap', 'Reassess and rewrite the milestone roadmap.', reassessRoadmapSchema, reassessRoadmapHandler);
  server.tool('wtf_roadmap_reassess', 'Alias for wtf_reassess_roadmap.', reassessRoadmapSchema, reassessRoadmapHandler);

  // =====================================================================
  // DECISIONS & REQUIREMENTS
  // =====================================================================

  server.tool(
    'wtf_decision_save',
    'Save a technical decision to the WTF database. Decisions track architectural choices and their rationale.',
    {
      scope: z.string().describe('Scope: "project", "milestone", or "slice"'),
      decision: z.string().describe('What was decided'),
      choice: z.string().describe('The chosen option'),
      rationale: z.string().describe('Why this choice was made'),
      revisable: z.string().optional().describe('Whether this decision can be revisited — "true" or "false" (default: "true")'),
      when_context: z.string().optional().describe('Context for when to revisit'),
      made_by: z.string().optional().describe('Who made the decision — "agent" or "human"'),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      return saveDecisionToDb(
        {
          scope: args.scope as string,
          decision: args.decision as string,
          choice: args.choice as string,
          rationale: args.rationale as string,
          revisable: args.revisable as string | undefined,
          when_context: args.when_context as string | undefined,
          made_by: args.made_by as "agent" | "human" | undefined,
        },
        basePath,
      );
    }),
  );

  server.tool(
    'wtf_requirement_save',
    'Save a new requirement to the WTF database.',
    {
      class: z.string().describe('Requirement class (e.g. "functional", "non-functional", "constraint")'),
      description: z.string().describe('Detailed description of the requirement'),
      why: z.string().describe('Why this requirement exists'),
      source: z.string().describe('Where this requirement came from'),
      status: z.string().optional().describe('Initial status (default: "active")'),
      primary_owner: z.string().optional().describe('Primary owner milestone/slice'),
      supporting_slices: z.string().optional().describe('Supporting slices'),
      validation: z.string().optional().describe('How to validate this requirement'),
      notes: z.string().optional().describe('Additional notes'),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      return saveRequirementToDb(
        {
          class: args.class as string,
          description: args.description as string,
          why: args.why as string,
          source: args.source as string,
          status: args.status as string | undefined,
          primary_owner: args.primary_owner as string | undefined,
          supporting_slices: args.supporting_slices as string | undefined,
          validation: args.validation as string | undefined,
          notes: args.notes as string | undefined,
        },
        basePath,
      );
    }),
  );

  server.tool(
    'wtf_requirement_update',
    'Update an existing requirement status or details.',
    {
      id: z.string().describe('Requirement ID (e.g. "R001")'),
      status: z.string().optional().describe('New status'),
      notes: z.string().optional().describe('Update notes'),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      const id = args.id as string;
      const updates: Record<string, unknown> = {};
      if (args.status) updates.status = args.status;
      if (args.notes) updates.notes = args.notes;
      return updateRequirementInDb(id, updates as any, basePath);
    }),
  );

  // =====================================================================
  // READ-ONLY TOOLS (state queries for the executing agent)
  // =====================================================================

  server.tool(
    'wtf_progress',
    'Get structured project progress: active milestone/slice/task, phase, completion counts, and next action.',
    {
      // No params — uses the server's projectDir
    },
    async () => {
      try {
        const { readProgress } = await import('./readers/state.ts');
        const result = await readProgress(projectDir);
        return jsonContent(result);
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    'wtf_roadmap',
    'Get the full roadmap structure: milestones, slices, tasks with their statuses.',
    {
      // No params
    },
    async () => {
      try {
        const { readRoadmap } = await import('./readers/roadmap.ts');
        const result = await readRoadmap(projectDir);
        return jsonContent(result);
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    'wtf_knowledge',
    'Get project knowledge entries (decisions, requirements, captures).',
    {
      // No params
    },
    async () => {
      try {
        const { readKnowledge } = await import('./readers/knowledge.ts');
        const result = await readKnowledge(projectDir);
        return jsonContent(result);
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // =====================================================================
  // ALIAS: wtf_complete_slice → wtf_slice_complete
  // Some prompts reference wtf_complete_slice, server registers wtf_slice_complete.
  // Register the alias so agents using either name succeed.
  // =====================================================================

  server.tool(
    'wtf_complete_slice',
    'Alias for wtf_slice_complete — mark a slice as complete.',
    {
      sliceId: z.string().describe('Slice ID'),
      milestoneId: z.string().describe('Milestone ID'),
      sliceTitle: z.string().describe('Human-readable slice title'),
      oneLiner: z.string().describe('One-line summary'),
      narrative: z.string().describe('Detailed narrative'),
      verification: z.string().describe('Verification summary'),
      uatContent: z.string().describe('User acceptance test content'),
      keyFiles: z.array(z.string()).optional().describe('Key files modified'),
      keyDecisions: z.array(z.string()).optional().describe('Key decisions'),
      patternsEstablished: z.array(z.string()).optional().describe('Patterns established'),
      deviations: z.string().optional().describe('Deviations from plan'),
      knownLimitations: z.string().optional().describe('Known limitations'),
      followUps: z.string().optional().describe('Follow-up items'),
      requirementsAdvanced: z.array(z.object({ id: z.string(), how: z.string() })).optional(),
      requirementsValidated: z.array(z.object({ id: z.string(), proof: z.string() })).optional(),
      requirementsSurfaced: z.array(z.string()).optional(),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      return handleCompleteSlice(args as any, basePath);
    }),
  );

  // =====================================================================
  // ARTIFACT PERSISTENCE — wtf_summary_save
  // =====================================================================

  server.tool(
    'wtf_summary_save',
    'Save a WTF artifact (CONTEXT, RESEARCH, SUMMARY, ASSESSMENT, etc.) to both disk and database. ' +
    'Computes the file path from milestone/slice/task IDs and artifact_type. ' +
    'This is the primary way agents persist research, context, summaries, and other structured markdown.',
    {
      milestone_id: z.string().describe('Milestone ID (e.g. "M001")'),
      artifact_type: z.string().describe('Artifact type: CONTEXT, RESEARCH, SUMMARY, ASSESSMENT, CONTEXT-DRAFT, UAT, etc.'),
      content: z.string().describe('Full markdown content to persist'),
      slice_id: z.string().optional().describe('Slice ID (e.g. "S01") — required for slice/task artifacts'),
      task_id: z.string().optional().describe('Task ID (e.g. "T1") — required for task artifacts'),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      const milestoneId = args.milestone_id as string;
      const artifactType = args.artifact_type as string;
      const content = args.content as string;
      const sliceId = args.slice_id as string | undefined;
      const taskId = args.task_id as string | undefined;

      // Compute the relative path within .wtf/
      let path: string;
      if (taskId && sliceId) {
        path = `milestones/${milestoneId}/slices/${sliceId}/tasks/${sliceId}${taskId}-${artifactType}.md`;
      } else if (sliceId) {
        path = `milestones/${milestoneId}/slices/${sliceId}/${sliceId}-${artifactType}.md`;
      } else {
        path = `milestones/${milestoneId}/${milestoneId}-${artifactType}.md`;
      }

      await saveArtifactToDb(
        { path, artifact_type: artifactType, content, milestone_id: milestoneId, slice_id: sliceId, task_id: taskId },
        basePath,
      );
      return { saved: true, path: `.wtf/${path}` };
    }),
  );

  // =====================================================================
  // MILESTONE ID GENERATION — wtf_milestone_generate_id
  // =====================================================================

  server.tool(
    'wtf_milestone_generate_id',
    'Generate the next milestone ID. Scans existing milestone directories and returns the next sequential ID. ' +
    'Never invent milestone IDs manually — always use this tool.',
    {
      // No params — scans the project directory
    },
    wrapHandler(projectDir, async (_args, basePath) => {
      const existingIds = findMilestoneIds(basePath);
      const newId = nextMilestoneId(existingIds);
      return { milestoneId: newId, existingIds };
    }),
  );

  // =====================================================================
  // MILESTONE STATUS QUERY — wtf_milestone_status
  // =====================================================================

  server.tool(
    'wtf_milestone_status',
    'Get structured milestone and slice status from the database. ' +
    'Use this instead of direct DB access for reading project state.',
    {
      milestoneId: z.string().optional().describe('Filter to a specific milestone (omit for all milestones)'),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      const state = await deriveState(basePath);
      const milestoneId = args.milestoneId as string | undefined;

      if (milestoneId) {
        const entry = state.registry.find((m) => m.id === milestoneId);
        if (!entry) return { error: `Milestone ${milestoneId} not found` };
        return {
          milestone: {
            id: entry.id,
            title: entry.title,
            status: entry.status,
          },
          phase: state.phase,
          activeMilestone: state.activeMilestone,
          activeSlice: state.activeSlice,
          activeTask: state.activeTask,
        };
      }

      return {
        phase: state.phase,
        activeMilestone: state.activeMilestone,
        activeSlice: state.activeSlice,
        activeTask: state.activeTask,
        registry: state.registry,
        progress: state.progress,
        requirements: state.requirements,
      };
    }),
  );

  // =====================================================================
  // SKIP SLICE — wtf_skip_slice
  // =====================================================================

  server.tool(
    'wtf_skip_slice',
    'Mark a slice as skipped so auto-mode advances past it without executing. ' +
    'This is a permanent DB operation — the prompt enforces user confirmation before calling.',
    {
      milestoneId: z.string().describe('Milestone ID'),
      sliceId: z.string().describe('Slice ID to skip'),
      reason: z.string().describe('Why this slice is being skipped'),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      const milestoneId = args.milestoneId as string;
      const sliceId = args.sliceId as string;
      const reason = args.reason as string;

      updateSliceStatus(milestoneId, sliceId, 'skipped');

      // Also save a decision recording why it was skipped
      await saveDecisionToDb(
        {
          scope: 'slice',
          decision: `Skip slice ${sliceId} in ${milestoneId}`,
          choice: 'skipped',
          rationale: reason,
          made_by: 'agent',
        },
        basePath,
      );

      return { skipped: true, milestoneId, sliceId, reason };
    }),
  );

  // =====================================================================
  // JOURNAL QUERY — wtf_journal_query
  // =====================================================================

  server.tool(
    'wtf_journal_query',
    'Query the execution journal for structured event history. ' +
    'Use this instead of direct JSONL file reads.',
    {
      flowId: z.string().optional().describe('Filter by flow ID'),
      eventType: z.string().optional().describe('Filter by event type (e.g. "unit-start", "unit-end")'),
      unitId: z.string().optional().describe('Filter by unit ID'),
      after: z.string().optional().describe('ISO-8601 lower bound (inclusive)'),
      before: z.string().optional().describe('ISO-8601 upper bound (inclusive)'),
      limit: z.number().optional().describe('Max entries to return (default: 100)'),
    },
    wrapHandler(projectDir, async (args, basePath) => {
      const filters: Record<string, string | undefined> = {};
      if (args.flowId) filters.flowId = args.flowId as string;
      if (args.eventType) filters.eventType = args.eventType as string;
      if (args.unitId) filters.unitId = args.unitId as string;
      if (args.after) filters.after = args.after as string;
      if (args.before) filters.before = args.before as string;

      const entries = queryJournal(basePath, filters as any);
      const limit = (args.limit as number | undefined) ?? 100;
      return { entries: entries.slice(-limit), totalCount: entries.length };
    }),
  );

  // =====================================================================
  // GATE RESULT — wtf_save_gate_result
  // =====================================================================

  server.tool(
    'wtf_save_gate_result',
    'Save the result of a quality gate evaluation (verification check).',
    {
      milestoneId: z.string().describe('Milestone ID'),
      sliceId: z.string().describe('Slice ID'),
      gateId: z.string().describe('Gate ID (e.g. "contract", "integration", "operational")'),
      verdict: z.enum(['pass', 'flag', 'omitted']).describe('Gate verdict: pass, flag (issue found), or omitted (skipped)'),
      rationale: z.string().describe('Why this verdict was given'),
      findings: z.string().describe('Detailed findings from the evaluation'),
      taskId: z.string().optional().describe('Task ID if task-scoped'),
    },
    wrapHandler(projectDir, async (args) => {
      saveGateResult({
        milestoneId: args.milestoneId as string,
        sliceId: args.sliceId as string,
        gateId: args.gateId as string,
        taskId: args.taskId as string | undefined,
        verdict: args.verdict as "pass" | "flag" | "omitted",
        rationale: args.rationale as string,
        findings: args.findings as string,
      });
      return { saved: true, gateId: args.gateId, verdict: args.verdict };
    }),
  );

  return { server };
}
