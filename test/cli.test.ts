import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EvidenceStore } from "../src/core/store.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const hook = fileURLToPath(new URL("../plugin/hook.cjs", import.meta.url));
const mcp = fileURLToPath(new URL("../plugin/mcp.cjs", import.meta.url));

test("records, verifies, explains, and exactly rolls back an edit", () => {
  const repository = makeRepository({ "src/value.ts": "export const value = 1;\n" });
  run(repository, ["init"]);
  run(repository, [
    "run",
    "--intent",
    "change value",
    "--agent",
    "codex",
    "--model",
    "test-model",
    "--scope",
    "src",
    "--",
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync('src/value.ts', 'export const value = 2;\\n')",
  ]);

  const entries = JSON.parse(run(repository, ["history", "--json"]).stdout) as Array<{
    event: { id: string; path: string };
    run: { id: string };
  }>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.event.path, "src/value.ts");
  assert.match(run(repository, ["why", "src/value.ts"]).stdout, /change value/);
  assert.equal(run(repository, ["check", entries[0]!.run.id]).status, 0);
  assert.equal(run(repository, ["verify"]).status, 0);

  run(repository, ["rollback", "edit", entries[0]!.event.id]);
  assert.equal(readFileSync(path.join(repository, "src/value.ts"), "utf8"), "export const value = 1;\n");
  assert.equal(run(repository, ["verify"]).status, 0);
});

test("Codex hooks expose committed shell edits as observations through MCP", () => {
  const repository = makeRepository({ "src/value.ts": "export const value = 1;\n" });
  const common = {
    session_id: "session-1",
    turn_id: "turn-1",
    cwd: repository,
    model: "test-model",
    permission_mode: "default",
  };
  runHook(repository, {
    ...common,
    hook_event_name: "UserPromptSubmit",
    prompt: "Change the value without touching anything else",
  });

  writeFileSync(path.join(repository, "src/value.ts"), "export const value = 2;\n");
  execFileSync("git", ["add", "src/value.ts"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "agent edit"], { cwd: repository });
  runHook(repository, {
    ...common,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "tool-1",
  });
  runHook(repository, { ...common, hook_event_name: "Stop" });

  const entries = JSON.parse(run(repository, ["history", "--json"]).stdout) as Array<{
    event: { id: string; path: string; source?: { toolName?: string; toolUseId?: string } };
    run: {
      intent: string;
      actor: { agent?: string; model?: string };
      source?: { adapter?: string; sessionId?: string; turnId?: string; observerActor?: { agent?: string; model?: string } };
    };
  }>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.event.path, "src/value.ts");
  assert.equal(entries[0]!.event.source?.toolName, "Bash");
  assert.equal(entries[0]!.event.source?.toolUseId, "tool-1");
  assert.equal(entries[0]!.run.intent, "Change the value without touching anything else");
  assert.deepEqual(entries[0]!.run.actor, {});
  assert.deepEqual(entries[0]!.run.source?.observerActor, { agent: "codex", model: "test-model" });
  assert.equal(entries[0]!.run.source?.adapter, "codex-hook");
  assert.equal(run(repository, ["verify"]).status, 0);

  const responses = runMcp(repository, "src/value.ts");
  const listed = responses.find((message) => message.id === 2)?.result as { tools?: Array<{ name: string }> };
  assert.ok(listed.tools?.some((tool) => tool.name === "responsibility_why"));
  assert.ok(listed.tools?.some((tool) => tool.name === "responsibility_onboard"));
  const queried = responses.find((message) => message.id === 3)?.result as {
    structuredContent?: { entries?: Array<{ model?: string | null; observedModel?: string; attribution?: string; toolName?: string }> };
  };
  assert.equal(queried.structuredContent?.entries?.[0]?.model, null);
  assert.equal(queried.structuredContent?.entries?.[0]?.observedModel, "test-model");
  assert.equal(queried.structuredContent?.entries?.[0]?.attribution, "unattributed");
  assert.equal(queried.structuredContent?.entries?.[0]?.toolName, "Bash");

  const plan = callMcp(repository, "responsibility_rollback_plan", {
    repository,
    kind: "edit",
    id: entries[0]!.event.id,
  }) as { structuredContent?: { applied?: boolean } };
  assert.equal(plan.structuredContent?.applied, false);
  const applied = callMcp(repository, "responsibility_rollback", {
    repository,
    kind: "edit",
    id: entries[0]!.event.id,
  }) as { structuredContent?: { applied?: boolean; rollbackRunId?: string } };
  assert.equal(applied.structuredContent?.applied, true);
  assert.ok(applied.structuredContent?.rollbackRunId);
  assert.equal(readFileSync(path.join(repository, "src/value.ts"), "utf8"), "export const value = 1;\n");
  assert.equal(run(repository, ["verify"]).status, 0);
});

