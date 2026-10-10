import path from "node:path";
import { EvidenceStore } from "./store.js";
import type { DriftReport, EditEvent, EditSource, RunRecord } from "./types.js";
import { normalizeRelative } from "./util.js";

export interface HistoryItem {
  event: EditEvent;
  run: RunRecord;
  attribution: NonNullable<EditSource["attribution"]>;
}

export function history(store: EvidenceStore, options: { path?: string; runId?: string } = {}): HistoryItem[] {
  const normalizedPath = options.path ? normalizeRelative(store.repositoryRoot, options.path) : undefined;
  return store.listRuns()
    .filter((run) => run.status !== "running" && (!options.runId || run.id === options.runId))
    .flatMap((run) => {
      const events = store.readEvents(run.id);
      const selected = events.filter((event) => !normalizedPath || normalizedPath === "." ||
        event.path === normalizedPath || event.path.startsWith(`${normalizedPath}/`));
      if (selected.length === 0) return [];
      const failures = store.verifyRunRecord(run, events);
      if (failures.length) throw new Error(`refusing unverified evidence: ${failures.join("; ")}`);
      return selected.map((event) => ({ event, run,
        attribution: event.source?.attribution ?? (run.kind === "rollback" ? "system" : "unattributed"),
      }));
    }).sort((left, right) => left.event.timestamp.localeCompare(right.event.timestamp));
}

export function driftReport(store: EvidenceStore, runId: string): DriftReport {
  const run = store.readRun(runId);
  const failures = store.verifyRun(runId);
  if (failures.length) throw new Error(`refusing unverified evidence: ${failures.join("; ")}`);
  const touchedPaths = [...new Set(store.readEvents(runId).map((event) => event.path))].sort();
  const outOfScopePaths = run.scope.length === 0
    ? []
    : touchedPaths.filter((pathname) => !run.scope.some((rule) => matchesPathRule(rule, pathname)));
  return { runId, scopeDeclared: run.scope.length > 0, touchedPaths, outOfScopePaths };
}

export function matchesPathRule(rule: string, pathname: string): boolean {
  const normalized = rule.split(path.sep).join("/").replace(/^\.\//, "");
  if (normalized === ".") return true;
  if (!normalized.includes("*")) return pathname === normalized || pathname.startsWith(`${normalized.replace(/\/$/, "")}/`);
  const expression = normalized
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${expression}$`).test(pathname);
}
