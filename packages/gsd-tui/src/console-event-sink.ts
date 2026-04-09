/**
 * console-event-sink.ts — Console-based OrchestratorEventSink.
 *
 * Logs orchestrator events to stderr with colored prefixes.
 * This is the default event sink for standalone (non-TUI) operation.
 *
 * Users can replace this with any implementation of OrchestratorEventSink
 * (custom TUI, web UI, MCP notifications, etc.) by passing their own
 * sink to the orchestrator.
 */

import type { OrchestratorEventSink } from "@gsd-build/gsd-core";

const LEVEL_PREFIX: Record<string, string> = {
  info:    "\x1b[36m[info]\x1b[0m",    // cyan
  warning: "\x1b[33m[warn]\x1b[0m",    // yellow
  error:   "\x1b[31m[error]\x1b[0m",   // red
  success: "\x1b[32m[done]\x1b[0m",    // green
};

/**
 * Console event sink — writes to stderr so it doesn't interfere with
 * stdout-based protocols (MCP, JSON output, etc.).
 */
export const consoleEventSink: OrchestratorEventSink = {
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void {
    const prefix = LEVEL_PREFIX[level ?? "info"] ?? LEVEL_PREFIX.info;
    process.stderr.write(`${prefix} ${message}\n`);
  },

  progress(data: { unitType: string; unitId: string; phase: string; iteration: number }): void {
    process.stderr.write(
      `\x1b[90m[iter ${data.iteration}]\x1b[0m ${data.unitType} ${data.unitId} → ${data.phase}\n`,
    );
  },

  metric(data: Record<string, unknown>): void {
    process.stderr.write(
      `\x1b[90m[metric]\x1b[0m ${JSON.stringify(data)}\n`,
    );
  },
};

/**
 * Create a buffered event sink that collects events and forwards them
 * to a delegate. Useful for capturing events during startup before
 * the real sink is ready, then flushing.
 */
export function createBufferedEventSink(): {
  sink: OrchestratorEventSink;
  flush(target: OrchestratorEventSink): void;
} {
  type Event =
    | { kind: "notify"; message: string; level?: "info" | "warning" | "error" | "success" }
    | { kind: "progress"; data: { unitType: string; unitId: string; phase: string; iteration: number } }
    | { kind: "metric"; data: Record<string, unknown> };

  const buffer: Event[] = [];

  const sink: OrchestratorEventSink = {
    notify(message, level) {
      buffer.push({ kind: "notify", message, level });
    },
    progress(data) {
      buffer.push({ kind: "progress", data });
    },
    metric(data) {
      buffer.push({ kind: "metric", data });
    },
  };

  function flush(target: OrchestratorEventSink): void {
    for (const event of buffer) {
      switch (event.kind) {
        case "notify":
          target.notify(event.message, event.level);
          break;
        case "progress":
          target.progress(event.data);
          break;
        case "metric":
          target.metric(event.data);
          break;
      }
    }
    buffer.length = 0;

    // After flush, forward directly to target
    sink.notify = target.notify.bind(target);
    sink.progress = target.progress.bind(target);
    sink.metric = target.metric.bind(target);
  }

  return { sink, flush };
}