test("Codex hooks discard turns that make no code changes", () => {
  const repository = makeRepository({ "readme.txt": "unchanged\n" });
  writeFileSync(path.join(repository, "readme.txt"), "pre-existing human change\n");
  const common = { session_id: "session-quiet", turn_id: "turn-quiet", cwd: repository, model: "test-model" };
  runHook(repository, { ...common, hook_event_name: "UserPromptSubmit", prompt: "Explain this repository" });
  runHook(repository, { ...common, hook_event_name: "Stop" });
  assert.match(run(repository, ["status"]).stdout, /Runs: 0/);
});

test("onboards an existing repository once without touching pre-existing changes", () => {
  const repository = makeRepository({ "src/value.ts": "export const value = 1;\n" });
  writeFileSync(path.join(repository, "src/value.ts"), "export const value = 2;\n");
  writeFileSync(path.join(repository, "notes.txt"), "local notes\n");

  const first = JSON.parse(run(repository, ["onboard", "--json"]).stdout) as {
    ready: boolean;
    storageReady: boolean;
    created: boolean;
    onboardingId: string;
    trackingStartedAt: string;
    trackedFileCount: number;
    preExistingChanges: string[];
  };
  assert.equal(first.ready, false);
  assert.equal(first.storageReady, true);
  assert.equal(first.created, true);
  assert.equal(first.trackedFileCount, 1);
  assert.deepEqual(first.preExistingChanges, ["notes.txt", "src/value.ts"]);

  const store = new EvidenceStore(repository);
  const privateKey = readFileSync(path.join(store.location.keys, "private.pem"), "utf8");
  const publicKey = readFileSync(path.join(store.location.keys, "public.pem"), "utf8");
  rmSync(path.join(store.location.keys, "public.pem"));
  const second = JSON.parse(run(repository, ["init", "--json"]).stdout) as typeof first;
  assert.equal(second.created, false);
  assert.equal(second.onboardingId, first.onboardingId);
  assert.equal(second.trackingStartedAt, first.trackingStartedAt);
  assert.equal(readFileSync(path.join(store.location.keys, "private.pem"), "utf8"), privateKey);
  assert.equal(readFileSync(path.join(store.location.keys, "public.pem"), "utf8"), publicKey);

  const mcpReport = callMcp(repository, "responsibility_onboard", { repository }) as {
    structuredContent?: { ready?: boolean; created?: boolean; onboardingId?: string };
  };
  assert.equal(mcpReport.structuredContent?.ready, false);
  assert.equal(mcpReport.structuredContent?.created, false);
  assert.equal(mcpReport.structuredContent?.onboardingId, first.onboardingId);
  assert.equal(readFileSync(path.join(repository, "src/value.ts"), "utf8"), "export const value = 2;\n");
  assert.equal(readFileSync(path.join(repository, "notes.txt"), "utf8"), "local notes\n");
  assert.match(run(repository, ["verify"]).stdout, /1 onboarding record/);

  const onboarding = JSON.parse(readFileSync(store.location.onboarding, "utf8")) as Record<string, unknown>;
  onboarding.trackedFileCount = 999;
  writeFileSync(store.location.onboarding, `${JSON.stringify(onboarding)}\n`);
  const unhealthy = run(repository, ["onboard", "--json"], true);
  assert.equal(unhealthy.status, 2);
  const unhealthyReport = JSON.parse(unhealthy.stdout) as { ready: boolean; failures: string[] };
  assert.equal(unhealthyReport.ready, false);
  assert.match(unhealthyReport.failures[0] ?? "", /invalid signature/);
});

