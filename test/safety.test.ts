import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EvidenceStore, RunSession, applyExactRollback, createFeatureCheckpoint, handleCodexHook, history, onboardRepository, planEditRollback, planFeatureRollback, planRunRollback, protectIntent, rollbackHunk, rollbackSymbol } from "../src/index.js";

function fixture(files: Record<string, string>) {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "respstack-safety-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Safety Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), content);
  }
  git("add", ".");
  git("commit", "-qm", "fixture");
  const store = new EvidenceStore(repo);
  store.initialize();
  const read = (name: string) => readFileSync(path.join(repo, name), "utf8");
  const write = (name: string, content: string) => writeFileSync(path.join(repo, name), content);
  const record = (name: string, content: string) => {
    const before = store.stateFromWorkingFile(name);
    const session = new RunSession(store, { intent: "fixture edit" });
    write(name, content);
    const event = session.record(name, before, store.stateFromWorkingFile(name));
    session.finish("completed", 0);
    assert.ok(event);
    return event;
  };
  return { repo, store, read, write, record, git };
}

test("hunk rollback refuses a duplicate block when the original has later edits", () => {
  const block = (name: string, value: number) => `${name}\nc1\nc2\nc3\nvalue=${value}\nc4\nc5\nc6\nend\n`;
  const f = fixture({ "code.txt": block("A", 1) + block("B", 2) });
  const event = f.record("code.txt", block("A", 2) + block("B", 2));
  const current = block("A", 3) + block("B", 2);
  f.write("code.txt", current);
  assert.throws(() => rollbackHunk(f.store, event.id, 1), /ambiguous|later edits/);
  assert.equal(f.read("code.txt"), current);
});

test("symbol rollback preserves sibling declarations and later sibling changes", () => {
  const f = fixture({ "code.ts": "export const alpha = () => 1, beta = () => 1;\n" });
  const event = f.record("code.ts", "export const alpha = () => 2, beta = () => 2;\n");
  f.write("code.ts", "export const alpha = () => 2, beta = () => 3;\n");
  rollbackSymbol(f.store, event.id, "alpha");
  assert.equal(f.read("code.ts"), "export const alpha = () => 1, beta = () => 3;\n");
});

test("rollback and interrupted recovery refuse symlink parents without writing outside the repository", () => {
  const f = fixture({ "src/code.txt": "before\n" });
  const event = f.record("src/code.txt", "after\n");
  const outside = mkdtempSync(path.join(tmpdir(), "respstack-outside-"));
  writeFileSync(path.join(outside, "code.txt"), "after\n");
  renameSync(path.join(f.repo, "src"), path.join(f.repo, "src-saved"));
  symlinkSync(outside, path.join(f.repo, "src"), "dir");
  assert.throws(() => applyExactRollback(f.store, planEditRollback(f.store, event.id), { eventId: event.id }), /symbolic link/);
  const journal = path.join(f.store.location.root, "rollback-journal.json");
  writeFileSync(journal, JSON.stringify([{ path: event.path, state: event.before }]));
  assert.throws(() => new EvidenceStore(f.repo).initialize(), /symbolic link/);
  assert.equal(readFileSync(path.join(outside, "code.txt"), "utf8"), "after\n");
  assert.equal(existsSync(journal), true);
});

test("rollback restores files and removes aborted evidence when signing fails", () => {
  const f = fixture({ "code.txt": "before\n" });
  const event = f.record("code.txt", "after\n");
  const key = path.join(f.store.location.keys, "private.pem");
  writeFileSync(key, "invalid signing key");
  assert.throws(() => applyExactRollback(f.store, planEditRollback(f.store, event.id), { eventId: event.id }));
  assert.equal(f.read("code.txt"), "after\n");
  assert.equal(f.store.listRuns().length, 1);
  assert.equal(existsSync(path.join(f.store.location.root, "rollback-journal.json")), false);
});

test("concurrent hooks preserve observations once without claiming the observing session authored them", () => {
  const f = fixture({ "a.ts": "1\n", "b.ts": "1\n" });
  const a = { cwd: f.repo, session_id: "a", turn_id: "a", prompt: "edit a" };
  const b = { cwd: f.repo, session_id: "b", turn_id: "b", prompt: "edit b" };
  handleCodexHook({ ...a, hook_event_name: "UserPromptSubmit" });
  handleCodexHook({ ...b, hook_event_name: "UserPromptSubmit" });
  f.write("a.ts", "2\n");
  handleCodexHook({ ...a, hook_event_name: "PostToolUse", tool_name: "Edit" });
  f.write("b.ts", "2\n");
  handleCodexHook({ ...b, hook_event_name: "PostToolUse", tool_name: "Edit" });
  handleCodexHook({ ...a, hook_event_name: "Stop" });
  handleCodexHook({ ...b, hook_event_name: "Stop" });
  const entries = history(f.store);
  assert.deepEqual(entries.map(({ event }) => event.path).sort(), ["a.ts", "b.ts"]);
  for (const { event, run } of entries) {
    assert.equal((event.source as { attribution?: string })?.attribution, "unattributed");
    assert.deepEqual(run.actor, {});
    assert.deepEqual(f.store.verifyRun(run.id), []);
  }
});

