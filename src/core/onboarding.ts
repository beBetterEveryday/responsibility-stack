import { EvidenceStore } from "./store.js";
import { SCHEMA_VERSION, type OnboardingReport, type RepositoryOnboarding } from "./types.js";
import { digest, git, makeId, stableJson } from "./util.js";
import { dirtyPaths, trackedEntries } from "./workspace.js";

export function onboardRepository(store: EvidenceStore): OnboardingReport {
  store.initialize();
  let onboarding = store.readOnboarding();
  const created = onboarding === null;
  if (!onboarding) onboarding = createOnboarding(store);

  const runs = store.listRuns().filter((run) => run.status !== "running");
  const checkpoints = store.listCheckpoints();
  const failures = [
    ...store.verifyOnboarding(),
    ...runs.flatMap((run) => store.verifyRun(run.id)),
    ...checkpoints.flatMap((checkpoint) => store.verifyCheckpoint(checkpoint.id)),
  ];
  const capture: OnboardingReport["capture"] = { status: "not-observed", lastObservedAt: null, freshnessSeconds: 900 };
  try {
    const receipt = store.readCaptureReceipt();
    if (receipt) {
      capture.lastObservedAt = receipt.completedAt;
      const age = Date.now() - Date.parse(receipt.completedAt);
      capture.status = Number.isFinite(age) && age >= 0 && age <= capture.freshnessSeconds * 1000 ? "observed" : "stale";
    }
  } catch (error) {
    capture.status = "invalid";
    failures.push((error as Error).message);
  }
  return {
    ready: failures.length === 0 && capture.status === "observed",
    storageReady: failures.length === 0,
    capture,
    nextSteps: capture.status === "observed"
      ? ["A recent hook lifecycle was observed; this is not proof that the plugin remains enabled."]
      : ["Install/enable and trust the plugin hooks, complete a Codex turn with a read-only tool call, then run onboard again."],
    created,
    onboardingId: onboarding.id,
    trackingStartedAt: onboarding.createdAt,
    keyFingerprint: onboarding.signature.keyFingerprint,
    repositoryRoot: store.repositoryRoot,
    storeRoot: store.location.root,
    baseCommit: onboarding.baseCommit,
    trackedFileCount: onboarding.trackedFileCount,
    preExistingChangeCount: onboarding.preExistingChanges.length,
    preExistingChanges: onboarding.preExistingChanges.slice(0, 50),
    preExistingChangesTruncated: onboarding.preExistingChanges.length > 50,
    evidence: { runs: runs.length, edits: store.listEvents().length, checkpoints: checkpoints.length },
    failures,
  };
}

function createOnboarding(store: EvidenceStore): RepositoryOnboarding {
  const preExistingChanges = [...dirtyPaths(store.repositoryRoot)].sort();
  return store.writeOnboarding({
    schemaVersion: SCHEMA_VERSION,
    id: makeId("onboarding"),
    repositoryRoot: store.repositoryRoot,
    createdAt: new Date().toISOString(),
    baseCommit: git(store.repositoryRoot, ["rev-parse", "HEAD"], true).trim() || null,
    trackedFileCount: trackedEntries(store.repositoryRoot).size,
    preExistingChanges,
    preExistingPathDigest: digest(stableJson(preExistingChanges)),
  });
}
