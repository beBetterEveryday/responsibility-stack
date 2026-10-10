#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createFeatureCheckpoint,
  featureHistory,
  featureStatus,
  listFeatureCheckpoints,
} from "./core/features.js";
import { onboardRepository } from "./core/onboarding.js";
import { driftReport, history } from "./core/query.js";
import { RunSession, WorkspaceRecorder } from "./core/recorder.js";
import {
  applyExactRollback,
  formatEventHunks,
  planEditRollback,
  planRunRollback,
  rollbackFeature,
  rollbackHunk,
  rollbackSymbol,
} from "./core/rollback.js";
import { EvidenceStore } from "./core/store.js";
import { changedSymbols } from "./core/symbols.js";
import { discoverRepository } from "./core/util.js";

const HELP = `ResponsibilityStack — trace responsibility, not blame.

Usage:
  respstack onboard [path] [--json]
  respstack init [path] [--json]
  respstack run --intent <text> [--agent <name>] [--model <name>] [--scope <path>] -- <command>
  respstack history [--path <path>] [--run <id>] [--json]
  respstack why <path>
  respstack show <run-or-edit-id>
  respstack check <run-id>
  respstack hunks <edit-id>
  respstack symbols <edit-id>
  respstack rollback edit <edit-id> [--dry-run]
  respstack rollback run <run-id> [--dry-run]
  respstack rollback hunk <edit-id> <number> [--dry-run]
  respstack rollback symbol <edit-id> <symbol> [--dry-run]
  respstack rollback feature <checkpoint-or-name> [--dry-run]
  respstack feature checkpoint <name> --path <path> [--path <path>] [--note <text>]
  respstack feature list [name] [--json]
  respstack feature status <checkpoint-or-name> [--json]
  respstack feature history <checkpoint-or-name> [--json]
  respstack verify [run-or-checkpoint-id]
  respstack status
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "init" || command === "onboard") {
    const repositoryRoot = discoverRepository(args.find((arg) => !arg.startsWith("--")) ?? process.cwd());
    const store = new EvidenceStore(repositoryRoot);
    const release = store.acquireLock();
    try {
      const report = onboardRepository(store);
      if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
      else printOnboarding(report);
      return report.storageReady ? 0 : 2;
    } finally {
      release();
    }
  }

  const store = new EvidenceStore(discoverRepository());
  store.initialize();

  if (command === "run") return runCommand(store, args);
  if (command === "history") return historyCommand(store, args);
  if (command === "why") return whyCommand(store, required(args[0], "path"));
  if (command === "show") return showCommand(store, required(args[0], "run or edit id"));
  if (command === "check") return checkCommand(store, required(args[0], "run id"));
  if (command === "hunks") return hunksCommand(store, required(args[0], "edit id"));
  if (command === "symbols") return symbolsCommand(store, required(args[0], "edit id"));
  if (command === "rollback") return rollbackCommand(store, args);
  if (command === "feature") return featureCommand(store, args);
  if (command === "verify") return verifyCommand(store, args[0]);
  if (command === "status") return statusCommand(store);
  throw new Error(`unknown command: ${command}\n\n${HELP}`);
}

async function runCommand(store: EvidenceStore, args: string[]): Promise<number> {
  const separator = args.indexOf("--");
  if (separator < 0) throw new Error("run requires -- before the wrapped command");
  const options = args.slice(0, separator);
  const childCommand = args.slice(separator + 1);
  const intentFile = option(options, "--intent-file");
  const intent =
    option(options, "--intent") ??
    (intentFile ? readFileSync(intentFile, "utf8").trim() : process.env.RESPSTACK_INTENT) ??
    "Undeclared";
  const release = store.acquireLock();
  const session = new RunSession(store, {
    intent,
    scope: optionsFor(options, "--scope"),
    actor: {},
    source: { adapter: "cli-wrapper", observerActor: compact({ agent: option(options, "--agent"), model: option(options, "--model") }) },
    command: childCommand,
  });

  try {
    console.log(`Recording ${session.run.id}`);
    const exitCode = await new WorkspaceRecorder(store, session).run(childCommand);
    const run = session.finish(exitCode === 0 ? "completed" : "failed", exitCode);
    console.log(`${run.id}: ${run.eventCount} edit(s), exit ${exitCode}`);
    return exitCode;
  } catch (error) {
    session.finish("failed", 1);
    throw error;
  } finally {
    release();
  }
}

function historyCommand(store: EvidenceStore, args: string[]): number {
  const pathOption = option(args, "--path");
  const runId = option(args, "--run");
  const items = history(store, {
    ...(pathOption ? { path: pathOption } : {}),
    ...(runId ? { runId } : {}),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(items, null, 2));
    return 0;
  }
  for (const { event, run, attribution } of items) {
    console.log(`${event.id}  ${event.operation.padEnd(6)}  ${event.path}  ${attribution}  ${run.intent}`);
  }
  if (items.length === 0) console.log("No recorded edits.");
  return 0;
}

function whyCommand(store: EvidenceStore, pathname: string): number {
  const items = history(store, { path: pathname });
  for (const { event, run, attribution } of items) {
    console.log(`${event.timestamp}  ${event.id}`);
    console.log(`  ${event.operation} ${event.path}`);
    console.log(`  intent: ${run.intent}`);
    const observer = run.source?.observerActor ?? run.actor;
    console.log(`  attribution: ${attribution}${event.source?.attributionReason ? ` (${event.source.attributionReason})` : ""}`);
    console.log(`  observed agent: ${observer.agent ?? "unknown"}${observer.model ? ` / ${observer.model}` : ""}`);
  }
  if (items.length === 0) console.log("No responsibility evidence found.");
  return 0;
}

function showCommand(store: EvidenceStore, id: string): number {
  const value = id.startsWith("run_") ? store.readRun(id) : store.findEvent(id);
  const runId = "runId" in value ? value.runId : value.id;
  const failures = store.verifyRun(runId);
  if (failures.length) throw new Error(`refusing unverified evidence: ${failures.join("; ")}`);
  console.log(JSON.stringify(value, null, 2));
  return 0;
}

function checkCommand(store: EvidenceStore, runId: string): number {
  const report = driftReport(store, runId);
  console.log(`Touched: ${report.touchedPaths.length}`);
  if (!report.scopeDeclared) {
    console.log("Responsibility scope: not declared");
    return 1;
  }
  if (report.outOfScopePaths.length === 0) {
    console.log("Responsibility scope: intact");
    return 0;
  }
  console.log("Responsibility scope: drifted");
  for (const pathname of report.outOfScopePaths) console.log(`  ${pathname}`);
  return 2;
}

function hunksCommand(store: EvidenceStore, eventId: string): number {
  console.log(formatEventHunks(store, eventId));
  return 0;
}

function symbolsCommand(store: EvidenceStore, eventId: string): number {
  const event = store.findEvent(eventId);
  const failures = store.verifyRun(event.runId);
  if (failures.length) throw new Error(`refusing unverified evidence: ${failures.join("; ")}`);
  const before = event.before ? store.readObject(event.before).toString("utf8") : "";
  const after = event.after ? store.readObject(event.after).toString("utf8") : "";
  const symbols = changedSymbols(event.path, before, after);
  for (const symbol of symbols) console.log(`${symbol.kind.padEnd(18)} ${symbol.name}`);
  if (symbols.length === 0) console.log("No changed JavaScript/TypeScript symbols found.");
  return 0;
}

function rollbackCommand(store: EvidenceStore, args: string[]): number {
  const [kind, id, detail] = args.filter((arg) => arg !== "--dry-run");
  const dryRun = args.includes("--dry-run");
  if (!kind || !id) throw new Error("rollback requires a kind and id");
  const release = store.acquireLock();
  try {
    const result =
      kind === "edit"
        ? applyExactRollback(store, planEditRollback(store, id), { eventId: id }, dryRun)
        : kind === "run"
          ? applyExactRollback(store, planRunRollback(store, id), { runId: id }, dryRun)
          : kind === "hunk"
            ? rollbackHunk(store, id, Number.parseInt(required(detail, "hunk number"), 10), dryRun)
          : kind === "symbol"
              ? rollbackSymbol(store, id, required(detail, "symbol"), dryRun)
              : kind === "feature"
                ? rollbackFeature(store, id, dryRun)
                : null;
    if (!result) throw new Error(`unknown rollback kind: ${kind}`);
    console.log(`${dryRun ? "Would apply" : "Applied"} ${result.kind} rollback to ${result.changes.length} file(s).`);
    for (const warning of result.warnings ?? []) console.log(`Warning: ${warning}`);
    for (const impact of result.impacts ?? []) {
      const detail = [impact.hunkCount === null ? "binary" : `${impact.hunkCount} hunk(s)`, ...impact.symbols].join(", ");
      console.log(`  ${impact.operation.padEnd(6)} ${impact.path}  ${detail}`);
    }
    if (result.run) console.log(`Recorded as ${result.run.id}`);
    return 0;
  } finally {
    release();
  }
}

function featureCommand(store: EvidenceStore, args: string[]): number {
  const [action, reference] = args;
  if (action === "checkpoint") {
    const name = required(reference, "feature name");
    const selectors = optionsFor(args.slice(2), "--path");
    const note = option(args.slice(2), "--note");
    const release = store.acquireLock();
    try {
      const checkpoint = createFeatureCheckpoint(store, {
        name,
        selectors,
        ...(note ? { note } : {}),
      });
      console.log(`${checkpoint.id}: ${Object.keys(checkpoint.states).length} file(s) captured for ${checkpoint.name}.`);
      return 0;
    } finally {
      release();
    }
  }

  if (action === "list") {
    const name = reference?.startsWith("--") ? undefined : reference;
    const checkpoints = listFeatureCheckpoints(store, name).map(compactCheckpoint);
    if (args.includes("--json")) console.log(JSON.stringify(checkpoints, null, 2));
    else if (checkpoints.length === 0) console.log("No feature checkpoints.");
    else {
      for (const checkpoint of checkpoints) {
        console.log(`${checkpoint.id}  ${checkpoint.createdAt}  ${checkpoint.name}  ${checkpoint.fileCount} file(s)`);
      }
    }
    return 0;
  }

  const idOrName = required(reference, "checkpoint or feature name");
  if (action === "status") {
    const status = featureStatus(store, idOrName);
    if (args.includes("--json")) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`${status.name}: ${status.clean ? "matches checkpoint" : "changed since checkpoint"}`);
      for (const pathname of status.added) console.log(`  added     ${pathname}`);
      for (const pathname of status.modified) console.log(`  modified  ${pathname}`);
      for (const pathname of status.deleted) console.log(`  deleted   ${pathname}`);
    }
    return status.clean ? 0 : 2;
  }
  if (action === "history") {
    const items = featureHistory(store, idOrName);
    if (args.includes("--json")) console.log(JSON.stringify(items, null, 2));
    else if (items.length === 0) console.log("No recorded edits since this checkpoint.");
    else {
      for (const { event, run } of items) {
        console.log(`${event.id}  ${event.operation.padEnd(6)}  ${event.path}  ${run.intent}`);
      }
    }
    return 0;
  }
  throw new Error(`unknown feature command: ${action ?? ""}`);
}

function verifyCommand(store: EvidenceStore, id?: string): number {
  const runIds = id?.startsWith("run_")
    ? [id]
    : id
      ? []
      : store.listRuns().filter((run) => run.status !== "running").map((run) => run.id);
  const checkpointIds = id?.startsWith("checkpoint_")
    ? [id]
    : id
      ? []
      : store.listCheckpoints().map((checkpoint) => checkpoint.id);
  const onboarding = store.readOnboarding();
  const verifyOnboarding = !id || id === onboarding?.id;
  if (id && runIds.length + checkpointIds.length === 0 && !verifyOnboarding) {
    throw new Error(`${id} is not a run, checkpoint, or onboarding id`);
  }
  const failures = runIds.flatMap((id) => store.verifyRun(id));
  failures.push(...checkpointIds.flatMap((checkpointId) => store.verifyCheckpoint(checkpointId)));
  if (verifyOnboarding) failures.push(...store.verifyOnboarding());
  if (failures.length === 0) {
    console.log(
      `Verified ${runIds.length} run(s), ${checkpointIds.length} checkpoint(s), and ${verifyOnboarding && onboarding ? 1 : 0} onboarding record(s).`,
    );
    return 0;
  }
  for (const failure of failures) console.error(failure);
  return 2;
}

function statusCommand(store: EvidenceStore): number {
  const runs = store.listRuns();
  console.log(`Store: ${store.location.root}`);
  console.log(`Runs: ${runs.length}`);
  console.log(`Edits: ${store.listEvents().length}`);
  console.log(`Checkpoints: ${store.listCheckpoints().length}`);
  console.log(`Tracking since: ${store.readOnboarding()?.createdAt ?? "not onboarded"}`);
  return 0;
}

function printOnboarding(report: ReturnType<typeof onboardRepository>): void {
  console.log(report.ready ? "ResponsibilityStack storage is ready; a recent hook lifecycle was observed." :
    report.storageReady ? "Storage initialized; automatic capture is not verified." : "ResponsibilityStack needs attention.");
  console.log(`Repository: ${report.repositoryRoot}`);
  console.log(`Evidence: ${report.storeRoot}`);
  console.log(`Tracking since: ${report.trackingStartedAt}${report.created ? " (created now)" : ""}`);
  console.log(`Signing key: ${report.keyFingerprint}`);
  console.log(`Tracked files: ${report.trackedFileCount}`);
  console.log(`Pre-existing changes: ${report.preExistingChangeCount} (not attributed)`);
  console.log(`Capture: ${report.capture.status}; last observed: ${report.capture.lastObservedAt ?? "never"}`);
  for (const step of report.nextSteps) console.log(step);
  for (const failure of report.failures) console.error(`  ${failure}`);
}

function compactCheckpoint(checkpoint: ReturnType<typeof listFeatureCheckpoints>[number]) {
  return {
    id: checkpoint.id,
    name: checkpoint.name,
    createdAt: checkpoint.createdAt,
    selectors: checkpoint.selectors,
    fileCount: Object.keys(checkpoint.states).length,
    note: checkpoint.note ?? null,
    previousCheckpointId: checkpoint.previousCheckpointId,
  };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : required(args[index + 1], `${name} value`);
}

function optionsFor(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(required(args[index + 1], `${name} value`));
  }
  return values.flatMap((value) => value.split(",").map((item) => item.trim()).filter(Boolean));
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === "") throw new Error(`missing ${name}`);
  return value;
}

function compact<T extends Record<string, string | undefined>>(value: T): { [K in keyof T]?: string } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as { [K in keyof T]?: string };
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`respstack: ${(error as Error).message}`);
    process.exitCode = 1;
  });
