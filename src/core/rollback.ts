import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyPatch, formatPatch, structuredPatch, type StructuredPatch } from "diff";
import { featureHistory, featureStatus, resolveFeatureCheckpoint } from "./features.js";
import { RunSession, currentState } from "./recorder.js";
import { EvidenceStore } from "./store.js";
import { changedSymbols, symbolsIn } from "./symbols.js";
import type { EditEvent, EditOperation, FileState, RollbackChange, RunRecord } from "./types.js";
import { digest, isText, normalizeRelative } from "./util.js";

export type RecoveryKind = "exact" | "transplanted";

export interface RollbackResult {
  kind: RecoveryKind;
  changes: RollbackChange[];
  checkpointId?: string;
  impacts?: RollbackImpact[];
  run?: RunRecord;
  warnings?: string[];
}

export interface RollbackImpact {
  path: string;
  operation: EditOperation;
  hunkCount: number | null;
  symbols: string[];
}

export function planEditRollback(store: EvidenceStore, eventId: string): RollbackChange[] {
  const event = store.findEvent(eventId);
  assertVerified(store, event.runId);
  return [{ path: event.path, expected: event.after, target: event.before }];
}

export function planRunRollback(store: EvidenceStore, runId: string): RollbackChange[] {
  assertVerified(store, runId);
  const events = store.readEvents(runId);
  assertAttributable(events);
  if (events.length === 0) throw new Error(`run ${runId} has no recorded edits`);

  const paths = new Map<string, { first: EditEvent; last: EditEvent }>();
  for (const event of events) {
    const current = paths.get(event.path);
    if (current) current.last = event;
    else paths.set(event.path, { first: event, last: event });
  }
  return [...paths.entries()].map(([pathname, pair]) => ({
    path: pathname,
    expected: pair.last.after,
    target: pair.first.before,
  }));
}

export function planFeatureRollback(
  store: EvidenceStore,
  idOrName: string,
): { checkpointId: string; changes: RollbackChange[]; impacts: RollbackImpact[] } {
  const checkpoint = resolveFeatureCheckpoint(store, idOrName);
  const failures = store.verifyCheckpoint(checkpoint.id);
  if (failures.length > 0) throw new Error(`refusing unverified checkpoint: ${failures.join("; ")}`);

  const status = featureStatus(store, checkpoint.id);
  const changedPaths = [...status.added, ...status.modified, ...status.deleted].sort();
  if (changedPaths.length === 0) throw new Error(`feature ${checkpoint.name} already matches checkpoint ${checkpoint.id}`);

  const entries = featureHistory(store, checkpoint.id);
  assertAttributable(entries.map(({ event }) => event));
  for (const runId of new Set(entries.map(({ run }) => run.id))) assertVerified(store, runId);
  const eventsByPath = new Map<string, EditEvent[]>();
  for (const { event } of entries) {
    const events = eventsByPath.get(event.path) ?? [];
    events.push(event);
    eventsByPath.set(event.path, events);
  }

  const gaps: string[] = [];
  const changes: RollbackChange[] = [];
  for (const pathname of changedPaths) {
    const events = eventsByPath.get(pathname);
    const target = checkpoint.states[pathname] ?? null;
    const continuous = events?.every((event, index) =>
      sameState(event.before, index === 0 ? target : events[index - 1]!.after),
    );
    if (!events?.length || !continuous) {
      gaps.push(pathname);
      continue;
    }
    changes.push({ path: pathname, expected: events.at(-1)!.after, target });
  }
  if (gaps.length > 0) {
    throw new Error(`feature recovery has unattributed drift: ${gaps.join(", ")}`);
  }
  return {
    checkpointId: checkpoint.id,
    changes,
    impacts: changes.map((change) => describeImpact(store, change)),
  };
}

export function rollbackFeature(store: EvidenceStore, idOrName: string, dryRun = false): RollbackResult {
  const plan = planFeatureRollback(store, idOrName);
  const result = applyExactRollback(
    store,
    plan.changes,
    { checkpointId: plan.checkpointId },
    dryRun,
  );
  return { ...result, checkpointId: plan.checkpointId, impacts: plan.impacts };
}

