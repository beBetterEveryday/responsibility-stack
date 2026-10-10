export const SCHEMA_VERSION = 1 as const;

export type RunStatus = "running" | "completed" | "failed" | "interrupted";
export type RunKind = "capture" | "rollback";
export type EditOperation = "create" | "modify" | "delete";

export interface Actor {
  agent?: string;
  model?: string;
}

export interface RunSource {
  adapter: string;
  sessionId?: string;
  turnId?: string;
  permissionMode?: string;
  observerActor?: Actor;
}

export interface EditSource {
  adapter: string;
  toolName?: string;
  toolUseId?: string;
  attribution?: "declared" | "tool-correlated" | "unattributed" | "system";
  attributionReason?: string;
}

export interface Signature {
  algorithm: "ed25519";
  keyFingerprint: string;
  publicKey: string;
  value: string;
}

export interface RunRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  kind: RunKind;
  repositoryRoot: string;
  intent: string;
  intentDigest?: string;
  intentRedacted?: boolean;
  scope: string[];
  actor: Actor;
  source?: RunSource;
  commandExecutable: string | null;
  commandDigest: string | null;
  baseCommit: string | null;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  exitCode: number | null;
  eventCount: number;
  eventHead: string | null;
  sourceRunId?: string;
  sourceEventId?: string;
  sourceCheckpointId?: string;
  signature?: Signature;
}

export interface FeatureCheckpointBody {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  note?: string;
  repositoryRoot: string;
  selectors: string[];
  states: Record<string, FileState>;
  baseCommit: string | null;
  createdAt: string;
  previousCheckpointId: string | null;
}

export interface FeatureCheckpoint extends FeatureCheckpointBody {
  signature: Signature;
}

export interface RepositoryOnboardingBody {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  repositoryRoot: string;
  createdAt: string;
  baseCommit: string | null;
  trackedFileCount: number;
  preExistingChanges: string[];
  preExistingPathDigest: string;
}

export interface RepositoryOnboarding extends RepositoryOnboardingBody {
  signature: Signature;
}

export interface OnboardingReport {
  ready: boolean;
  storageReady: boolean;
  capture: {
    status: "not-observed" | "observed" | "stale" | "invalid";
    lastObservedAt: string | null;
    freshnessSeconds: number;
  };
  nextSteps: string[];
  created: boolean;
  onboardingId: string;
  trackingStartedAt: string;
  keyFingerprint: string;
  repositoryRoot: string;
  storeRoot: string;
  baseCommit: string | null;
  trackedFileCount: number;
  preExistingChangeCount: number;
  preExistingChanges: string[];
  preExistingChangesTruncated: boolean;
  evidence: { runs: number; edits: number; checkpoints: number };
  failures: string[];
}

export interface CaptureReceiptBody {
  adapter: "codex-hook";
  repositoryRoot: string;
  sessionId: string;
  turnId: string;
  startedAt: string;
  toolObservedAt: string;
  completedAt: string;
}

export interface CaptureReceipt extends CaptureReceiptBody {
  signature: Signature;
}

export interface FeatureStatus {
  checkpointId: string;
  name: string;
  createdAt: string;
  clean: boolean;
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: number;
}

export interface FileState {
  digest: string;
  objectRef: string;
  size: number;
  mode: number;
}

export interface EditEventBody {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  runId: string;
  sequence: number;
  timestamp: string;
  path: string;
  operation: EditOperation;
  before: FileState | null;
  after: FileState | null;
  previousEventHash: string | null;
  source?: EditSource;
}

export interface EditEvent extends EditEventBody {
  hash: string;
}

export interface RollbackChange {
  path: string;
  expected: FileState | null;
  target: FileState | null;
}

export interface DriftReport {
  runId: string;
  scopeDeclared: boolean;
  touchedPaths: string[];
  outOfScopePaths: string[];
}
