/**
 * mcp-host.ts — Hosts the WTF unit-tools MCP server over SSE in the
 * orchestrator process. Claude connects to this via URL.
 *
 * This keeps the DB in one process tree and avoids the separate-process
 * MCP server spawned by claude's stdio transport.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { OrchestratorEventSink } from "@gsd-build/gsd-core";

const MCP_PKG = "@modelcontextprotocol/sdk";

export interface McpHostResult {
  /** URL for the SSE endpoint (e.g. "http://localhost:3456/sse") */
  url: string;
  /** Port the server is listening on */
  port: number;
  /** Path to the generated MCP config JSON file */
  mcpConfigPath: string;
  /** Shutdown the HTTP server */
  shutdown: () => Promise<void>;
}

/**
 * Start the WTF MCP unit-tools server on a random local port using SSE transport.
 * Writes an MCP config file that claude can use to connect.
 */
export async function startMcpHost(
  projectDir: string,
  configDir: string,
  events: OrchestratorEventSink,
): Promise<McpHostResult> {
  // Dynamic imports — same pattern as mcp-server package
  const { createUnitToolsServer } = await import("@gsd-build/mcp-server");
  const sseMod = await import(`${MCP_PKG}/server/sse.js`);
  const SSEServerTransport = sseMod.SSEServerTransport;

  // Create the MCP server with all tools
  const { server: mcpServer } = await createUnitToolsServer(projectDir);

  // Track active transport per session
  let activeTransport: InstanceType<typeof SSEServerTransport> | null = null;

  // Create HTTP server
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      // SSE connection — create transport and connect MCP server
      const transport = new SSEServerTransport("/messages", res);
      activeTransport = transport;
      await mcpServer.connect(transport);
      events.notify("MCP client connected via SSE", "info");
    } else if (req.method === "POST" && url.pathname === "/messages") {
      // Message from client
      if (!activeTransport) {
        res.writeHead(400);
        res.end("No active SSE connection");
        return;
      }
      // Parse body
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          await activeTransport!.handlePostMessage(req, res, parsed);
        } catch (err) {
          res.writeHead(400);
          res.end(`Invalid message: ${(err as Error).message}`);
        }
      });
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  // Listen on random port
  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  const url = `http://127.0.0.1:${port}/sse`;
  events.notify(`MCP server listening on ${url}`, "info");

  // Write MCP config for claude
  mkdirSync(configDir, { recursive: true });
  const mcpConfig = {
    mcpServers: {
      wtf: {
        type: "sse",
        url,
      },
    },
  };
  const mcpConfigPath = join(configDir, "wtf-mcp-config.json");
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf-8");

  const shutdown = async () => {
    try { await mcpServer.close(); } catch { /* swallow */ }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  };

  return { url, port, mcpConfigPath, shutdown };
}
