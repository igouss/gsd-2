/**
 * GSD Detection — Project state and ecosystem detection.
 *
 * Barrel re-export. All implementation lives in detection-*.ts sub-modules.
 */

export type { ProjectDetection, V1Detection, V2Detection, XcodePlatform, ProjectSignals } from "./detection-types.js";
export { PROJECT_FILES } from "./detection-types.js";
export { scanProjectFiles } from "./detection-markers.js";
export { detectProjectSignals } from "./detection-signals.js";
export { detectProjectState, detectV1Planning, hasGlobalSetup, isFirstEverLaunch } from "./detection-core.js";
