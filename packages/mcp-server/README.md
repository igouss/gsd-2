# @gsd-build/mcp-server

MCP server that gives executing agents access to GSD state-mutation tools. Runs inside the orchestrator process over SSE — single DB connection, no locking issues.

## Usage

```typescript
import { createUnitToolsServer } from "@gsd-build/mcp-server";

const { server } = await createUnitToolsServer("/path/to/project");

// Wire to an HTTP server with SSE transport
// See gsd-cli/src/mcp-host.ts for the full example
```

The orchestrator generates an MCP config for the harness:

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

## Tools (18)

### Lifecycle

| Tool | Description |
|------|-------------|
| `gsd_task_complete` | Mark a task as complete |
| `gsd_slice_complete` | Mark a slice as complete |
| `gsd_complete_milestone` | Mark a milestone as complete |
| `gsd_validate_milestone` | Run milestone validation checks |
| `gsd_reopen_task` | Reopen a completed task |
| `gsd_reopen_slice` | Reopen a completed slice |
| `gsd_reopen_milestone` | Reopen a completed milestone |

### Planning

| Tool | Description |
|------|-------------|
| `gsd_plan_milestone` | Write milestone roadmap with slice breakdown |
| `gsd_plan_slice` | Write slice plan with task breakdown |
| `gsd_plan_task` | Write detailed task plan |
| `gsd_replan_slice` | Rewrite a slice plan |
| `gsd_reassess_roadmap` | Rewrite milestone roadmap |

### Knowledge

| Tool | Description |
|------|-------------|
| `gsd_decision_save` | Record a technical decision |
| `gsd_requirement_save` | Record a requirement |
| `gsd_requirement_update` | Update requirement status |

### Read-only

| Tool | Description |
|------|-------------|
| `gsd_progress` | Project progress metrics |
| `gsd_roadmap` | Full roadmap structure |
| `gsd_knowledge` | Decisions, requirements, captures |

## Architecture

All tool handlers are pure functions imported from `@gsd-build/gsd-core`. The MCP server is a thin wrapper that exposes them over the Model Context Protocol.

```
gsd-cli (orchestrator)
  │
  ├─ starts HTTP server on random local port
  ├─ creates MCP server via createUnitToolsServer(projectDir)
  ├─ writes MCP config pointing to http://127.0.0.1:<port>/sse
  │
  └─ spawns claude -p --mcp-config <config>
       │
       └─ agent calls gsd_task_complete, gsd_plan_slice, etc.
            │
            └─ SSE → orchestrator process → gsd-core handlers → .gsd/ DB + filesystem
```

## License

MIT