export function applyExactRollback(
  store: EvidenceStore,
  changes: RollbackChange[],
  source: { runId?: string; eventId?: string; checkpointId?: string },
  dryRun = false,
): RollbackResult {
  return store.withLock(() => {
    preflight(store, changes);
    const warnings = source.eventId ? observationWarnings(store.findEvent(source.eventId)) : [];
    if (dryRun) return { kind: "exact", changes, warnings };

    const recordedBefore = new Map<string, FileState | null>();
    for (const change of changes) recordedBefore.set(change.path, store.stateFromWorkingFile(change.path));
    const session = new RunSession(store, {
      kind: "rollback",
      intent: source.eventId
        ? `Rollback edit ${source.eventId}`
        : source.checkpointId
          ? `Restore feature checkpoint ${source.checkpointId}`
          : `Rollback run ${source.runId}`,
      ...(source.runId ? { sourceRunId: source.runId } : {}),
      ...(source.eventId ? { sourceEventId: source.eventId } : {}),
      ...(source.checkpointId ? { sourceCheckpointId: source.checkpointId } : {}),
    });
    const run = atomicApply(store, changes, session, () => {
      for (const change of changes) session.record(change.path, recordedBefore.get(change.path) ?? null, change.target);
      return session.finish("completed", 0);
    });
    return { kind: "exact", changes, run, warnings };
  });
}

export function eventHunks(store: EvidenceStore, eventId: string): { patch: StructuredPatch; event: EditEvent } {
  const event = store.findEvent(eventId);
  assertVerified(store, event.runId);
  const before = event.before ? store.readObject(event.before) : Buffer.alloc(0);
  const after = event.after ? store.readObject(event.after) : Buffer.alloc(0);
  if (!isText(before) || !isText(after)) throw new Error(`${event.path} is binary; hunk rollback is unavailable`);
  return {
    event,
    patch: structuredPatch(event.path, event.path, after.toString("utf8"), before.toString("utf8"), "after", "before", {
      context: 3,
    }),
  };
}

export function rollbackHunk(store: EvidenceStore, eventId: string, hunkNumber: number, dryRun = false): RollbackResult {
  const { event, patch } = eventHunks(store, eventId);
  const hunk = patch.hunks[hunkNumber - 1];
  if (!hunk) throw new Error(`hunk ${hunkNumber} does not exist; choose 1-${patch.hunks.length}`);
  if (!event.after) throw new Error("hunk rollback for a deleted file is unavailable; use edit rollback");

  const absolute = path.join(store.repositoryRoot, normalizeRelative(store.repositoryRoot, event.path));
  if (!existsSync(absolute)) throw new Error(`${event.path} no longer exists`);
  const current = readFileSync(absolute);
  if (!isText(current)) throw new Error(`${event.path} is no longer a text file`);
  const recorded = store.readObject(event.after).toString("utf8");
  if (current.toString("utf8") !== recorded) {
    const expected = hunk.lines.filter((line) => line[0] === " " || line[0] === "-").map((line) => line.slice(1));
    const originalLines = recorded.split("\n");
    const currentLines = current.toString("utf8").split("\n");
    const matches = (lines: string[], index: number) => expected.every((line, offset) => lines[index + offset] === line);
    // ponytail: no implicit relocation; moved or ambiguous hunks require an explicit new plan.
    if (expected.length === 0 || !matches(currentLines, Math.max(0, hunk.oldStart - 1)) ||
        originalLines.filter((_, index) => matches(originalLines, index)).length !== 1 ||
        currentLines.filter((_, index) => matches(currentLines, index)).length !== 1) {
      throw new Error("the selected hunk is ambiguous or has later edits; refusing to relocate it");
    }
  }
  const selected: StructuredPatch = { ...patch, hunks: [hunk] };
  const restored = applyPatch(current.toString("utf8"), selected);
  if (restored === false) throw new Error("the selected hunk overlaps later edits and cannot be safely transplanted");

  const content = Buffer.from(restored);
  const target = dryRun
    ? previewState(content, statSync(absolute).mode & 0o777)
    : { ...store.writeObject(content), mode: statSync(absolute).mode & 0o777 };
  const change: RollbackChange = { path: event.path, expected: previewState(current, statSync(absolute).mode & 0o777), target };
  if (dryRun) return { kind: "transplanted", changes: [change], warnings: observationWarnings(event) };
  return applyTransplanted(store, event, change);
}

