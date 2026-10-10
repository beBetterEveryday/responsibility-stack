export { EvidenceStore } from "./core/store.js";
export { RunSession, WorkspaceRecorder } from "./core/recorder.js";
export { history, driftReport } from "./core/query.js";
export {
  createFeatureCheckpoint,
  featureHistory,
  featureStatus,
  listFeatureCheckpoints,
  resolveFeatureCheckpoint,
} from "./core/features.js";
export { protectIntent } from "./core/privacy.js";
export { onboardRepository } from "./core/onboarding.js";
export {
  applyExactRollback,
  eventHunks,
  formatEventHunks,
  planEditRollback,
  planFeatureRollback,
  planRunRollback,
  rollbackFeature,
  rollbackHunk,
  rollbackSymbol,
} from "./core/rollback.js";
export { changedSymbols, symbolsIn, supportsSymbols } from "./core/symbols.js";
export { handleCodexHook } from "./core/hook-recorder.js";
export type * from "./core/types.js";
