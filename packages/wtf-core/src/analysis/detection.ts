/**
 * WTF Detection — Project state and ecosystem detection.
 *
 * Barrel re-export. All implementation lives in detection-*.ts sub-modules.
 */

export type { ProjectDetection, V1Detection, V2Detection, XcodePlatform, ProjectSignals } from "./detection-types.ts";
export { PROJECT_FILES } from "./detection-types.ts";
export { scanProjectFiles } from "./detection-markers.ts";
export { detectProjectSignals } from "./detection-signals.ts";
export { detectProjectState, detectV1Planning, hasGlobalSetup, isFirstEverLaunch } from "./detection-core.ts";