export function rollbackSymbol(store: EvidenceStore, eventId: string, symbolName: string, dryRun = false): RollbackResult {
  const event = store.findEvent(eventId);
  assertVerified(store, event.runId);
  if (!event.after) throw new Error("symbol rollback for a deleted file is unavailable");
  const before = event.before ? store.readObject(event.before).toString("utf8") : "";
  const after = store.readObject(event.after).toString("utf8");
  const absolute = path.join(store.repositoryRoot, normalizeRelative(store.repositoryRoot, event.path));
  if (!existsSync(absolute)) throw new Error(`${event.path} no longer exists`);
  const current = readFileSync(absolute, "utf8");

  const uniqueSymbol = (text: string) => {
    const matches = symbolsIn(event.path, text).filter((symbol) => symbol.name === symbolName);
    if (matches.length > 1) throw new Error(`symbol ${symbolName} is ambiguous`);
    return matches[0];
  };
  const oldSymbol = uniqueSymbol(before);
  const recordedSymbol = uniqueSymbol(after);
  const currentSymbol = uniqueSymbol(current);
  if (!recordedSymbol || !currentSymbol) {
    throw new Error(`symbol ${symbolName} cannot be located safely in both the recorded and current code`);
  }
  if (recordedSymbol.digest !== currentSymbol.digest) {
    throw new Error(`symbol ${symbolName} has later edits; refusing to overwrite them`);
  }
  if ((oldSymbol && oldSymbol.kind !== currentSymbol.kind) ||
      (!oldSymbol && currentSymbol.kind === "variable-function")) {
    throw new Error(`symbol ${symbolName} changes declaration structure; use an edit rollback`);
  }

  const restored = `${current.slice(0, currentSymbol.start)}${oldSymbol?.text ?? ""}${current.slice(currentSymbol.end)}`;
  const content = Buffer.from(restored);
  const target = dryRun
    ? previewState(content, statSync(absolute).mode & 0o777)
    : { ...store.writeObject(content), mode: statSync(absolute).mode & 0o777 };
  const change: RollbackChange = { path: event.path, expected: previewState(Buffer.from(current), statSync(absolute).mode & 0o777), target };
  if (dryRun) return { kind: "transplanted", changes: [change], warnings: observationWarnings(event) };
  return applyTransplanted(store, event, change);
}

export function formatEventHunks(store: EvidenceStore, eventId: string): string {
  const { patch } = eventHunks(store, eventId);
  return patch.hunks
    .map((hunk, index) => `Hunk ${index + 1}\n${formatPatch({ ...patch, hunks: [hunk] })}`)
    .join("\n");
}

function applyTransplanted(store: EvidenceStore, source: EditEvent, change: RollbackChange): RollbackResult {
  return { ...applyExactRollback(store, [change], { runId: source.runId, eventId: source.id }), kind: "transplanted" };
}

function preflight(store: EvidenceStore, changes: RollbackChange[]): void {
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    const relative = normalizeRelative(store.repositoryRoot, change.path);
    const absolute = path.join(store.repositoryRoot, relative);
    if (relative === "." || seen.has(relative) || (existsSync(absolute) && !lstatSync(absolute).isFile())) {
      throw new Error("rollback requires unique regular source file paths");
    }
    seen.add(relative);
    const current = currentState(store, change.path);
    if (current?.digest !== change.expected?.digest || current?.mode !== change.expected?.mode) conflicts.push(change.path);
  }
  if (conflicts.length > 0) {
    throw new Error(`rollback conflicts with later edits: ${conflicts.join(", ")}`);
  }
}

