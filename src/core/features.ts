import { currentState } from "./recorder.js";
import { history, matchesPathRule, type HistoryItem } from "./query.js";
import { EvidenceStore } from "./store.js";
import { SCHEMA_VERSION, type FeatureCheckpoint, type FeatureStatus, type FileState } from "./types.js";
import { git, makeId, normalizeRelative } from "./util.js";
import { dirtyPaths, fileState, repositoryFiles, trackedEntries } from "./workspace.js";

export interface CreateFeatureCheckpointOptions {
  name: string;
  selectors: string[];
  note?: string;
}

export function createFeatureCheckpoint(
  store: EvidenceStore,
  options: CreateFeatureCheckpointOptions,
): FeatureCheckpoint {
  const name = options.name.trim();
  if (!name) throw new Error("feature name is required");
  if (name.length > 128) throw new Error("feature name must be 128 characters or fewer");
  const selectors = [...new Set(options.selectors.map((item) => normalizeRelative(store.repositoryRoot, item)))];
  if (selectors.length === 0) throw new Error("at least one feature path is required");

  const paths = repositoryFiles(store.repositoryRoot)
    .filter((pathname) => selectors.some((selector) => matchesPathRule(selector, pathname)))
    .sort();
  if (paths.length === 0) throw new Error(`feature ${name} does not match any tracked or unignored files`);

  const tracked = trackedEntries(store.repositoryRoot);
  const dirty = dirtyPaths(store.repositoryRoot);
  const states: Record<string, FileState> = Object.fromEntries(
    paths.map((pathname) => {
      const state = fileState(store, pathname, tracked, dirty);
      if (!state) throw new Error(`${pathname} disappeared while creating the checkpoint`);
      return [pathname, state];
    }),
  );
  const previous = listFeatureCheckpoints(store, name).at(-1);
  return store.writeCheckpoint({
    schemaVersion: SCHEMA_VERSION,
    id: makeId("checkpoint"),
    name,
    ...(options.note?.trim() ? { note: options.note.trim() } : {}),
    repositoryRoot: store.repositoryRoot,
    selectors,
    states,
    baseCommit: git(store.repositoryRoot, ["rev-parse", "HEAD"], true).trim() || null,
    createdAt: new Date().toISOString(),
    previousCheckpointId: previous?.id ?? null,
  });
}

export function listFeatureCheckpoints(store: EvidenceStore, name?: string): FeatureCheckpoint[] {
  return store.listCheckpoints().filter((checkpoint) => !name || checkpoint.name === name);
}

export function resolveFeatureCheckpoint(store: EvidenceStore, idOrName: string): FeatureCheckpoint {
  try {
    return store.readCheckpoint(idOrName);
  } catch {
    const checkpoint = listFeatureCheckpoints(store, idOrName).at(-1);
    if (!checkpoint) throw new Error(`feature checkpoint ${idOrName} was not found`);
    return checkpoint;
  }
}

export function featureStatus(store: EvidenceStore, idOrName: string): FeatureStatus {
  const checkpoint = verifiedCheckpoint(store, idOrName);
  const currentPaths = repositoryFiles(store.repositoryRoot).filter((pathname) =>
    checkpoint.selectors.some((selector) => matchesPathRule(selector, pathname)),
  );
  const candidates = new Set([...Object.keys(checkpoint.states), ...currentPaths]);
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  let unchanged = 0;

  for (const pathname of [...candidates].sort()) {
    const recorded = checkpoint.states[pathname] ?? null;
    const current = currentState(store, pathname);
    if (!recorded && current) added.push(pathname);
    else if (recorded && !current) deleted.push(pathname);
    else if (recorded?.digest !== current?.digest || recorded?.mode !== current?.mode) modified.push(pathname);
    else unchanged += 1;
  }

  return {
    checkpointId: checkpoint.id,
    name: checkpoint.name,
    createdAt: checkpoint.createdAt,
    clean: added.length + modified.length + deleted.length === 0,
    added,
    modified,
    deleted,
    unchanged,
  };
}

export function featureHistory(store: EvidenceStore, idOrName: string): HistoryItem[] {
  const checkpoint = verifiedCheckpoint(store, idOrName);
  return history(store).filter(
    ({ event, run }) =>
      run.status !== "running" &&
      event.timestamp >= checkpoint.createdAt &&
      checkpoint.selectors.some((selector) => matchesPathRule(selector, event.path)),
  );
}

function verifiedCheckpoint(store: EvidenceStore, idOrName: string): FeatureCheckpoint {
  const checkpoint = resolveFeatureCheckpoint(store, idOrName);
  const failures = store.verifyCheckpoint(checkpoint.id);
  if (failures.length > 0) throw new Error(`refusing unverified checkpoint: ${failures.join("; ")}`);
  return checkpoint;
}
