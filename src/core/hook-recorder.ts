import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RunSession } from "./recorder.js";
import { protectIntent } from "./privacy.js";
import { EvidenceStore } from "./store.js";
import type { EditSource, FileState, RunRecord } from "./types.js";
import { digest, discoverRepository, git, normalizeRelative } from "./util.js";
import { committedPaths, dirtyPaths, fileState, trackedEntries, type TrackedEntry } from "./workspace.js";

const HOOK_STATE_VERSION = 1 as const;

export interface CodexHookInput {
  session_id: string;
  turn_id?: string;
  cwd: string;
  hook_event_name: string;
  model?: string;
  permission_mode?: string;
  prompt?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
}

interface HookState {
  version: typeof HOOK_STATE_VERSION;
  sessionId: string;
  turnId: string;
  runId: string | null;
  baseCommit: string | null;
  startedAt: string;
  intent: string;
  intentDigest: string;
  intentRedacted: boolean;
  model?: string;
  permissionMode?: string;
  concurrent?: boolean;
  toolObservedAt?: string;
  tracked: Record<string, TrackedEntry>;
  states: Record<string, FileState | null>;
}

export function handleCodexHook(input: CodexHookInput): void {
  if (process.env.RESPSTACK_WRAPPED === "1") return;
  let repositoryRoot: string;
  try {
    repositoryRoot = discoverRepository(input.cwd);
  } catch {
    return;
  }

  const store = new EvidenceStore(repositoryRoot);
  const release = store.acquireLock();
  try {
    if (input.hook_event_name === "UserPromptSubmit") beginTurn(store, input);
    else if (input.hook_event_name === "PostToolUse") captureTurn(store, input, isResponsibilityTool(input.tool_name));
    else if (input.hook_event_name === "Stop") finishTurn(store, input, "completed");
    else if (input.hook_event_name === "SessionEnd") finishSession(store, input.session_id);
  } finally {
    release();
  }
}

function beginTurn(store: EvidenceStore, input: CodexHookInput): void {
  for (const existing of statesForSession(store, input.session_id)) {
    if (existing.turnId === (input.turn_id ?? input.session_id)) return;
    finishState(store, existing, "interrupted");
  }

  const turnId = input.turn_id ?? input.session_id;
  const peers = activeStates(store);
  for (const peer of peers) {
    peer.concurrent = true;
    writeState(store, peer);
  }
  const tracked = trackedEntries(store.repositoryRoot);
  const dirty = dirtyPaths(store.repositoryRoot);
  const baseCommit = git(store.repositoryRoot, ["rev-parse", "HEAD"], true).trim() || null;
  const intent = protectIntent(input.prompt ?? "Undeclared");
  const states = Object.create(null) as Record<string, FileState | null>;
  for (const pathname of dirty) states[pathname] = fileState(store, pathname, tracked, dirty);
  writeState(store, {
    version: HOOK_STATE_VERSION,
    sessionId: input.session_id,
    turnId,
    runId: null,
    concurrent: peers.length > 0,
    baseCommit,
    startedAt: new Date().toISOString(),
    intent: intent.value,
    intentDigest: intent.digest,
    intentRedacted: intent.redacted,
    ...(input.model ? { model: input.model } : {}),
    ...(input.permission_mode ? { permissionMode: input.permission_mode } : {}),
    tracked: Object.fromEntries(tracked),
    states,
  });
}

function captureTurn(store: EvidenceStore, input: CodexHookInput, syncOnly: boolean): void {
  const state = findState(store, input.session_id, input.turn_id);
  if (!state) return;
  state.toolObservedAt = new Date().toISOString();
  capture(store, state, syncOnly, {
    adapter: "codex-hook",
    ...(input.tool_name ? { toolName: input.tool_name } : {}),
    ...(input.tool_use_id ? { toolUseId: input.tool_use_id } : {}),
  }, input);
}

function finishTurn(store: EvidenceStore, input: CodexHookInput, status: RunRecord["status"]): void {
  const state = findState(store, input.session_id, input.turn_id);
  if (state) finishState(store, state, status);
}

function finishSession(store: EvidenceStore, sessionId: string): void {
  for (const state of statesForSession(store, sessionId)) finishState(store, state, "interrupted");
}

function finishState(store: EvidenceStore, state: HookState, status: RunRecord["status"]): void {
  capture(store, state, false, { adapter: "codex-hook" });
  if (state.runId) RunSession.resume(store, state.runId).finish(status, status === "completed" ? 0 : null);
  if (status === "completed" && state.toolObservedAt) {
    store.writeCaptureReceipt({
      adapter: "codex-hook", repositoryRoot: store.repositoryRoot,
      sessionId: state.sessionId, turnId: state.turnId, startedAt: state.startedAt,
      toolObservedAt: state.toolObservedAt, completedAt: new Date().toISOString(),
    });
  }
  rmSync(statePath(store, state.sessionId, state.turnId), { force: true });
}