test("Git-backed evidence above one MiB remains readable and verifiable", () => {
  const content = "x".repeat(2 * 1024 * 1024);
  const f = fixture({ "large.json": content });
  const oid = f.git("rev-parse", "HEAD:large.json").trim();
  const state = f.store.stateFromGitObject(oid, 0o644);
  assert.equal(state.size, Buffer.byteLength(content));
  assert.equal(f.store.readObject(state).toString(), content);
});

test("intent redaction covers quoted keys, escaped values, nested JSON and short passwords", () => {
  for (const input of [
    '{"password":"FAKE_REVIEW_ONLY_123"}',
    '{"nested":{"password":"a\\\"b c","access_token":"abc"}}',
    "{'api_key': 'abc def'}",
    'password=pw password="short with spaces"',
  ]) {
    const protectedIntent = protectIntent(input);
    assert.equal(protectedIntent.redacted, true, input);
    assert.doesNotMatch(protectedIntent.value, /FAKE_REVIEW|abc|a\\"b|=pw|short with spaces/);
  }
  assert.equal(protectIntent("Explain the password field").value, "Explain the password field");
});

test("history refuses tampered signed intent instead of returning it as a fact", () => {
  const f = fixture({ "code.txt": "before\n" });
  const event = f.record("code.txt", "after\n");
  const runFile = path.join(f.store.location.runs, `${event.runId}.json`);
  const run = JSON.parse(readFileSync(runFile, "utf8"));
  run.intent = "forged user instruction";
  writeFileSync(runFile, JSON.stringify(run));
  assert.throws(() => history(f.store), /unverified evidence/);
});

test("onboard distinguishes initialized storage from an observed hook lifecycle", () => {
  const f = fixture({ "code.txt": "unchanged\n" });
  assert.equal(onboardRepository(f.store).ready, false);
  const input = { cwd: f.repo, session_id: "probe", turn_id: "probe" };
  handleCodexHook({ ...input, hook_event_name: "UserPromptSubmit", prompt: "read-only check" });
  assert.equal(onboardRepository(f.store).ready, false);
  handleCodexHook({ ...input, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "read-1" });
  handleCodexHook({ ...input, hook_event_name: "Stop" });
  assert.equal(onboardRepository(f.store).ready, true);
  assert.equal(f.store.listEvents().length, 0);
  assert.equal(f.read("code.txt"), "unchanged\n");
});

test("restart completes aborted recovery and does not undo signed completion", () => {
  const f = fixture({ "a.txt": "a0\n", "b.txt": "b0\n" });
  const beforeA = f.store.stateFromWorkingFile("a.txt");
  const beforeB = f.store.stateFromWorkingFile("b.txt");
  const target = { ...f.store.writeObject(Buffer.from("restored\n")), mode: 0o644 };
  const incomplete = new RunSession(f.store, { kind: "rollback", intent: "crash fixture" });
  f.write("a.txt", "restored\n");
  incomplete.record("a.txt", beforeA, target);
  const journal = path.join(f.store.location.root, "rollback-journal.json");
  writeFileSync(journal, JSON.stringify({ version: 2, runId: incomplete.run.id, entries: [
    { path: "a.txt", state: beforeA, target }, { path: "b.txt", state: beforeB, target },
  ] }));
  new EvidenceStore(f.repo).initialize();
  assert.equal(f.read("a.txt"), "a0\n");
  assert.equal(f.read("b.txt"), "b0\n");
  assert.equal(f.store.listRuns().length, 0);
  const completed = new RunSession(f.store, { kind: "rollback", intent: "completed fixture" });
  f.write("a.txt", "restored\n");
  completed.record("a.txt", beforeA, target);
  completed.finish("completed", 0);
  writeFileSync(journal, JSON.stringify({ version: 2, runId: completed.run.id, entries: [{ path: "a.txt", state: beforeA, target }] }));
  new EvidenceStore(f.repo).initialize();
  assert.equal(f.read("a.txt"), "restored\n");
  assert.deepEqual(f.store.verifyRun(completed.run.id), []);
  assert.equal(existsSync(journal), false);
});

test("recovery refuses to overwrite later manual edits to an interrupted transaction", () => {
  const f = fixture({ "code.txt": "before\n" });
  const before = f.store.stateFromWorkingFile("code.txt");
  const session = new RunSession(f.store, { kind: "rollback", intent: "crash fixture" });
  const target = { ...f.store.writeObject(Buffer.from("target\n")), mode: 0o644 };
  f.write("code.txt", "later manual edit\n");
  const journal = path.join(f.store.location.root, "rollback-journal.json");
  writeFileSync(journal, JSON.stringify({ version: 2, runId: session.run.id, entries: [{ path: "code.txt", state: before, target }] }));
  assert.throws(() => new EvidenceStore(f.repo).initialize(), /recovery conflicts/);
  assert.equal(f.read("code.txt"), "later manual edit\n");
  assert.equal(existsSync(journal), true);
});

test("a matched Edit is correlated but simultaneous unrelated edits stay unattributed", () => {
  const f = fixture({ "a.ts": "1\n", "human.txt": "old\n" });
  createFeatureCheckpoint(f.store, { name: "all", selectors: ["."] });
  const input = { cwd: f.repo, session_id: "single", turn_id: "single" };
  handleCodexHook({ ...input, hook_event_name: "UserPromptSubmit", prompt: "change a" });
  f.write("a.ts", "2\n");
  f.write("human.txt", "human change\n");
  handleCodexHook({ ...input, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "edit-a",
    tool_input: { file_path: "a.ts", old_string: "1", new_string: "2" },
  });
  handleCodexHook({ ...input, hook_event_name: "Stop" });
  const entries = history(f.store);
  assert.equal(entries.find(({ event }) => event.path === "a.ts")?.attribution, "tool-correlated");
  const unknown = entries.find(({ event }) => event.path === "human.txt")!;
  assert.equal(unknown.attribution, "unattributed");
  assert.throws(() => planRunRollback(f.store, unknown.run.id), /unattributed/);
  assert.throws(() => planFeatureRollback(f.store, "all"), /unattributed/);
  const preview = applyExactRollback(f.store, planEditRollback(f.store, unknown.event.id), { eventId: unknown.event.id }, true);
  assert.match(preview.warnings?.[0] ?? "", /unverified writer/);
  assert.equal(f.read("human.txt"), "human change\n");
});

test("onboard rejects stale and tampered capture receipts", () => {
  const f = fixture({ "code.txt": "unchanged\n" });
  const old = new Date(Date.now() - 3600_000).toISOString();
  f.store.writeCaptureReceipt({ adapter: "codex-hook", repositoryRoot: f.repo,
    sessionId: "old", turnId: "old", startedAt: old, toolObservedAt: old, completedAt: old,
  });
  const stale = onboardRepository(f.store);
  assert.equal(stale.ready, false);
  assert.equal(stale.storageReady, true);
  assert.equal(stale.capture.status, "stale");
  const file = path.join(f.store.location.root, "capture-health.json");
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  receipt.completedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(receipt));
  const tampered = onboardRepository(f.store);
  assert.equal(tampered.ready, false);
  assert.equal(tampered.capture.status, "invalid");
});

