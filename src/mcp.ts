#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createFeatureCheckpoint,
  featureHistory,
  featureStatus,
  listFeatureCheckpoints,
} from "./core/features.js";
import { onboardRepository } from "./core/onboarding.js";
import { history } from "./core/query.js";
import {
  applyExactRollback,
  planEditRollback,
  planRunRollback,
  rollbackFeature,
  rollbackHunk,
  rollbackSymbol,
  type RollbackResult,
} from "./core/rollback.js";
import { EvidenceStore } from "./core/store.js";
import { discoverRepository } from "./core/util.js";

const server = new Server(
  { name: "responsibility-stack", version: "0.5.0" },
  { capabilities: { tools: {} } },
);

const repositorySchema = {
  type: "string",
  description: "Absolute path inside the Git repository being inspected.",
} as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "responsibility_onboard",
      description: "Idempotently initialize signed local evidence and establish when responsibility tracking begins. Does not modify or snapshot source files.",
      inputSchema: {
        type: "object",
        properties: { repository: repositorySchema },
        required: ["repository"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "responsibility_history",
      description: "List compact, signed AI edit history without loading source snapshots into the conversation.",
      inputSchema: {
        type: "object",
        properties: {
          repository: repositorySchema,
          path: { type: "string", description: "Optional repository-relative file or directory path." },
          runId: { type: "string", description: "Optional responsibility run id." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        required: ["repository"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "responsibility_why",
      description: "Return verified change observations, attribution confidence, observing AI turn/tool, intent and timestamp. Unattributed observations do not identify the writer.",
      inputSchema: {
        type: "object",
        properties: { repository: repositorySchema, path: { type: "string" } },
        required: ["repository", "path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "responsibility_verify",
      description: "Verify hash chains, stored objects, and Ed25519 signatures for runs and feature checkpoints.",
      inputSchema: {
        type: "object",
        properties: { repository: repositorySchema, runId: { type: "string" } },
        required: ["repository"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "responsibility_feature_checkpoint",
      description: "Explicitly mark the current source state for a named feature as a signed known-good reference.",
      inputSchema: {
        type: "object",
        properties: {
          repository: repositorySchema,
          name: { type: "string", minLength: 1, maxLength: 128 },
          paths: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
            description: "Smallest repository-relative files, directories, or glob patterns that define the feature.",
          },
          note: { type: "string", description: "Optional reason this state is considered known-good." },
        },
        required: ["repository", "name", "paths"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "responsibility_feature_list",
      description: "List signed feature checkpoints without loading their source snapshots.",
      inputSchema: {
        type: "object",
        properties: { repository: repositorySchema, name: { type: "string" } },
        required: ["repository"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "responsibility_feature_status",
      description: "Compare a feature's current files with its latest or specified signed checkpoint.",
      inputSchema: featureReferenceSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "responsibility_feature_history",
      description: "List attributable edits to a feature since its latest or specified checkpoint.",
      inputSchema: {
        ...featureReferenceSchema,
        properties: {
          ...featureReferenceSchema.properties,
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "responsibility_rollback_plan",
      description: "Fail-closed dry run for an exact run/edit/feature rollback or a transplanted hunk/symbol rollback.",
      inputSchema: rollbackSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "responsibility_rollback",
      description: "Apply a previously requested responsibility rollback and record the rollback as a new signed run.",
      inputSchema: rollbackSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  ],
}));

const rollbackSchema = {
  type: "object",
  properties: {
    repository: repositorySchema,
    kind: { type: "string", enum: ["run", "edit", "hunk", "symbol", "feature"] },
    id: { type: "string", description: "Run id, edit event id, or feature checkpoint id/name for the selected kind." },
    detail: { description: "Hunk number or symbol name when kind is hunk or symbol." },
  },
  required: ["repository", "kind", "id"],
  additionalProperties: false,
} as const;

const featureReferenceSchema = {
  type: "object",
  properties: {
    repository: repositorySchema,
    checkpoint: { type: "string", description: "Feature name or exact checkpoint id." },
  },
  required: ["repository", "checkpoint"],
  additionalProperties: false,
} as const;

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = objectArgs(request.params.arguments);
    const store = new EvidenceStore(discoverRepository(requiredString(args, "repository")));
    store.initialize();

    if (request.params.name === "responsibility_onboard") {
      return result({ ...withLock(store, () => onboardRepository(store)) });
    }

    if (request.params.name === "responsibility_history") {
      const path = optionalString(args, "path");
      const runId = optionalString(args, "runId");
      const limit = Math.min(100, Math.max(1, optionalNumber(args, "limit") ?? 20));
      const entries = history(store, {
        ...(path ? { path } : {}),
        ...(runId ? { runId } : {}),
      })
        .filter(({ run }) => run.status !== "running")
        .slice(-limit)
        .reverse()
        .map(compactHistory);
      return result({ entries, count: entries.length });
    }

    if (request.params.name === "responsibility_why") {
      const path = requiredString(args, "path");
      const entries = history(store, { path })
        .filter(({ run }) => run.status !== "running")
        .slice(-20)
        .reverse()
        .map(compactHistory);
      return result({ path, entries, count: entries.length });
    }

    if (request.params.name === "responsibility_verify") {
      const runId = optionalString(args, "runId");
      const runIds = runId
        ? [runId]
        : store.listRuns().filter((run) => run.status !== "running").map((run) => run.id);
      const failures = runIds.flatMap((id) => store.verifyRun(id));
      const checkpointIds = runId ? [] : store.listCheckpoints().map((checkpoint) => checkpoint.id);
      failures.push(...checkpointIds.flatMap((id) => store.verifyCheckpoint(id)));
      const onboarding = store.readOnboarding();
      if (!runId) failures.push(...store.verifyOnboarding());
      return result({
        valid: failures.length === 0,
        checkedRuns: runIds.length,
        checkedCheckpoints: checkpointIds.length,
        checkedOnboardingRecords: !runId && onboarding ? 1 : 0,
        failures,
      });
    }

    if (request.params.name === "responsibility_feature_checkpoint") {
      const note = optionalString(args, "note");
      const checkpoint = withLock(store, () =>
        createFeatureCheckpoint(store, {
          name: requiredString(args, "name"),
          selectors: requiredStringArray(args, "paths"),
          ...(note ? { note } : {}),
        }),
      );
      return result({ checkpoint: compactCheckpoint(checkpoint), valid: store.verifyCheckpoint(checkpoint.id).length === 0 });
    }

    if (request.params.name === "responsibility_feature_list") {
      const checkpoints = listFeatureCheckpoints(store, optionalString(args, "name")).map((checkpoint) => ({
        ...compactCheckpoint(checkpoint),
        valid: store.verifyCheckpoint(checkpoint.id).length === 0,
      }));
      return result({ checkpoints, count: checkpoints.length });
    }

    if (request.params.name === "responsibility_feature_status") {
      const checkpoint = requiredString(args, "checkpoint");
      const status = featureStatus(store, checkpoint);
      const relatedEvents = featureHistory(store, checkpoint).slice(-20).reverse().map(compactHistory);
      return result({ status, relatedEvents });
    }

    if (request.params.name === "responsibility_feature_history") {
      const checkpoint = requiredString(args, "checkpoint");
      const limit = Math.min(100, Math.max(1, optionalNumber(args, "limit") ?? 20));
      const entries = featureHistory(store, checkpoint).slice(-limit).reverse().map(compactHistory);
      return result({ checkpoint, entries, count: entries.length });
    }

    if (request.params.name === "responsibility_rollback_plan") {
      return result(withLock(store, () => compactRollback(runRollback(store, args, true))));
    }

    if (request.params.name === "responsibility_rollback") {
      return result(withLock(store, () => compactRollback(runRollback(store, args, false))));
    }

    throw new Error(`unknown tool: ${request.params.name}`);
  } catch (error) {
    return {
      content: [{ type: "text", text: (error as Error).message }],
      isError: true,
    };
  }
});

server.connect(new StdioServerTransport()).catch((error: unknown) => {
  console.error(`responsibility-stack MCP: ${(error as Error).message}`);
  process.exitCode = 1;
});

function runRollback(store: EvidenceStore, args: Record<string, unknown>, dryRun: boolean): RollbackResult {
  const kind = requiredString(args, "kind");
  const id = requiredString(args, "id");
  if (kind === "edit") return applyExactRollback(store, planEditRollback(store, id), { eventId: id }, dryRun);
  if (kind === "run") return applyExactRollback(store, planRunRollback(store, id), { runId: id }, dryRun);
  if (kind === "hunk") return rollbackHunk(store, id, requiredInteger(args, "detail"), dryRun);
  if (kind === "symbol") return rollbackSymbol(store, id, requiredString(args, "detail"), dryRun);
  if (kind === "feature") return rollbackFeature(store, id, dryRun);
  throw new Error(`unsupported rollback kind: ${kind}`);
}

function compactHistory({ event, run, attribution }: ReturnType<typeof history>[number]): Record<string, unknown> {
  const intent = run.intent.length > 500 ? `${run.intent.slice(0, 500)}…` : run.intent;
  const observer = run.source?.observerActor ?? run.actor;
  const actor = attribution === "unattributed" ? {} : attribution === "tool-correlated" ? observer : run.actor;
  return {
    eventId: event.id,
    runId: run.id,
    timestamp: event.timestamp,
    path: event.path,
    operation: event.operation,
    intent,
    intentTruncated: intent.length !== run.intent.length,
    intentRedacted: run.intentRedacted ?? false,
    agent: actor.agent ?? "unknown",
    model: actor.model ?? null,
    attribution,
    attributionReason: event.source?.attributionReason ?? null,
    observedAgent: observer.agent ?? null,
    observedModel: observer.model ?? null,
    intentIsObserverContext: attribution === "unattributed",
    adapter: run.source?.adapter ?? "cli-wrapper",
    sessionId: run.source?.sessionId ?? null,
    turnId: run.source?.turnId ?? null,
    toolName: event.source?.toolName ?? null,
    toolUseId: event.source?.toolUseId ?? null,
    sourceCheckpointId: run.sourceCheckpointId ?? null,
  };
}

function compactCheckpoint(checkpoint: ReturnType<typeof listFeatureCheckpoints>[number]): Record<string, unknown> {
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

function compactRollback(value: RollbackResult): Record<string, unknown> {
  return {
    kind: value.kind,
    applied: Boolean(value.run),
    rollbackRunId: value.run?.id ?? null,
    checkpointId: value.checkpointId ?? null,
    impacts: value.impacts ?? [],
    warnings: value.warnings ?? [],
    changes: value.changes.map((change) => ({
      path: change.path,
      expectedDigest: change.expected?.digest ?? null,
      targetDigest: change.target?.digest ?? null,
    })),
  };
}

function result(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function withLock<T>(store: EvidenceStore, operation: () => T): T {
  const release = store.acquireLock();
  try {
    return operation();
  } finally {
    release();
  }
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function requiredStringArray(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value as string[];
}

function requiredInteger(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
