import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type {
  CaptureReceipt,
  CaptureReceiptBody,
  EditEvent,
  EditEventBody,
  FeatureCheckpoint,
  FeatureCheckpointBody,
  FileState,
  RepositoryOnboarding,
  RepositoryOnboardingBody,
  RunRecord,
  Signature,
} from "./types.js";
import { digest, git, MAX_GIT_OUTPUT_BYTES, normalizeRelative, stableJson } from "./util.js";

interface StorePaths {
  root: string;
  objects: string;
  runs: string;
  events: string;
  checkpoints: string;
  onboarding: string;
  keys: string;
  lock: string;
}

function paths(repositoryRoot: string): StorePaths {
  const gitDirOutput = git(repositoryRoot, ["rev-parse", "--git-dir"]).trim();
  const gitDir = path.resolve(repositoryRoot, gitDirOutput);
  const root = path.join(gitDir, "respstack");
  return {
    root,
    objects: path.join(root, "objects", "sha256"),
    runs: path.join(root, "runs"),
    events: path.join(root, "events"),
    checkpoints: path.join(root, "checkpoints"),
    onboarding: path.join(root, "onboarding.json"),
    keys: path.join(root, "keys"),
    lock: path.join(root, "active.lock"),
  };
}

export class EvidenceStore {
  readonly repositoryRoot: string;
  readonly location: StorePaths;
  private initialized = false;
  private lockHeld = false;

  constructor(repositoryRoot: string) {
    this.repositoryRoot = repositoryRoot;
    this.location = paths(repositoryRoot);
  }

  initialize(): void {
    if (this.initialized) return;
    mkdirSync(this.location.objects, { recursive: true });
    mkdirSync(this.location.runs, { recursive: true });
    mkdirSync(this.location.events, { recursive: true });
    mkdirSync(this.location.checkpoints, { recursive: true });
    mkdirSync(this.location.keys, { recursive: true });
    this.ensureKeys();
    this.initialized = true;
    if (existsSync(path.join(this.location.root, "rollback-journal.json")) && !this.lockOwnerActive()) {
      try { this.withLock(() => this.recoverInterruptedRollback()); } catch (error) {
        this.initialized = false;
        throw error;
      }
    }
  }