test("tracks a named feature from an explicit known-good checkpoint", () => {
  const repository = makeRepository({
    "src/login.ts": "export function login() { return 'working'; }\n",
    "test/login.test.ts": "export const covered = true;\n",
    "src/unrelated.ts": "export const unrelated = 1;\n",
  });
  run(repository, [
    "feature",
    "checkpoint",
    "login",
    "--path",
    "src/login.ts",
    "--path",
    "test/login.test.ts",
    "--note",
    "verified manually",
  ]);
  recordHookEdits(repository, "change login and an unrelated module", {
    "src/login.ts": "export function login() { return 'broken'; }\n",
    "test/login.test.ts": "export const covered = false;\n",
    "src/unrelated.ts": "export const unrelated = 2;\n",
  });

  const statusResult = run(repository, ["feature", "status", "login", "--json"], true);
  assert.equal(statusResult.status, 2);
  const status = JSON.parse(statusResult.stdout) as { clean: boolean; modified: string[] };
  assert.equal(status.clean, false);
  assert.deepEqual(status.modified, ["src/login.ts", "test/login.test.ts"]);

  const entries = JSON.parse(run(repository, ["feature", "history", "login", "--json"]).stdout) as Array<{
    event: { path: string };
  }>;
  assert.deepEqual(entries.map(({ event }) => event.path).sort(), ["src/login.ts", "test/login.test.ts"]);

  const mcpStatus = callMcp(repository, "responsibility_feature_status", {
    repository,
    checkpoint: "login",
  }) as { structuredContent?: { status?: { modified?: string[] }; relatedEvents?: Array<{ path?: string }> } };
  assert.deepEqual(mcpStatus.structuredContent?.status?.modified, ["src/login.ts", "test/login.test.ts"]);
  assert.deepEqual(mcpStatus.structuredContent?.relatedEvents?.map(({ path }) => path).sort(), [
    "src/login.ts",
    "test/login.test.ts",
  ]);

  const cliPlan = run(repository, ["rollback", "feature", "login", "--dry-run"]).stdout;
  assert.match(cliPlan, /2 file\(s\)/);
  assert.match(cliPlan, /src\/login\.ts.*1 hunk\(s\), login/);

  const plan = callMcp(repository, "responsibility_rollback_plan", {
    repository,
    kind: "feature",
    id: "login",
  }) as {
    structuredContent?: {
      applied?: boolean;
      checkpointId?: string;
      changes?: Array<{ path?: string }>;
      impacts?: Array<{ path?: string; hunkCount?: number; symbols?: string[] }>;
    };
  };
  assert.equal(plan.structuredContent?.applied, false);
  assert.equal(plan.structuredContent?.changes?.length, 2);
  const loginImpact = plan.structuredContent?.impacts?.find(({ path }) => path === "src/login.ts");
  assert.equal(loginImpact?.hunkCount, 1);
  assert.deepEqual(loginImpact?.symbols, ["login"]);

  const applied = callMcp(repository, "responsibility_rollback", {
    repository,
    kind: "feature",
    id: "login",
  }) as { structuredContent?: { applied?: boolean; rollbackRunId?: string; checkpointId?: string } };
  assert.equal(applied.structuredContent?.applied, true);
  assert.ok(applied.structuredContent?.rollbackRunId);
  assert.equal(applied.structuredContent?.checkpointId, plan.structuredContent?.checkpointId);
  assert.equal(readFileSync(path.join(repository, "src/login.ts"), "utf8"), "export function login() { return 'working'; }\n");
  assert.equal(readFileSync(path.join(repository, "test/login.test.ts"), "utf8"), "export const covered = true;\n");
  assert.equal(readFileSync(path.join(repository, "src/unrelated.ts"), "utf8"), "export const unrelated = 2;\n");
  assert.equal(run(repository, ["feature", "status", "login"]).status, 0);
  assert.equal(new EvidenceStore(repository).listRuns().at(-1)?.sourceCheckpointId, plan.structuredContent?.checkpointId);
  assert.equal(run(repository, ["verify"]).status, 0);
});

