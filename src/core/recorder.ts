import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { EvidenceStore } from "./store.js";
import { protectIntent } from "./privacy.js";
import {
  SCHEMA_VERSION,
  type Actor,
  type EditEvent,
  type EditSource,
  type FileState,
  type RunKind,
  type RunRecord,
  type RunSource,
} from "./types.js";
import { digest, git, makeId, normalizeRelative, stableJson } from "./util.js";
import { dirtyPaths, repositoryFiles, trackedEntries, type TrackedEntry } from "./workspace.js";

const SETTLE_TIME_MS = 80;

interface RunOptions {
  intent: string;
  scope?: string[];
  actor?: Actor;
  command?: string[];
  kind?: RunKind;
  sourceRunId?: string;
  sourceEventId?: string;
  sourceCheckpointId?: string;
  source?: RunSource;
  startedAt?: string;
  baseCommit?: string | null;
  intentDigest?: string;
  intentRedacted?: boolean;
}

export class RunSession {
  readonly run: RunRecord;
  private sequence = 0;
  private head: string | null = null;

  constructor(
    private readonly store: EvidenceStore,
    options: RunOptions,
    existingRun?: RunRecord,
  ) {
    this.store.initialize();
    if (existingRun) {
      if (existingRun.status !== "running") throw new Error(`run ${existingRun.id} is already ${existingRun.status}`);
      const events = this.store.readEvents(existingRun.id);
      this.sequence = events.at(-1)?.sequence ?? 0;
      this.head = events.at(-1)?.hash ?? null;
      this.run = existingRun;
      return;
    }
    const intent = protectIntent(options.intent);
    this.run = {
      schemaVersion: SCHEMA_VERSION,
      id: makeId("run"),
      kind: options.kind ?? "capture",
      repositoryRoot: store.repositoryRoot,
      intent: intent.value,
      intentDigest: options.intentDigest ?? intent.digest,
      intentRedacted: options.intentRedacted ?? intent.redacted,
      scope: options.scope ?? [],
      actor: options.actor ?? {},
      ...(options.source ? { source: options.source } : {}),
      commandExecutable: options.command?.[0] ? path.basename(options.command[0]) : null,
      commandDigest: options.command ? digest(stableJson(options.command)) : null,
      baseCommit: options.baseCommit === undefined
        ? git(store.repositoryRoot, ["rev-parse", "HEAD"], true).trim() || null
        : options.baseCommit,
      startedAt: options.startedAt ?? new Date().toISOString(),
      endedAt: null,
      status: "running",
      exitCode: null,
      eventCount: 0,
      eventHead: null,
      ...(options.sourceRunId ? { sourceRunId: options.sourceRunId } : {}),
      ...(options.sourceEventId ? { sourceEventId: options.sourceEventId } : {}),
      ...(options.sourceCheckpointId ? { sourceCheckpointId: options.sourceCheckpointId } : {}),
    };
    this.store.writeRun(this.run);
  }

  static resume(store: EvidenceStore, runId: string): RunSession {
    const run = store.readRun(runId);
    return new RunSession(store, { intent: run.intent }, run);
  }

  record(pathname: string, before: FileState | null, after: FileState | null, source?: EditSource): EditEvent | null {
    if (before?.digest === after?.digest && before?.mode === after?.mode) return null;
    const event = this.store.appendEvent({
      schemaVersion: SCHEMA_VERSION,
      id: makeId("edit"),
      runId: this.run.id,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      path: pathname,
      operation: before === null ? "create" : after === null ? "delete" : "modify",
      before,
      after,
      previousEventHash: this.head,
      source: source ?? { adapter: "explicit", attribution: this.run.kind === "rollback" ? "system" : "declared" },
    });
    this.head = event.hash;
    return event;
  }

  finish(status: RunRecord["status"], exitCode: number | null): RunRecord {
    const completed: RunRecord = {
      ...this.run,
      endedAt: new Date().toISOString(),
      status,
      exitCode,
      eventCount: this.sequence,
      eventHead: this.head,
    };
    return this.store.writeRun(completed, true);
  }
}

export class WorkspaceRecorder {
  private readonly states = new Map<string, FileState>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly tracked = new Map<string, TrackedEntry>();
  private readonly dirty = new Set<string>();
  private child: ChildProcess | null = null;
  private captureError: Error | null = null;

  constructor(
    private readonly store: EvidenceStore,
    private readonly session: RunSession,
  ) {}

