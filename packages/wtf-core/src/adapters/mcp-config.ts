/**
 * mcp-config.ts — Writes temporary MCP config JSON for executing agents.
 *
 * The config tells the harness (Claude Code, etc.) how to connect to the
 * WTF unit-tools MCP server so the agent can call wtf_task_complete,
 * wtf_decision_save, etc.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface McpConfigOptions {
  /** Command to run the unit-tools server (e.g. "node" or "wtf-unit-tools"). */
  command: string;

  /** Arguments to pass before --project-dir (e.g. ["/path/to/unit-tools-cli.js"]). */
  commandArgs?: string[];

  /** Absolute path to the project directory. */
  projectDir: string;

  /** Directory to write the temp config file. */
  configDir: string;
}

/**
 * Write an MCP config JSON file that points to the WTF unit-tools server.
 * Returns the absolute path to the written config file.
 *
 * The config uses the Claude Code MCP config format:
 * ```json
 * {
 *   "mcpServers": {
 *     "wtf": {
 *       "command": "wtf-unit-tools",
 *       "args": ["--project-dir", "/path/to/project"]
 *     }
 *   }
 * }
 * ```
 */
export function writeMcpConfig(options: McpConfigOptions): string {
  mkdirSync(options.configDir, { recursive: true });

  const config = {
    mcpServers: {
      wtf: {
        command: options.command,
        args: [
          ...(options.commandArgs ?? []),
          "--project-dir",
          options.projectDir,
        ],
      },
    },
  };

  const configPath = join(options.configDir, "wtf-mcp-config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return configPath;
}
