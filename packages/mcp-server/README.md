# @wtf-build/mcp-server

MCP server that gives executing agents access to WTF state-mutation tools. Runs inside the orchestrator process over SSE — single DB connection, no locking issues.

## Usage

```typescript
import { createUnitToolsServer } from "@wtf-build/mcp-server";

const { server } = await createUnitToolsServer("/path/to/project");

// Wire to an HTTP server with SSE transport
// See wtf-cli/src/mcp-host.ts for the full example
```

The orchestrator generates an MCP config for the harness:

```json
{
  "mcpServers": {
    "wtf": {
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
| `wtf_task_complete` | Mark a task as complete |
| `wtf_slice_complete` | Mark a slice as complete |
| `wtf_complete_milestone` | Mark a milestone as complete |
| `wtf_validate_milestone` | Run milestone validation checks |
| `wtf_reopen_task` | Reopen a completed task |
| `wtf_reopen_slice` | Reopen a completed slice |
| `wtf_reopen_milestone` | Reopen a completed milestone |

### Planning

| Tool | Description |
|------|-------------|
| `wtf_plan_milestone` | Write milestone roadmap with slice breakdown |
| `wtf_plan_slice` | Write slice plan with task breakdown |
| `wtf_plan_task` | Write detailed task plan |
| `wtf_replan_slice` | Rewrite a slice plan |
| `wtf_reassess_roadmap` | Rewrite milestone roadmap |

### Knowledge

| Tool | Description |
|------|-------------|
| `wtf_decision_save` | Record a technical decision |
| `wtf_requirement_save` | Record a requirement |
| `wtf_requirement_update` | Update requirement status |

### Read-only

| Tool | Description |
|------|-------------|
| `wtf_progress` | Project progress metrics |
| `wtf_roadmap` | Full roadmap structure |
| `wtf_knowledge` | Decisions, requirements, captures |

## Architecture

All tool handlers are pure functions imported from `@wtf-build/wtf-core`. The MCP server is a thin wrapper that exposes them over the Model Context Protocol.

```
wtf-cli (orchestrator)
  │
  ├─ starts HTTP server on random local port
  ├─ creates MCP server via createUnitToolsServer(projectDir)
  ├─ writes MCP config pointing to http://127.0.0.1:<port>/sse
  │
  └─ spawns claude -p --mcp-config <config>
       │
       └─ agent calls wtf_task_complete, wtf_plan_slice, etc.
            │
            └─ SSE → orchestrator process → wtf-core handlers → .wtf/ DB + filesystem
```

## License

MIT
