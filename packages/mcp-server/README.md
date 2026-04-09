# @gsd-build/mcp-server

MCP server exposing GSD orchestration tools for Claude Code, Cursor, and other MCP-compatible clients.

Two server modes:

1. **Session server** (`gsd-mcp-server`) — manages GSD auto-mode sessions via RPC. Start sessions, poll progress, resolve blockers, retrieve results.
2. **Unit-tools server** (`gsd-unit-tools` / `createUnitToolsServer`) — exposes GSD state-mutation tools for executing agents. Used by the standalone orchestrator (`gsd-cli`) to give agents access to `gsd_task_complete`, `gsd_plan_slice`, etc.

## Installation

```bash
npm install @gsd-build/mcp-server
```

## Unit-Tools Server (standalone orchestrator)

The unit-tools server provides 18 GSD tools that executing agents call to mutate project state. It's designed to run inside the orchestrator process using SSE transport.

### SSE transport (recommended)

The orchestrator hosts the MCP server in its own process. Claude connects via URL — no separate process spawned. One DB connection, no locking issues.

```typescript
import { createUnitToolsServer } from "@gsd-build/mcp-server";

// Create server with all 18 tools scoped to a project directory
const { server } = await createUnitToolsServer("/path/to/project");

// Connect via SSE transport (inside an HTTP server)
const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
// ... wire to HTTP server, see gsd-cli/src/mcp-host.ts for full example
```

MCP config for claude:

```json
{
  "mcpServers": {
    "gsd": {
      "type": "sse",
      "url": "http://127.0.0.1:<port>/sse"
    }
  }
}
```

### Stdio transport (standalone)

For use outside the orchestrator, the unit-tools server can run as a standalone process:

```bash
npx gsd-unit-tools --project-dir /path/to/project
```

MCP config:

```json
{
  "mcpServers": {
    "gsd": {
      "command": "npx",
      "args": ["gsd-unit-tools", "--project-dir", "/path/to/project"]
    }
  }
}
```

### Unit-tools: 18 tools

#### Lifecycle

| Tool | Description | Required params |
|------|-------------|----------------|
| `gsd_task_complete` | Mark a task as complete | `taskId`, `sliceId`, `milestoneId`, `oneLiner`, `narrative`, `verification` |
| `gsd_slice_complete` | Mark a slice as complete | `sliceId`, `milestoneId`, `sliceTitle`, `oneLiner`, `narrative`, `verification`, `uatContent` |
| `gsd_complete_milestone` | Mark a milestone as complete | `milestoneId`, `title`, `oneLiner`, `narrative`, `verificationPassed` |
| `gsd_validate_milestone` | Write a milestone validation report | `milestoneId`, `verdict`, `remediationRound`, `successCriteriaChecklist`, `sliceDeliveryAudit`, `crossSliceIntegration`, `requirementCoverage`, `verdictRationale` |
| `gsd_reopen_task` | Reopen a completed task | `taskId`, `sliceId`, `milestoneId`, `reason` |
| `gsd_reopen_slice` | Reopen a completed slice | `sliceId`, `milestoneId`, `reason` |
| `gsd_reopen_milestone` | Reopen a completed milestone | `milestoneId`, `reason` |

#### Planning

| Tool | Description | Required params |
|------|-------------|----------------|
| `gsd_plan_milestone` | Create milestone roadmap with slice breakdown | `milestoneId`, `title`, `vision`, `slices[]` |
| `gsd_plan_slice` | Create slice plan with task breakdown | `milestoneId`, `sliceId`, `goal`, `tasks[]` |
| `gsd_plan_task` | Create detailed task plan | `milestoneId`, `sliceId`, `taskId`, `title`, `description`, `estimate`, `files[]`, `verify` |
| `gsd_replan_slice` | Rewrite a slice plan | `milestoneId`, `sliceId`, `reason`, `goal`, `tasks[]` |
| `gsd_reassess_roadmap` | Rewrite milestone roadmap | `milestoneId`, `reason`, `title`, `vision`, `slices[]` |

#### Knowledge

| Tool | Description | Required params |
|------|-------------|----------------|
| `gsd_decision_save` | Record a technical decision | `scope`, `decision`, `choice`, `rationale` |
| `gsd_requirement_save` | Record a requirement | `class`, `description`, `why`, `source` |
| `gsd_requirement_update` | Update requirement status | `id` |

#### Read-only

| Tool | Description |
|------|-------------|
| `gsd_progress` | Project progress metrics |
| `gsd_roadmap` | Full roadmap structure |
| `gsd_knowledge` | Decisions, requirements, captures |

---

## Session Server (pi-mono integration)

The session server manages GSD auto-mode sessions via RPC. Used by external MCP clients (Claude Code, Cursor) to start and monitor GSD sessions.

### Configuration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "gsd": {
      "command": "npx",
      "args": ["gsd-mcp-server"],
      "env": {
        "GSD_CLI_PATH": "/path/to/gsd"
      }
    }
  }
}
```

### Session tools (6)

| Tool | Description | Required params |
|------|-------------|----------------|
| `gsd_execute` | Start a GSD auto-mode session | `projectDir` |
| `gsd_status` | Poll session status and progress | `sessionId` |
| `gsd_result` | Get accumulated session result | `sessionId` |
| `gsd_cancel` | Cancel a running session | `sessionId` |
| `gsd_query` | Query project state from filesystem (no session) | `projectDir`, `query` |
| `gsd_resolve_blocker` | Resolve a pending blocker | `sessionId`, `response` |

### Read-only tools (6)

| Tool | Description | Required params |
|------|-------------|----------------|
| `gsd_progress` | Structured project progress | `projectDir` |
| `gsd_roadmap` | Full roadmap structure | `projectDir` |
| `gsd_history` | Unit execution history | `projectDir` |
| `gsd_doctor` | Health check results | `projectDir` |
| `gsd_captures` | User captures and notes | `projectDir` |
| `gsd_knowledge` | Decisions and requirements | `projectDir` |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  @gsd-build/mcp-server                                   │
│                                                          │
│  ┌─────────────────────┐  ┌───────────────────────────┐  │
│  │  Session Server      │  │  Unit-Tools Server        │  │
│  │  (gsd-mcp-server)   │  │  (gsd-unit-tools)         │  │
│  │                     │  │                           │  │
│  │  6 session tools    │  │  18 state-mutation tools  │  │
│  │  6 read-only tools  │  │  Pure handlers from       │  │
│  │                     │  │  @gsd-build/gsd-core      │  │
│  │  SessionManager     │  │                           │  │
│  │  └─ RpcClient       │  │  Transports:              │  │
│  │     └─ GSD CLI      │  │  - SSE (in-process)       │  │
│  │        (child proc) │  │  - stdio (standalone)     │  │
│  └─────────────────────┘  └───────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GSD_CLI_PATH` | Absolute path to the GSD CLI binary (session server only). If not set, resolves `gsd` via `which`. |

## License

MIT