function atomicApply(store: EvidenceStore, changes: RollbackChange[], session: RunSession, finalize: () => RunRecord): RunRecord {
  const recovery: Array<{ path: string; state: FileState | null; target: FileState | null }> = [];
  const prepared = new Map<string, string>();
  const journal = path.join(store.location.root, "rollback-journal.json");

  try {
    for (const change of changes) {
      const state = store.stateFromWorkingFile(change.path);
      recovery.push({ path: change.path, state, target: change.target });
    }
    for (const change of changes) {
      if (!change.target) continue;
      const absolute = path.join(store.repositoryRoot, normalizeRelative(store.repositoryRoot, change.path));
      mkdirSync(path.dirname(absolute), { recursive: true });
      const temporary = `${absolute}.respstack-${process.pid}-${Math.random().toString(16).slice(2)}`;
      prepared.set(change.path, temporary);
      writeFileSync(temporary, store.readObject(change.target), { mode: change.target.mode, flag: "wx" });
    }
    preflight(store, changes);
    const journalTemporary = `${journal}.${process.pid}.tmp`;
    writeFileSync(journalTemporary, `${JSON.stringify({ version: 2, runId: session.run.id, entries: recovery })}\n`, { mode: 0o600 });
    renameSync(journalTemporary, journal);
    for (const change of changes) {
      preflight(store, [change]);
      const absolute = path.join(store.repositoryRoot, normalizeRelative(store.repositoryRoot, change.path));
      const temporary = prepared.get(change.path);
      if (!change.target) rmSync(absolute, { force: true });
      else if (temporary) {
        renameSync(temporary, absolute);
        chmodSync(absolute, change.target.mode);
      }
    }
    const run = finalize();
    rmSync(journal, { force: true });
    return run;
  } catch (error) {
    if (existsSync(journal)) store.recoverInterruptedRollback();
    else store.discardAbortedRollback(session.run.id);
    throw error;
  } finally {
    for (const temporary of prepared.values()) {
      normalizeRelative(store.repositoryRoot, temporary);
      rmSync(temporary, { force: true });
    }
  }
}

function assertVerified(store: EvidenceStore, runId: string): void {
  const failures = store.verifyRun(runId);
  if (failures.length > 0) throw new Error(`refusing unverified evidence: ${failures.join("; ")}`);
}

function assertAttributable(events: EditEvent[]): void {
  if (events.some((event) => !event.source?.attribution || event.source.attribution === "unattributed")) {
    throw new Error("recovery has unattributed observations; inspect and select an individual edit explicitly");
  }
}

function observationWarnings(event: EditEvent): string[] {
  return !event.source?.attribution || event.source.attribution === "unattributed"
    ? ["This explicitly selected edit is an observation with an unverified writer; restoring it does not establish authorship."]
    : [];
}

function previewState(content: Buffer, mode: number): FileState {
  const hash = digest(content);
  return { digest: hash, objectRef: `preview:sha256:${hash}`, size: content.byteLength, mode };
}

function sameState(left: FileState | null, right: FileState | null): boolean {
  return left?.digest === right?.digest && left?.mode === right?.mode;
}

function describeImpact(store: EvidenceStore, change: RollbackChange): RollbackImpact {
  const before = change.expected ? store.readObject(change.expected) : Buffer.alloc(0);
  const after = change.target ? store.readObject(change.target) : Buffer.alloc(0);
  const text = isText(before) && isText(after);
  const symbols = text
    ? [...changedSymbols(change.path, before.toString("utf8"), after.toString("utf8")),
        ...changedSymbols(change.path, after.toString("utf8"), before.toString("utf8"))]
    : [];
  return {
    path: change.path,
    operation: change.expected === null ? "create" : change.target === null ? "delete" : "modify",
    hunkCount: text
      ? structuredPatch(change.path, change.path, before.toString("utf8"), after.toString("utf8")).hunks.length
      : null,
    symbols: [...new Set(symbols.map((symbol) => symbol.name))],
  };
}