  acquireLock(): () => void {
    this.initialize();
    if (existsSync(this.location.lock) && !this.lockOwnerActive()) rmSync(this.location.lock, { force: true });
    try {
      const descriptor = openSync(this.location.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(descriptor, `${process.pid}\n`);
      closeSync(descriptor);
      this.lockHeld = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`another ResponsibilityStack operation is active (${this.location.lock})`);
      }
      throw error;
    }
    const release = () => {
      rmSync(this.location.lock, { force: true });
      this.lockHeld = false;
    };
    try { this.recoverInterruptedRollback(); } catch (error) { release(); throw error; }
    return release;
  }

  withLock<T>(operation: () => T): T {
    if (this.lockHeld) return operation();
    const release = this.acquireLock();
    try { return operation(); } finally { release(); }
  }

  writeObject(content: Uint8Array): FileState {
    const hash = digest(content);
    const target = path.join(this.location.objects, hash.slice(0, 2), hash.slice(2));
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, content, { mode: 0o600 });
      try {
        renameSync(temporary, target);
      } catch (error) {
        rmSync(temporary, { force: true });
        if (!existsSync(target)) throw error;
      }
    }
    return { digest: hash, objectRef: `sha256:${hash}`, size: content.byteLength, mode: 0 };
  }

  gitObject(content: Uint8Array, objectId: string, mode: number): FileState {
    return {
      digest: digest(content),
      objectRef: `git:${objectId}`,
      size: content.byteLength,
      mode,
    };
  }

  stateFromGitObject(objectId: string, mode: number): FileState {
    return this.gitObject(this.readGitBlob(objectId), objectId, mode);
  }

  readObject(state: FileState): Buffer {
    if (state.objectRef.startsWith("sha256:")) {
      const hash = state.objectRef.slice("sha256:".length);
      const content = readFileSync(path.join(this.location.objects, hash.slice(0, 2), hash.slice(2)));
      if (digest(content) !== state.digest) throw new Error(`evidence object ${hash} failed digest verification`);
      return content;
    }

    if (state.objectRef.startsWith("git:")) {
      const objectId = state.objectRef.slice("git:".length);
      const content = this.readGitBlob(objectId);
      if (digest(content) !== state.digest) throw new Error(`Git object ${objectId} failed digest verification`);
      return content;
    }

    throw new Error(`unsupported object reference: ${state.objectRef}`);
  }

  private readGitBlob(objectId: string): Buffer {
    if (!/^[a-f0-9]{40,64}$/.test(objectId)) throw new Error("invalid Git object id");
    const size = Number(git(this.repositoryRoot, ["cat-file", "-s", objectId]).trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_GIT_OUTPUT_BYTES) {
      throw new Error(`Git object ${objectId} exceeds the 64 MiB capture limit`);
    }
    const result = spawnSync("git", ["cat-file", "blob", objectId], {
      cwd: this.repositoryRoot, encoding: null, maxBuffer: Math.max(1024, size + 1024),
    });
    if (result.error) throw new Error(`Git object read failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Git object ${objectId} is unavailable: ${result.stderr.toString().trim()}`);
    return result.stdout;
  }

  stateFromWorkingFile(relativePath: string, preferGitObject?: string): FileState | null {
    const safePath = normalizeRelative(this.repositoryRoot, relativePath);
    const absolute = path.join(this.repositoryRoot, safePath);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
    const content = readFileSync(absolute);
    const mode = statSync(absolute).mode & 0o777;
    if (preferGitObject) return this.gitObject(content, preferGitObject, mode);
    return { ...this.writeObject(content), mode };
  }

  appendEvent(body: EditEventBody): EditEvent {
    const hash = digest(stableJson(body));
    const event: EditEvent = { ...body, hash };
    writeFileSync(this.eventPath(body.runId), `${JSON.stringify(event)}\n`, { flag: "a", mode: 0o600 });
    return event;
  }

  readEvents(runId: string): EditEvent[] {
    const target = this.eventPath(runId);
    if (!existsSync(target)) return [];
    return readFileSync(target, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EditEvent);
  }

  listEvents(): EditEvent[] {
    return this.listRuns().flatMap((run) => this.readEvents(run.id));
  }

  findEvent(id: string): EditEvent {
    const event = this.listEvents().find((candidate) => candidate.id === id);
    if (!event) throw new Error(`edit event ${id} was not found`);
    return event;
  }

  writeRun(run: RunRecord, shouldSign = false): RunRecord {
    const unsigned = { ...run };
    delete unsigned.signature;
    const record = shouldSign ? { ...unsigned, signature: this.signPayload(unsigned) } : unsigned;
    this.atomicJson(path.join(this.location.runs, `${run.id}.json`), record);
    return record;
  }

  discardAbortedRollback(runId: string): void {
    if (!/^run_\d+_[a-f0-9]+$/.test(runId)) throw new Error("invalid rollback run id");
    const file = path.join(this.location.runs, `${runId}.json`);
    if (existsSync(file)) {
      const run = this.readRun(runId);
      if (run.kind !== "rollback" || run.status === "completed") throw new Error("refusing to discard a completed or non-rollback run");
    }
    rmSync(this.eventPath(runId), { force: true });
    rmSync(file, { force: true });
  }

  readRun(id: string): RunRecord {
    const target = path.join(this.location.runs, `${id}.json`);
    if (!existsSync(target)) throw new Error(`run ${id} was not found`);
    return JSON.parse(readFileSync(target, "utf8")) as RunRecord;
  }

  listRuns(): RunRecord[] {
    this.initialize();
    return readdirSync(this.location.runs)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(path.join(this.location.runs, name), "utf8")) as RunRecord)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  verifyRun(runId: string): string[] {
    const run = this.readRun(runId);
    const events = this.readEvents(runId);
    return this.verifyRunRecord(run, events);
  }

  verifyRunRecord(run: RunRecord, events: EditEvent[]): string[] {
    const failures: string[] = [];
    let previous: string | null = null;
    let sequence = 0;

    for (const event of events) {
      if (event.runId !== run.id || event.sequence !== ++sequence) failures.push(`${event.id}: invalid run or sequence`);
      const { hash, ...body } = event;
      if (digest(stableJson(body)) !== hash) failures.push(`${event.id}: event hash mismatch`);
      if (event.previousEventHash !== previous) failures.push(`${event.id}: broken event chain`);
      for (const state of [event.before, event.after]) {
        if (!state) continue;
        try {
          this.readObject(state);
        } catch (error) {
          failures.push(`${event.id}: ${(error as Error).message}`);
        }
      }
      previous = hash;
    }

    if (run.eventCount !== events.length) failures.push(`${run.id}: event count mismatch`);
    if (run.eventHead !== previous) failures.push(`${run.id}: event head mismatch`);
    if (!run.signature) failures.push(`${run.id}: run is not signed`);
    else {
      const unsigned = { ...run };
      delete unsigned.signature;
      if (!this.verifyPayload(unsigned, run.signature)) failures.push(`${run.id}: invalid signature`);
    }
    return failures;
  }

  writeCheckpoint(body: FeatureCheckpointBody): FeatureCheckpoint {
    const checkpoint: FeatureCheckpoint = { ...body, signature: this.signPayload(body) };
    this.atomicJson(path.join(this.location.checkpoints, `${body.id}.json`), checkpoint);
    return checkpoint;
  }

  readCheckpoint(id: string): FeatureCheckpoint {
    const target = path.join(this.location.checkpoints, `${id}.json`);
    if (!existsSync(target)) throw new Error(`feature checkpoint ${id} was not found`);
    return JSON.parse(readFileSync(target, "utf8")) as FeatureCheckpoint;
  }

  listCheckpoints(): FeatureCheckpoint[] {
    this.initialize();
    return readdirSync(this.location.checkpoints)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(path.join(this.location.checkpoints, name), "utf8")) as FeatureCheckpoint)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  verifyCheckpoint(id: string): string[] {
    const failures: string[] = [];
    const checkpoint = this.readCheckpoint(id);
    const { signature, ...body } = checkpoint;
    if (!signature) failures.push(`${id}: checkpoint is not signed`);
    else if (!this.verifyPayload(body, signature)) failures.push(`${id}: invalid signature`);
    if (checkpoint.previousCheckpointId) {
      try {
        this.readCheckpoint(checkpoint.previousCheckpointId);
      } catch {
        failures.push(`${id}: previous checkpoint is unavailable`);
      }
    }
    for (const [pathname, state] of Object.entries(checkpoint.states)) {
      try {
        this.readObject(state);
      } catch (error) {
        failures.push(`${id}:${pathname}: ${(error as Error).message}`);
      }
    }
    return failures;
  }

  writeOnboarding(body: RepositoryOnboardingBody): RepositoryOnboarding {
    if (existsSync(this.location.onboarding)) throw new Error("repository is already onboarded");
    const onboarding: RepositoryOnboarding = { ...body, signature: this.signPayload(body) };
    this.atomicJson(this.location.onboarding, onboarding);
    return onboarding;
  }

  writeCaptureReceipt(body: CaptureReceiptBody): void {
    this.atomicJson(path.join(this.location.root, "capture-health.json"), { ...body, signature: this.signPayload(body) });
  }

  readCaptureReceipt(): CaptureReceipt | null {
    const file = path.join(this.location.root, "capture-health.json");
    if (!existsSync(file)) return null;
    const receipt = JSON.parse(readFileSync(file, "utf8")) as CaptureReceipt;
    const { signature, ...body } = receipt;
    if (!signature || !this.verifyPayload(body, signature) || body.repositoryRoot !== this.repositoryRoot) {
      throw new Error("invalid capture health signature or repository");
    }
    return receipt;
  }

  readOnboarding(): RepositoryOnboarding | null {
    if (!existsSync(this.location.onboarding)) return null;
    return JSON.parse(readFileSync(this.location.onboarding, "utf8")) as RepositoryOnboarding;
  }

  verifyOnboarding(): string[] {
    const onboarding = this.readOnboarding();
    if (!onboarding) return [];
    const { signature, ...body } = onboarding;
    if (!signature) return [`${onboarding.id}: onboarding record is not signed`];
    return this.verifyPayload(body, signature) ? [] : [`${onboarding.id}: invalid signature`];
  }

  signPayload(value: unknown): Signature {
    const privateKey = readFileSync(path.join(this.location.keys, "private.pem"), "utf8");
    const publicKey = readFileSync(path.join(this.location.keys, "public.pem"), "utf8");
    return {
      algorithm: "ed25519",
      keyFingerprint: digest(publicKey).slice(0, 16),
      publicKey,
      value: sign(null, Buffer.from(stableJson(value)), privateKey).toString("base64"),
    };
  }

  verifyPayload(value: unknown, signature: Signature): boolean {
    const trustedPublicKey = readFileSync(path.join(this.location.keys, "public.pem"), "utf8");
    if (signature.publicKey !== trustedPublicKey) return false;
    try { return verify(
      null,
      Buffer.from(stableJson(value)),
      signature.publicKey,
      Buffer.from(signature.value, "base64"),
    ); } catch { return false; }
  }

  private eventPath(runId: string): string {
    return path.join(this.location.events, `${runId}.jsonl`);
  }

  private ensureKeys(): void {
    const privatePath = path.join(this.location.keys, "private.pem");
    const publicPath = path.join(this.location.keys, "public.pem");
    const hasPrivate = existsSync(privatePath);
    const hasPublic = existsSync(publicPath);

    if (hasPrivate && !hasPublic) {
      const publicKey = createPublicKey(createPrivateKey(readFileSync(privatePath, "utf8")));
      writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
    } else if (!hasPrivate && hasPublic) {
      throw new Error("signing private key is missing; refusing to replace the repository identity");
    } else if (!hasPrivate) {
      const hasEvidence = existsSync(this.location.onboarding) ||
        [this.location.runs, this.location.events, this.location.checkpoints].some(
          (directory) => readdirSync(directory).length > 0,
        );
      if (hasEvidence) throw new Error("signing keys are missing; refusing to replace the repository identity");
      const pair = generateKeyPairSync("ed25519");
      writeFileSync(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      writeFileSync(publicPath, pair.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
    }

    chmodSync(privatePath, 0o600);
    chmodSync(publicPath, 0o644);
    const probe = Buffer.from("responsibility-stack-key-check");
    if (!verify(null, probe, readFileSync(publicPath, "utf8"), sign(null, probe, readFileSync(privatePath, "utf8")))) {
      throw new Error("signing key pair does not match; refusing to write evidence");
    }
  }

  private atomicJson(target: string, value: unknown): void {
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  }

  recoverInterruptedRollback(): void {
    const journal = path.join(this.location.root, "rollback-journal.json");
    if (!existsSync(journal)) return;
    if (!this.lockHeld && this.lockOwnerActive()) return;
    const data = JSON.parse(readFileSync(journal, "utf8")) as
      Array<{ path: string; state: FileState | null }> |
      { version: 2; runId: string; entries: Array<{ path: string; state: FileState | null; target: FileState | null }> };
    const runId = Array.isArray(data) ? undefined : data.runId;
    if (runId && !/^run_\d+_[a-f0-9]+$/.test(runId)) throw new Error("invalid rollback journal run id");
    const entries = Array.isArray(data) ? data : data.entries;
    if (runId && existsSync(path.join(this.location.runs, `${runId}.json`))) {
      const run = this.readRun(runId);
      if (run.kind !== "rollback") throw new Error("journal does not reference a rollback run");
      if (run.status === "completed") {
        if (this.verifyRun(runId).length > 0) throw new Error("committed rollback evidence is invalid; refusing automatic recovery");
        // The signed completion is the commit point; never undo a committed transaction.
        rmSync(journal, { force: true });
        return;
      }
    }
    // Validate every path and backup before restoring any file.
    const prepared = entries.map((entry) => {
      const relative = normalizeRelative(this.repositoryRoot, entry.path);
      const absolute = path.join(this.repositoryRoot, relative);
      if (relative === "." || (existsSync(absolute) && !lstatSync(absolute).isFile())) throw new Error("recovery requires regular source files");
      if ("target" in entry) {
        const current = this.stateFromWorkingFile(relative);
        const same = (state: FileState | null) => current?.digest === state?.digest && current?.mode === state?.mode;
        if (!same(entry.state) && !same(entry.target as FileState | null)) {
          throw new Error(`recovery conflicts with later edits: ${entry.path}; journal retained`);
        }
      }
      return { ...entry, content: entry.state ? this.readObject(entry.state) : null };
    });
    for (const entry of prepared) {
      const relative = normalizeRelative(this.repositoryRoot, entry.path);
      const absolute = path.join(this.repositoryRoot, relative);
      if (!entry.state) {
        rmSync(absolute, { force: true });
        continue;
      }
      mkdirSync(path.dirname(absolute), { recursive: true });
      const temporary = `${absolute}.respstack-recover-${process.pid}-${Math.random().toString(16).slice(2)}`;
      writeFileSync(temporary, entry.content!, { mode: entry.state.mode, flag: "wx" });
      normalizeRelative(this.repositoryRoot, entry.path);
      renameSync(temporary, absolute);
      chmodSync(absolute, entry.state.mode);
    }
    if (runId) this.discardAbortedRollback(runId);
    rmSync(journal, { force: true });
  }

  private lockOwnerActive(): boolean {
    if (!existsSync(this.location.lock)) return false;
    const pid = Number.parseInt(readFileSync(this.location.lock, "utf8").trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}