function capture(store: EvidenceStore, state: HookState, syncOnly: boolean, source: EditSource, input?: CodexHookInput): void {
  const baselineTracked = new Map(Object.entries(state.tracked));
  const currentTracked = trackedEntries(store.repositoryRoot);
  const dirty = dirtyPaths(store.repositoryRoot);
  const candidates = new Set([
    ...Object.keys(state.states),
    ...dirty,
    ...committedPaths(store.repositoryRoot, state.baseCommit),
  ]);
  const changes: Array<{ path: string; before: FileState | null; after: FileState | null }> = [];

  for (const pathname of [...candidates].sort()) {
    const before = Object.hasOwn(state.states, pathname)
      ? state.states[pathname] ?? null
      : baselineState(store, pathname, baselineTracked);
    const after = fileState(store, pathname, currentTracked, dirty);
    if (before?.digest !== after?.digest || before?.mode !== after?.mode) changes.push({ path: pathname, before, after });
    state.states[pathname] = after;
  }

  if (!syncOnly && changes.length > 0) {
    const session = state.runId
      ? RunSession.resume(store, state.runId)
      : new RunSession(store, {
          intent: state.intent,
          intentDigest: state.intentDigest,
          intentRedacted: state.intentRedacted,
          actor: {},
          source: {
            adapter: "codex-hook",
            sessionId: state.sessionId,
            turnId: state.turnId,
            observerActor: { agent: "codex", ...(state.model ? { model: state.model } : {}) },
            ...(state.permissionMode ? { permissionMode: state.permissionMode } : {}),
          },
          startedAt: state.startedAt,
          baseCommit: state.baseCommit,
        });
    state.runId = session.run.id;
    for (const change of changes) {
      const correlated = !state.concurrent && matchesToolEdit(store, change, input);
      session.record(change.path, change.before, change.after, {
        ...source,
        attribution: correlated ? "tool-correlated" : "unattributed",
        attributionReason: correlated ? "tool-input-matches-observed-delta" : state.concurrent ? "overlapping-sessions" : "writer-not-verified",
      });
    }
  }
  writeState(store, state);
  // Share observations, not authorship: another session must not claim the same delta.
  for (const peer of activeStates(store)) {
    if (peer.sessionId === state.sessionId && peer.turnId === state.turnId) continue;
    for (const change of changes) peer.states[change.path] = change.after;
    writeState(store, peer);
  }
}

function matchesToolEdit(store: EvidenceStore, change: { path: string; before: FileState | null; after: FileState | null }, input?: CodexHookInput): boolean {
  const tool = input?.tool_input;
  if (!input || !tool || !input.tool_use_id || typeof tool.file_path !== "string" || !change.after) return false;
  try {
    if (normalizeRelative(store.repositoryRoot, path.resolve(realpathSync(input.cwd), tool.file_path)) !== change.path) return false;
  } catch { return false; }
  const after = store.readObject(change.after).toString("utf8");
  if (input.tool_name === "Write") return typeof tool.content === "string" && tool.content === after;
  if (input.tool_name !== "Edit" || typeof tool.old_string !== "string" || !tool.old_string || typeof tool.new_string !== "string") return false;
  if (!change.before || change.before.mode !== change.after.mode) return false;
  const before = store.readObject(change.before).toString("utf8");
  const parts = before.split(tool.old_string);
  if (parts.length < 2 || (tool.replace_all !== true && parts.length !== 2)) return false;
  return parts.join(tool.new_string) === after;
}

function baselineState(store: EvidenceStore, pathname: string, tracked: Map<string, TrackedEntry>): FileState | null {
  const entry = tracked.get(pathname);
  return entry ? store.stateFromGitObject(entry.objectId, entry.mode) : null;
}

function findState(store: EvidenceStore, sessionId: string, turnId?: string): HookState | null {
  if (turnId) {
    return readState(store, statePath(store, sessionId, turnId));
  }
  return statesForSession(store, sessionId).at(-1) ?? null;
}

function statesForSession(store: EvidenceStore, sessionId: string): HookState[] {
  return activeStates(store).filter((state) => state.sessionId === sessionId);
}

function activeStates(store: EvidenceStore): HookState[] {
  const directory = stateDirectory(store);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readState(store, path.join(directory, name)))
    .filter((state): state is HookState => state !== null)
    .sort((left, right) => left.turnId.localeCompare(right.turnId));
}

function readState(store: EvidenceStore, target: string): HookState | null {
  if (!existsSync(target)) return null;
  return JSON.parse(readFileSync(target, "utf8")) as HookState;
}

function writeState(store: EvidenceStore, state: HookState): void {
  const target = statePath(store, state.sessionId, state.turnId);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function stateDirectory(store: EvidenceStore): string {
  return path.join(store.location.root, "hook-sessions");
}

function statePath(store: EvidenceStore, sessionId: string, turnId: string): string {
  return path.join(stateDirectory(store), `${digest(`${sessionId}\0${turnId}`)}.json`);
}

function isResponsibilityTool(toolName?: string): boolean {
  return Boolean(toolName && /^mcp__responsibility(?:-stack|_stack)?__/i.test(toolName));
}