test("feature recovery refuses unattributed or later edits", () => {
  const unattributed = makeRepository({ "src/value.ts": "export const value = 1;\n" });
  run(unattributed, ["feature", "checkpoint", "value", "--path", "src/value.ts"]);
  writeFileSync(path.join(unattributed, "src/value.ts"), "export const value = 2;\n");
  const gap = callMcp(unattributed, "responsibility_rollback_plan", {
    repository: unattributed,
    kind: "feature",
    id: "value",
  }) as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(gap.isError, true);
  assert.match(gap.content?.[0]?.text ?? "", /unattributed drift/);

  const later = makeRepository({ "src/value.ts": "export const value = 1;\n" });
  run(later, ["feature", "checkpoint", "value", "--path", "src/value.ts"]);
  recordHookEdits(later, "change value", { "src/value.ts": "export const value = 2;\n" });
  writeFileSync(path.join(later, "src/value.ts"), "export const value = 3;\n");
  const conflict = callMcp(later, "responsibility_rollback_plan", {
    repository: later,
    kind: "feature",
    id: "value",
  }) as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(conflict.isError, true);
  assert.match(conflict.content?.[0]?.text ?? "", /conflicts with later edits/);
  assert.equal(readFileSync(path.join(later, "src/value.ts"), "utf8"), "export const value = 3;\n");

  const interrupted = makeRepository({ "src/value.ts": "export const value = 1;\n" });
  run(interrupted, ["feature", "checkpoint", "value", "--path", "src/value.ts"]);
  recordHookEdits(interrupted, "first AI change", { "src/value.ts": "export const value = 2;\n" });
  writeFileSync(path.join(interrupted, "src/value.ts"), "export const value = 3;\n");
  recordHookEdits(interrupted, "second AI change", { "src/value.ts": "export const value = 4;\n" });
  const interruptedChain = callMcp(interrupted, "responsibility_rollback_plan", {
    repository: interrupted,
    kind: "feature",
    id: "value",
  }) as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(interruptedChain.isError, true);
  assert.match(interruptedChain.content?.[0]?.text ?? "", /unattributed drift/);
});

test("creates and lists a signed feature checkpoint through MCP", () => {
  const repository = makeRepository({ "src/payments.ts": "export const payments = 'working';\n" });
  const created = callMcp(repository, "responsibility_feature_checkpoint", {
    repository,
    name: "payments",
    paths: ["src/payments.ts"],
    note: "known good",
  }) as { structuredContent?: { checkpoint?: { id?: string; name?: string; fileCount?: number }; valid?: boolean } };
  assert.equal(created.structuredContent?.checkpoint?.name, "payments");
  assert.equal(created.structuredContent?.checkpoint?.fileCount, 1);
  assert.equal(created.structuredContent?.valid, true);

  const listed = callMcp(repository, "responsibility_feature_list", { repository, name: "payments" }) as {
    structuredContent?: { checkpoints?: Array<{ id?: string; valid?: boolean }> };
  };
  assert.equal(listed.structuredContent?.checkpoints?.[0]?.id, created.structuredContent?.checkpoint?.id);
  assert.equal(listed.structuredContent?.checkpoints?.[0]?.valid, true);
});

