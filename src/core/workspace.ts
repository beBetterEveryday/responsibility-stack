import type { EvidenceStore } from "./store.js";
import type { FileState } from "./types.js";
import { git, normalizeRelative } from "./util.js";

export interface TrackedEntry {
  objectId: string;
  mode: number;
}

export function repositoryFiles(repositoryRoot: string): string[] {
  return git(repositoryRoot, ["ls-files", "-co", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
}

export function trackedEntries(repositoryRoot: string): Map<string, TrackedEntry> {
  const tracked = new Map<string, TrackedEntry>();
  for (const entry of git(repositoryRoot, ["ls-files", "-s", "-z"]).split("\0").filter(Boolean)) {
    const match = /^(\d+) ([0-9a-f]+) \d+\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    tracked.set(match[3]!, { objectId: match[2]!, mode: Number.parseInt(match[1]!, 8) & 0o777 });
  }
  return tracked;
}

export function dirtyPaths(repositoryRoot: string): Set<string> {
  const paths = new Set<string>();
  const entries = git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    .split("\0")
    .filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const code = entry.slice(0, 2);
    paths.add(entry.slice(3));
    if (code.includes("R") || code.includes("C")) {
      const original = entries[++index];
      if (original) paths.add(original);
    }
  }
  return paths;
}

export function committedPaths(repositoryRoot: string, baseCommit: string | null): Set<string> {
  const paths = new Set<string>();
  if (!baseCommit) return paths;
  const head = git(repositoryRoot, ["rev-parse", "HEAD"], true).trim();
  if (!head || head === baseCommit) return paths;
  const entries = git(repositoryRoot, ["diff", "--name-status", "-z", "--find-renames", baseCommit, head, "--"])
    .split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const status = entries[index++]!;
    const first = entries[index];
    if (!first) break;
    paths.add(first);
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = entries[++index];
      if (second) paths.add(second);
    }
  }
  return paths;
}

export function fileState(
  store: EvidenceStore,
  pathname: string,
  tracked: Map<string, TrackedEntry>,
  dirty: Set<string>,
): FileState | null {
  normalizeRelative(store.repositoryRoot, pathname);
  const entry = tracked.get(pathname);
  if (entry && !dirty.has(pathname)) return store.stateFromGitObject(entry.objectId, entry.mode);
  return store.stateFromWorkingFile(pathname);
}