test("partial rollback also restores the pre-operation file on signing failure", () => {
  const f = fixture({ "code.ts": "export const a = () => 1, b = () => 1;\n" });
  const after = "export const a = () => 2, b = () => 2;\n";
  const event = f.record("code.ts", after);
  writeFileSync(path.join(f.store.location.keys, "private.pem"), "invalid key");
  assert.throws(() => rollbackSymbol(f.store, event.id, "a"));
  assert.equal(f.read("code.ts"), after);
  assert.equal(f.store.listRuns().length, 1);
});

test("hunk rollback preserves non-overlapping later edits and original line endings", () => {
  for (const eol of ["\n", "\r\n"]) {
    const lines = Array.from({ length: 18 }, (_, i) => `line-${i}`);
    lines[1] = "value=1";
    const f = fixture({ "code.txt": lines.join(eol) });
    lines[1] = "value=2";
    const event = f.record("code.txt", lines.join(eol));
    lines[16] = "later manual change";
    f.write("code.txt", lines.join(eol));
    rollbackHunk(f.store, event.id, 1);
    lines[1] = "value=1";
    assert.equal(f.read("code.txt"), lines.join(eol));
  }
});

test("symbol rollback refuses unsafe declaration deletion", () => {
  const f = fixture({ "code.ts": "export const beta = () => 1;\n" });
  const after = "export const alpha = () => 2, beta = () => 1;\n";
  const event = f.record("code.ts", after);
  assert.throws(() => rollbackSymbol(f.store, event.id, "alpha"), /declaration structure/);
  assert.equal(f.read("code.ts"), after);
});

test("rollback rejects symbolic file links and source-root targets", () => {
  const f = fixture({ "code.txt": "before\n" });
  const event = f.record("code.txt", "after\n");
  renameSync(path.join(f.repo, "code.txt"), path.join(f.repo, "saved.txt"));
  symlinkSync("saved.txt", path.join(f.repo, "code.txt"));
  assert.throws(() => applyExactRollback(f.store, planEditRollback(f.store, event.id), { eventId: event.id }), /symbolic link/);
  assert.equal(f.read("saved.txt"), "after\n");
  assert.throws(() => applyExactRollback(f.store, [{ path: ".", expected: null, target: event.before }], {}), /source file paths/);
});