test("redacts common secrets before persisting hook intent", () => {
  const repository = makeRepository({ "src/config.ts": "export const configured = false;\n" });
  const secret = "supersecretvalue123";
  const common = { session_id: "session-secret", turn_id: "turn-secret", cwd: repository, model: "test-model" };
  runHook(repository, {
    ...common,
    hook_event_name: "UserPromptSubmit",
    prompt: `Configure login api_key=${secret} for the test`,
  });
  writeFileSync(path.join(repository, "src/config.ts"), "export const configured = true;\n");
  runHook(repository, { ...common, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "tool-secret" });
  runHook(repository, { ...common, hook_event_name: "Stop" });

  const output = run(repository, ["history", "--json"]).stdout;
  assert.doesNotMatch(output, new RegExp(secret));
  const entries = JSON.parse(output) as Array<{
    run: { intent: string; intentDigest?: string; intentRedacted?: boolean };
  }>;
  assert.match(entries[0]!.run.intent, /\[REDACTED\]/);
  assert.equal(entries[0]!.run.intentRedacted, true);
  assert.match(entries[0]!.run.intentDigest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(run(repository, ["verify"]).status, 0);
});

test("detects a tampered feature checkpoint", () => {
  const repository = makeRepository({ "src/value.ts": "export const value = 1;\n" });
  run(repository, ["feature", "checkpoint", "value", "--path", "src/value.ts"]);
  const checkpoints = JSON.parse(run(repository, ["feature", "list", "--json"]).stdout) as Array<{ id: string }>;
  const store = new EvidenceStore(repository);
  const checkpointPath = path.join(store.location.checkpoints, `${checkpoints[0]!.id}.json`);
  const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as Record<string, unknown>;
  checkpoint.note = "tampered";
  writeFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`);

  const result = run(repository, ["verify", checkpoints[0]!.id], true);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid signature/);
});

test("rolls back one hunk without reverting a separate edit", () => {
  const before = lines({ 1: "first = 1", 12: "last = 1" });
  const after = lines({ 1: "first = 2", 12: "last = 2" });
  const repository = makeRepository({ "app.txt": before });
  run(repository, ["init"]);
  run(repository, [
    "run",
    "--intent",
    "change two independent values",
    "--",
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync('app.txt', ${JSON.stringify(after)})`,
  ]);

  const event = firstEvent(repository);
  assert.match(run(repository, ["hunks", event.id]).stdout, /Hunk 2/);
  run(repository, ["rollback", "hunk", event.id, "1"]);

  const restored = readFileSync(path.join(repository, "app.txt"), "utf8");
  assert.match(restored, /first = 1/);
  assert.match(restored, /last = 2/);
});