  async run(command: string[]): Promise<number> {
    if (command.length === 0) throw new Error("a command is required after --");
    this.loadGitState();
    this.captureBaseline();

    const watcher = watch(this.store.repositoryRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const relative = path.relative(this.store.repositoryRoot, path.resolve(this.store.repositoryRoot, filename)).split(path.sep).join("/");
      if (this.shouldIgnore(relative, true)) return;
      this.schedule(relative);
    });

    try {
      const exitCode = await this.spawn(command);
      await new Promise((resolve) => setTimeout(resolve, SETTLE_TIME_MS * 2));
      watcher.close();
      if (this.captureError) throw this.captureError;
      this.flushPending();
      this.captureFinalState();
      return exitCode;
    } finally {
      watcher.close();
      for (const timeout of this.pending.values()) clearTimeout(timeout);
      this.pending.clear();
    }
  }

  private loadGitState(): void {
    for (const [pathname, entry] of trackedEntries(this.store.repositoryRoot)) this.tracked.set(pathname, entry);
    for (const pathname of dirtyPaths(this.store.repositoryRoot)) this.dirty.add(pathname);
  }

  private captureBaseline(): void {
    for (const pathname of this.repositoryFiles()) {
      const tracked = this.tracked.get(pathname);
      const preferGit = tracked && !this.dirty.has(pathname) ? tracked.objectId : undefined;
      const state = this.store.stateFromWorkingFile(pathname, preferGit);
      if (state) this.states.set(pathname, state);
    }
  }

  private schedule(pathname: string): void {
    const previous = this.pending.get(pathname);
    if (previous) clearTimeout(previous);
    this.pending.set(
      pathname,
      setTimeout(() => {
        this.pending.delete(pathname);
        try { this.capture(pathname); } catch (error) { this.captureError = error as Error; }
      }, SETTLE_TIME_MS),
    );
  }

  private capture(pathname: string): void {
    if (this.shouldIgnore(pathname, true)) return;
    const before = this.states.get(pathname) ?? null;
    const after = this.store.stateFromWorkingFile(pathname);
    if (!before && !after) return;
    const event = this.session.record(pathname, before, after, {
      adapter: "cli-wrapper", attribution: "unattributed", attributionReason: "observed-during-process; writer-not-verified",
    });
    if (!event) return;
    if (after) this.states.set(pathname, after);
    else this.states.delete(pathname);
  }

  private flushPending(): void {
    for (const [pathname, timeout] of this.pending) {
      clearTimeout(timeout);
      this.capture(pathname);
    }
    this.pending.clear();
  }

  private captureFinalState(): void {
    const candidates = new Set([...this.states.keys(), ...this.repositoryFiles()]);
    for (const pathname of candidates) this.capture(pathname);
  }

  private repositoryFiles(): string[] {
    return repositoryFiles(this.store.repositoryRoot).filter((pathname) => !this.shouldIgnore(pathname));
  }

  private shouldIgnore(pathname: string, checkGitIgnore = false): boolean {
    if (pathname === "." || pathname.startsWith(".git/") || pathname === ".git") return true;
    if (this.states.has(pathname)) return false;
    const ignoredDirectory = pathname.split("/").some((part) =>
      ["node_modules", "dist", "build", "coverage", ".next", ".dart_tool", "Pods"].includes(part),
    );
    if (ignoredDirectory && !this.tracked.has(pathname)) return true;
    if (checkGitIgnore) {
      const result = spawnSync("git", ["check-ignore", "-q", "--", pathname], { cwd: this.store.repositoryRoot });
      if (result.status === 0) return true;
    }
    const absolute = path.join(this.store.repositoryRoot, pathname);
    if (!existsSync(absolute)) return false;
    try {
      return statSync(absolute).isDirectory();
    } catch {
      return false;
    }
  }

  private spawn(command: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
      const [executable, ...args] = command;
      if (!executable) return reject(new Error("missing command"));
      this.child = spawn(executable, args, {
        cwd: this.store.repositoryRoot,
        env: { ...process.env, RESPSTACK_WRAPPED: "1" },
        stdio: "inherit",
      });
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
  }
}

export function currentState(store: EvidenceStore, pathname: string): FileState | null {
  const safePath = normalizeRelative(store.repositoryRoot, pathname);
  const absolute = path.join(store.repositoryRoot, safePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
  const content = readFileSync(absolute);
  return {
    digest: digest(content),
    objectRef: `working:${pathname}`,
    size: content.byteLength,
    mode: statSync(absolute).mode & 0o777,
  };
}
