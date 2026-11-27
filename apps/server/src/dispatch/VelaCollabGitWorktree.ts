// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import * as Schema from "effect/Schema";

import { requireStableGitlinks } from "./VelaCollabGitEvidence.ts";
import {
  assertNoCollisions,
  checkAttributes,
  CollabGitError,
  decodeUtf8,
  git,
  gitError,
  hasCode,
  hashRegularFiles,
  hashSymlink,
  inspectPath,
  isInternal,
  sameEntry,
  statPath,
  workspaceEnvironment,
  type GitBinding,
} from "./VelaCollabGitObjects.ts";
import type { CollabDeliveryWrite, CollabGateSummary, CollabTreeEntry } from "./VelaCollabTypes.ts";

export class CollabWorktreeChanged extends Schema.TaggedError<
  CollabWorktreeChanged,
  { readonly brand: unique symbol }
>()("CollabWorktreeChanged", {
  paths: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export const isCollabWorktreeChanged = Schema.is(CollabWorktreeChanged);
const isCollabGitError = Schema.is(CollabGitError);

export const worktreeChanged = (paths: ReadonlyArray<string>) =>
  new CollabWorktreeChanged({
    paths,
    message: `Workspace contains unexpected content at ${paths.join(", ")}.`,
  });

async function workspaceEntry(repo: string, path: string) {
  const info = await inspectPath(repo, path);
  if (!info || info.isDirectory()) return null;
  if (info.isSymbolicLink())
    return { mode: "120000", oid: await hashSymlink(repo, path, false) } as const;
  if (!info.isFile()) throw worktreeChanged([path]);
  const [oid] = await hashRegularFiles(repo, [path], false);
  if (!oid) throw worktreeChanged([path]);
  return { mode: (info.mode & 0o100) !== 0 ? "100755" : "100644", oid } satisfies CollabTreeEntry;
}

async function removableDirectories(
  repo: string,
  path: string,
  deletions: ReadonlySet<string>,
  recovery: boolean,
): Promise<string[]> {
  const directory = join(repo, path);
  if (!(await statPath(directory))?.isDirectory()) return [];
  if (!recovery && ![...deletions].some((removed) => removed.startsWith(path + "/"))) {
    throw worktreeChanged([path]);
  }
  const result: string[] = [];
  for (const name of await readdir(directory)) {
    const child = path + "/" + name;
    const info = await inspectPath(repo, child);
    if (info?.isDirectory()) {
      if (![...deletions].some((removed) => removed.startsWith(child + "/"))) {
        throw worktreeChanged([child]);
      }
      result.push(...(await removableDirectories(repo, child, deletions, recovery)));
    } else if (!deletions.has(child)) {
      throw worktreeChanged([child]);
    }
  }
  return [...result, path];
}

export async function preflightWrites(
  binding: GitBinding,
  writes: ReadonlyArray<CollabDeliveryWrite>,
  recovery: boolean,
) {
  const repo = binding.canonicalTargetWorktree;
  if ((await realpath(repo)) !== repo) throw gitError("Delivery worktree path was replaced.");
  assertNoCollisions(writes.map(({ path }) => path));
  requireStableGitlinks(writes);
  await checkAttributes(
    repo,
    writes.map(({ path }) => path),
  );
  const removed = new Set(writes.filter(({ targetNew }) => !targetNew).map(({ path }) => path));
  const conflicts = new Set<string>();
  const attributes = new Map<string, Awaited<ReturnType<typeof inspectPath>>>();
  for (const write of writes) {
    const { path, expectedOld, targetNew } = write;
    if (isInternal(path)) throw gitError(`Reserved workspace path ${path}.`);
    // A symlink must never become an ancestor of a subsequent recovery write.
    if (
      targetNew?.mode === "120000" &&
      [...removed].some((child) => child.startsWith(path + "/"))
    ) {
      conflicts.add(path);
      continue;
    }
    try {
      const info = await inspectPath(repo, path);
      attributes.set(path, info);
      const current = await workspaceEntry(repo, path);
      if (!sameEntry(current, expectedOld) && !(recovery && sameEntry(current, targetNew)))
        conflicts.add(path);
      if (targetNew && info?.isDirectory())
        await removableDirectories(repo, path, removed, recovery);
    } catch (error) {
      if (isCollabWorktreeChanged(error)) {
        for (const path of error.paths) conflicts.add(path);
      } else if (
        isCollabGitError(error) &&
        /^(?:Symbolic link in parent|Nested Git repository)/.test(error.message)
      ) {
        conflicts.add(path);
      } else {
        throw error;
      }
    }
  }
  if (conflicts.size) throw worktreeChanged([...conflicts].sort());

  const metadata = await statPath(binding.gitCommonDir);
  if (!metadata) throw gitError("The Git common directory disappeared.");
  for (const { path, targetNew } of writes) {
    if (!targetNew || (recovery && sameEntry(await workspaceEntry(repo, path), targetNew)))
      continue;
    let parent = dirname(join(repo, path));
    let info = await statPath(parent);
    while (!info?.isDirectory() && parent !== repo) {
      parent = dirname(parent);
      info = await statPath(parent);
    }
    if (
      info?.dev !== metadata.dev ||
      (attributes.get(path)?.isDirectory() && attributes.get(path)?.dev !== metadata.dev)
    ) {
      throw gitError(`Cannot atomically materialize ${path} across filesystems.`);
    }
  }
  return removed;
}

async function stageBlob(repo: string, destination: string, entry: CollabTreeEntry) {
  if (entry.mode === "120000") {
    const { stdout } = await git(repo, ["cat-file", "blob", entry.oid]);
    const target = decodeUtf8(stdout);
    if (!target || target.includes("\0"))
      throw gitError("Invalid symbolic link target in snapshot.");
    await symlink(target, destination);
    return;
  }
  const file = await open(destination, "wx", entry.mode === "100755" ? 0o755 : 0o644);
  try {
    await git(repo, ["cat-file", "blob", entry.oid], { consume: (chunk) => file.writeFile(chunk) });
    await file.chmod(entry.mode === "100755" ? 0o755 : 0o644);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function ensureParent(repo: string, path: string) {
  let directory = repo;
  for (const part of path.split("/").slice(0, -1)) {
    directory = join(directory, part);
    const info = await statPath(directory);
    if (info && !info.isDirectory()) throw worktreeChanged([path]);
    if (!info) await mkdir(directory);
    if ((await realpath(directory)) !== directory || (await statPath(join(directory, ".git")))) {
      throw worktreeChanged([path]);
    }
  }
  return directory;
}

async function verifyParent(repo: string, path: string, parent: string) {
  await inspectPath(repo, path);
  if ((await realpath(parent)) !== parent) throw worktreeChanged([path]);
}

export async function applyWrites(
  binding: GitBinding,
  writes: ReadonlyArray<CollabDeliveryWrite>,
  recovery: boolean,
) {
  const repo = binding.canonicalTargetWorktree;
  const removed = await preflightWrites(binding, writes, recovery);
  if (!writes.length) return;
  const staging = await mkdtemp(join(binding.gitCommonDir, "vela-collab-write-"));
  try {
    const stages = new Map<string, string>();
    for (const { path, targetNew } of writes) {
      if (!targetNew) continue;
      if (recovery && sameEntry(await workspaceEntry(repo, path), targetNew)) continue;
      const stage = join(staging, String(stages.size));
      await stageBlob(repo, stage, targetNew);
      stages.set(path, stage);
    }
    // Check every path before any mutation, including on interrupted retries.
    await preflightWrites(binding, writes, recovery);
    for (const { path, expectedOld, targetNew } of writes) {
      if (targetNew) continue;
      const current = await workspaceEntry(repo, path);
      if (!current && recovery) continue;
      if (!sameEntry(current, expectedOld)) throw worktreeChanged([path]);
      await verifyParent(repo, path, dirname(join(repo, path)));
      await unlink(join(repo, path));
    }
    for (const { path, expectedOld, targetNew } of writes) {
      if (!targetNew) continue;
      const current = await workspaceEntry(repo, path);
      if (recovery && sameEntry(current, targetNew)) continue;
      if (!sameEntry(current, expectedOld)) throw worktreeChanged([path]);
      const stage = stages.get(path);
      if (!stage) throw worktreeChanged([path]);
      const directories = await removableDirectories(repo, path, removed, recovery);
      for (const directory of directories) {
        await verifyParent(repo, directory, dirname(join(repo, directory)));
        await rmdir(join(repo, directory));
      }
      const parent = await ensureParent(repo, path);
      if (!sameEntry(await workspaceEntry(repo, path), expectedOld)) throw worktreeChanged([path]);
      await verifyParent(repo, path, parent);
      await rename(stage, join(repo, path));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function materializeTree(
  binding: GitBinding,
  entries: ReadonlyMap<string, CollabTreeEntry>,
) {
  const repo = binding.canonicalTargetWorktree;
  for (const [path, entry] of entries) {
    if (entry.mode === "160000") continue;
    const parent = await ensureParent(repo, path);
    await verifyParent(repo, path, parent);
    await stageBlob(repo, join(repo, path), entry);
  }
}

type GateResult = CollabGateSummary["results"][number];
const MAX_GATE_OUTPUT_BYTES = 12_000;

function runGate(
  directory: string,
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  return new Promise<GateResult>((resolve) => {
    const isWindows = process.platform === "win32";
    const child = spawn(command, {
      cwd: directory,
      env,
      shell: true,
      detached: !isWindows,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let stopped: number | null = null;
    const append = (chunk: Buffer) => {
      if (bytes < MAX_GATE_OUTPUT_BYTES)
        chunks.push(chunk.subarray(0, MAX_GATE_OUTPUT_BYTES - bytes));
      bytes += chunk.length;
      truncated ||= bytes > MAX_GATE_OUTPUT_BYTES;
    };
    const stop = (code: number) => {
      if (stopped !== null) return;
      stopped = code;
      if (child.pid === undefined) return;
      if (isWindows) {
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!hasCode(error, "ESRCH")) child.kill("SIGKILL");
      }
    };
    const abort = () => stop(130);
    const timer = setTimeout(() => stop(124), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => append(Buffer.from(error.message)));
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const output = Buffer.concat(chunks).toString("utf8");
      resolve({
        command,
        exitCode: stopped ?? code,
        output: truncated ? output + "\n[output truncated]" : output,
      });
    });
  });
}

export async function runSnapshotGates(
  directory: string,
  commands: ReadonlyArray<string>,
  config: NodeJS.ProcessEnv,
  options: { readonly signal?: AbortSignal; readonly gateTimeoutMs?: number },
): Promise<CollabGateSummary> {
  const timeout = options.gateTimeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2 ** 31 - 1) {
    throw gitError("Invalid hard gate timeout.");
  }
  const env = { ...workspaceEnvironment(), ...config };
  const results: GateResult[] = [];
  for (const command of new Set(commands.map((value) => value.trim()).filter(Boolean))) {
    if (options.signal?.aborted) return { passed: false, results };
    const result = await runGate(directory, command, env, timeout, options.signal);
    results.push(result);
    if (result.exitCode !== 0) return { passed: false, results };
  }
  return { passed: !options.signal?.aborted, results };
}
