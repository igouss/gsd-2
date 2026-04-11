/**
 * milestone/report.ts — Milestone report generation.
 *
 * Generates HTML milestone report snapshots when milestones complete.
 */

import type { AutoSession } from "../session.ts";
import type { CoreLoopDeps } from "../loop-deps.ts";
import { basename } from "node:path";
import { loadVisualizerData } from "../../reporting/visualizer-data.ts";
import { generateHtmlReport } from "../../reporting/export-html.ts";
import { writeReportSnapshot } from "../../reporting/reports.ts";

/**
 * Resolve the base path for milestone reports.
 * Prefers originalBasePath (project root) over basePath (which may be a worktree).
 * Exported for testing.
 */
export function _resolveReportBasePath(s: Pick<AutoSession, "originalBasePath" | "basePath">): string {
  return s.originalBasePath || s.basePath;
}

/**
 * Generate and write an HTML milestone report snapshot.
 * Extracted from the milestone-transition block in autoLoop.
 */
export async function generateMilestoneReport(
  s: AutoSession,
  deps: CoreLoopDeps,
  milestoneId: string,
): Promise<void> {
  const reportBasePath = _resolveReportBasePath(s);

  const snapData = await loadVisualizerData(reportBasePath);
  const completedMs = snapData.milestones.find(
    (m: { id: string }) => m.id === milestoneId,
  );
  const msTitle = completedMs?.title ?? milestoneId;
  const wtfVersion = process.env.WTF_VERSION ?? "0.0.0";
  const projName = basename(reportBasePath);
  const doneSlices = snapData.milestones.reduce(
    (acc: number, m: { slices: { done: boolean }[] }) =>
      acc + m.slices.filter((sl: { done: boolean }) => sl.done).length,
    0,
  );
  const totalSlices = snapData.milestones.reduce(
    (acc: number, m: { slices: unknown[] }) => acc + m.slices.length,
    0,
  );
  const outPath = writeReportSnapshot({
    basePath: reportBasePath,
    html: generateHtmlReport(snapData, {
      projectName: projName,
      projectPath: reportBasePath,
      wtfVersion,
      milestoneId,
      indexRelPath: "index.html",
    }),
    milestoneId,
    milestoneTitle: msTitle,
    kind: "milestone",
    projectName: projName,
    projectPath: reportBasePath,
    wtfVersion,
    totalCost: snapData.totals?.cost ?? 0,
    totalTokens: snapData.totals?.tokens.total ?? 0,
    totalDuration: snapData.totals?.duration ?? 0,
    doneSlices,
    totalSlices,
    doneMilestones: snapData.milestones.filter(
      (m: { status: string }) => m.status === "complete",
    ).length,
    totalMilestones: snapData.milestones.length,
    phase: snapData.phase,
  });
  deps.events.notify(
    `Report saved: .wtf/reports/${basename(outPath)} — open index.html to browse progression.`,
    "info",
  );
}
