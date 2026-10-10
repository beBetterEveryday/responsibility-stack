import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export function digest(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

export function makeId(prefix: string): string {
  const time = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `${prefix}_${time}_${randomBytes(4).toString("hex")}`;
}

export function discoverRepository(start = process.cwd()): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: start,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${start} is not inside a Git repository`);
  return realpathSync(result.stdout.trim());
}

export function git(root: string, args: string[], allowFailure = false): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES });
  if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.message} (output limit: 64 MiB)`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

export function normalizeRelative(root: string, target: string): string {
  const relative = path.relative(root, path.resolve(root, target));
  if (!relative || relative === ".") return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${target} is outside ${root}`);
  }
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    if (part.toLowerCase() === ".git") throw new Error("Git metadata is not a source path");
    cursor = path.join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${target} contains a symbolic link; refusing unsafe access`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return relative.split(path.sep).join("/");
}

export function isText(content: Uint8Array): boolean {
  const limit = Math.min(content.byteLength, 8_192);
  for (let index = 0; index < limit; index += 1) {
    if (content[index] === 0) return false;
  }
  return true;
}
