/**
 * migrate/command.ts — Stub for harness-coupled migrate command.
 *
 * Real implementation depends on ExtensionCommandContext.
 */

export async function handleMigrate(
  _args: string,
  _ctx: unknown,
  _pi: unknown,
): Promise<void> {
  throw new Error("handleMigrate stub — requires pi-mono extension host");
}