test("rolls back one TypeScript symbol and preserves another", () => {
  const before = `export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 1;\n}\n`;
  const after = `export function alpha() {\n  return 2;\n}\n\nexport function beta() {\n  return 2;\n}\n`;
  const repository = makeRepository({ "service.ts": before });
  run(repository, ["init"]);
  run(repository, [
    "run",
    "--intent",
    "change service behavior",
    "--",
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync('service.ts', ${JSON.stringify(after)})`,
  ]);

  const event = firstEvent(repository);
  assert.match(run(repository, ["symbols", event.id]).stdout, /alpha/);
  run(repository, ["rollback", "symbol", event.id, "alpha"]);

  const restored = readFileSync(path.join(repository, "service.ts"), "utf8");
  assert.match(restored, /alpha\(\) \{\n  return 1/);
  assert.match(restored, /beta\(\) \{\n  return 2/);
});

test("reports changes outside declared responsibility scope", () => {
  const repository = makeRepository({ "src/app.ts": "app\n", "config.yml": "safe: true\n" });
  run(repository, ["init"]);
  run(repository, [
    "run",
    "--intent",
    "change app",
    "--scope",
    "src",
    "--",
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync('config.yml', 'safe: false\\n')",
  ]);
  const runId = firstEvent(repository).runId;
  const result = run(repository, ["check", runId]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /config.yml/);
});

test("refuses exact rollback after the same file changed again", () => {
  const repository = makeRepository({ "state.txt": "one\n" });
  run(repository, ["init"]);
  run(repository, [
    "run",
    "--intent",
    "change state",
    "--",
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync('state.txt', 'two\\n')",
  ]);
  const event = firstEvent(repository);
  writeFileSync(path.join(repository, "state.txt"), "three\n");

  const result = run(repository, ["rollback", "edit", event.id], true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflicts with later edits/);
  assert.equal(readFileSync(path.join(repository, "state.txt"), "utf8"), "three\n");
});

test("recovers an interrupted multi-file rollback journal", () => {
  const repository = makeRepository({ "state.txt": "before\n" });
  const store = new EvidenceStore(repository);
  store.initialize();
  const original = store.stateFromWorkingFile("state.txt");
  assert.ok(original);
  writeFileSync(path.join(repository, "state.txt"), "partially-applied\n");
  writeFileSync(
    path.join(store.location.root, "rollback-journal.json"),
    `${JSON.stringify([{ path: "state.txt", state: original }])}\n`,
  );

  new EvidenceStore(repository).initialize();
  assert.equal(readFileSync(path.join(repository, "state.txt"), "utf8"), "before\n");
});

test("CLI and MCP refuse forged intent and expose real capture readiness", () => {
  const repository = makeRepository({ "code.txt": "before\n" });
  recordHookEdits(repository, '{"password":"FAKE_JSON_PASSWORD"}', { "code.txt": "after\n" });
  const ready = callMcp(repository, "responsibility_onboard", { repository }) as {
    structuredContent?: { ready?: boolean; capture?: { status?: string } };
  };
  assert.equal(ready.structuredContent?.ready, true);
  assert.equal(ready.structuredContent?.capture?.status, "observed");
  const store = new EvidenceStore(repository);
  const runRecord = store.listRuns()[0]!;
  assert.doesNotMatch(runRecord.intent, /FAKE_JSON_PASSWORD/);
  assert.equal(runRecord.intentRedacted, true);
  writeFileSync(path.join(store.location.runs, `${runRecord.id}.json`), JSON.stringify({ ...runRecord, intent: "forged user instruction" }));
  const why = run(repository, ["why", "code.txt"], true);
  assert.equal(why.status, 1);
  assert.doesNotMatch(why.stdout, /forged user instruction/);
  assert.match(why.stderr, /invalid signature/);
  for (const name of ["responsibility_why", "responsibility_history"]) {
    const result = callMcp(repository, name, { repository, path: "code.txt" }) as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /invalid signature/);
    assert.doesNotMatch(JSON.stringify(result), /forged user instruction/);
  }
});

function makeRepository(files: Record<string, string>): string {
  const directory = mkdtempSync(path.join(tmpdir(), "respstack-"));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  for (const [name, content] of Object.entries(files)) {
    execFileSync("mkdir", ["-p", path.dirname(path.join(directory, name))]);
    writeFileSync(path.join(directory, name), content);
  }
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: directory });
  return directory;
}

function run(repository: string, args: string[], allowFailure = false): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repository, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure && !["check"].includes(args[0] ?? "")) {
    assert.fail(`respstack ${args.join(" ")} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function runHook(repository: string, payload: Record<string, unknown>): void {
  const result = spawnSync(process.execPath, [hook], {
    cwd: repository,
    encoding: "utf8",
    input: `${JSON.stringify(payload)}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
}

function recordHookEdits(repository: string, prompt: string, files: Record<string, string>): void {
  const common = { cwd: repository, session_id: "edit-session", turn_id: `turn-${prompt}`, model: "test-model" };
  runHook(repository, { ...common, hook_event_name: "UserPromptSubmit", prompt });
  for (const [file, content] of Object.entries(files)) {
    const before = readFileSync(path.join(repository, file), "utf8");
    writeFileSync(path.join(repository, file), content);
    runHook(repository, { ...common, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: `edit-${file}`,
      tool_input: { file_path: file, old_string: before, new_string: content },
    });
  }
  runHook(repository, { ...common, hook_event_name: "Stop" });
}

function runMcp(repository: string, pathname: string): Array<{ id?: number; result?: unknown }> {
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "responsibility-stack-test", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "responsibility_why", arguments: { repository, path: pathname } },
    },
  ];
  const result = spawnSync(process.execPath, [mcp], {
    cwd: repository,
    encoding: "utf8",
    input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id?: number; result?: unknown });
}

function callMcp(repository: string, name: string, args: Record<string, unknown>): unknown {
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "responsibility-stack-test", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
  ];
  const result = spawnSync(process.execPath, [mcp], {
    cwd: repository,
    encoding: "utf8",
    input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id?: number; result?: unknown })
    .find((message) => message.id === 2);
  assert.ok(response);
  return response.result;
}

function firstEvent(repository: string): { id: string; runId: string } {
  const entries = JSON.parse(run(repository, ["history", "--json"]).stdout) as Array<{
    event: { id: string; runId: string };
  }>;
  assert.ok(entries[0]);
  return entries[0].event;
}

function lines(changes: Record<number, string>): string {
  return Array.from({ length: 16 }, (_, index) => changes[index + 1] ?? `line ${index + 1}`).join("\n") + "\n";
}
