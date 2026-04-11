#!/usr/bin/env node

/**
 * wtf-unit-tools CLI — stdio MCP server for executing agents.
 *
 * Usage: wtf-unit-tools --project-dir /path/to/project
 *
 * Started by the WTF orchestrator before dispatching a unit. The executing
 * agent (Claude Code, etc.) connects to this server via MCP config.
 */

import { createUnitToolsServer } from './unit-tools-server.ts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

function parseArgs(): { projectDir: string } {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--project-dir');
  if (idx === -1 || idx + 1 >= args.length) {
    process.stderr.write(
      'Usage: wtf-unit-tools --project-dir <path>\n',
    );
    process.exit(1);
  }
  return { projectDir: args[idx + 1]! };
}

async function main(): Promise<void> {
  const { projectDir } = parseArgs();

  const { server } = await createUnitToolsServer(projectDir);

  const transport = new StdioServerTransport();

  let cleaningUp = false;
  async function cleanup(): Promise<void> {
    if (cleaningUp) return;
    cleaningUp = true;
    process.stderr.write('[wtf-unit-tools] Shutting down...\n');
    try {
      await server.close();
    } catch {
      // swallow
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => void cleanup());
  process.on('SIGINT', () => void cleanup());
  process.stdin.on('end', () => void cleanup());

  try {
    await server.connect(transport);
    process.stderr.write(
      `[wtf-unit-tools] MCP server started on stdio for ${projectDir}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[wtf-unit-tools] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(
    `[wtf-unit-tools] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
