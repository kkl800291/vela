// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import * as Schema from "effect/Schema";

import type { CollabRepositoryBinding, CollabTreeEntry } from "./VelaCollabTypes.ts";

export class CollabGitError extends Schema.TaggedError<
  CollabGitError,
  { readonly brand: unique symbol }
>()("CollabGitError", {
  message: Schema.String,
}) {}

export const gitError = (message: string) => new CollabGitError({ message });

const gitSettings = [
  "--no-replace-objects",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];

interface GitOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Buffer;
  readonly allow?: ReadonlyArray<number>;
  readonly consume?: (chunk: Buffer) => void | Promise<void>;
}

export function workspaceEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH|NAMESPACE|PREFIX|SUPER_PREFIX|SHALLOW_FILE|GRAFT_FILE|ATTR_SOURCE|CONFIG(_.*)?|TRACE.*|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS)$/.test(
        key,
      )
    ) {
      delete env[key];
    }
  }
  return env;
}

export async function git(cwd: string, args: ReadonlyArray<string>, options: GitOptions = {}) {
  const child = spawn("git", [...gitSettings, ...args], {
    cwd,
    env: {
      ...workspaceEnvironment(),
      LC_ALL: "C",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  let bytes = 0;
  let stderrBytes = 0;
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
    child.stdin.on("error", (error) => {
      if (!hasCode(error, "EPIPE")) reject(error);
    });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes < 8192) errors.push(chunk.subarray(0, 8192 - stderrBytes));
    stderrBytes += chunk.length;
  });
  void closed.catch(() => undefined);
  child.stdin.end(options.input);
  try {
    for await (const part of child.stdout) {
      const chunk: Buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
      if (options.consume) {
        await options.consume(chunk);
      } else {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) throw gitError("Git metadata exceeded the output limit.");
        output.push(chunk);
      }
    }
    const exitCode = await closed;
    const stderr = Buffer.concat(errors).toString("utf8").trim();
    if (exitCode !== 0 && (exitCode === null || !options.allow?.includes(exitCode))) {
      throw gitError(
        `git ${args[0]} failed (${exitCode ?? "signal"}): ${stderr || Buffer.concat(output).toString("utf8").slice(0, 8192)}`,
      );
    }
    return { stdout: Buffer.concat(output), stderr, exitCode };
  } catch (error) {
    child.kill();
    await closed.catch(() => undefined);
    throw error;
  }
}

export function hasCode(error: unknown, ...codes: ReadonlyArray<string>): boolean {
  return error instanceof Error && "code" in error && codes.some((code) => error.code === code);
}

export async function statPath(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT", "ENOTDIR")) return null;
    throw error;
  }
}

export const isInternal = (path: string) => /^(?:\.vela|\.harness)(?:\/|$)/i.test(path);

export function assertPath(path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\0") ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git" ||
          /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/u.test(part) ||
          (process.platform === "win32" &&
            (/[:*?"<>|\u0001-\u001f]|[. ]$/.test(part) ||
              /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))),
      )
  )
    throw gitError(`Cannot represent workspace path ${JSON.stringify(path)} safely.`);
}

export function assertNoCollisions(paths: Iterable<string>) {
  const folded = new Map<string, string>();
  for (const path of paths) {
    assertPath(path);
    for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
      const prefix = path.slice(0, end);
      const key = prefix.normalize("NFC").toLowerCase();
      const previous = folded.get(key);
      if (previous === prefix) break;
      if (previous !== undefined) {
        throw gitError(`Case or normalization collision: ${previous} and ${prefix}.`);
      }
      folded.set(key, prefix);
    }
  }
}

export function decodeUtf8(input: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    throw gitError(
      "Git returned a filename or symlink target that cannot be represented as UTF-8.",
    );
  }
}

export const nulFields = (stdout: Buffer) => decodeUtf8(stdout).split("\0").slice(0, -1);

export function assertOid(oid: string) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) || /^0+$/.test(oid))
    throw gitError("Expected a full Git object ID.");
  return oid;
}

export function assertGitVersion(version: string) {
  const match = /^git version (\d+)\.(\d+)\b/.exec(version);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 38)) {
    throw gitError(`Vela Collaboration requires Git 2.38 or newer, found ${version.trim()}.`);
  }
}

export async function withTemp<T>(use: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "vela-collab-"));
  try {
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function line(stdout: Buffer) {
  return decodeUtf8(stdout).replace(/\r?\n$/, "");
}

async function configBool(cwd: string, key: string) {
  return (
    line((await git(cwd, ["config", "--type=bool", "--get", key], { allow: [1] })).stdout) ===
    "true"
  );
}

export type GitBinding = CollabRepositoryBinding & { readonly gitCommonDir: string };

export type RepositoryProbe =
  | {
      readonly kind: "non_git";
      readonly canonicalTargetWorktree: string;
      readonly gitCommonDir: null;
    }
  | (GitBinding & { readonly kind: "git"; readonly headOid: string | null });

export async function probeRepository(path: string): Promise<RepositoryProbe> {
  const directory = await realpath(path);
  const inside = await git(directory, ["rev-parse", "--is-inside-work-tree"], { allow: [128] });
  if (inside.exitCode === 128 && inside.stderr.startsWith("fatal: not a git repository")) {
    return { kind: "non_git", canonicalTargetWorktree: directory, gitCommonDir: null };
  }
  if (inside.exitCode !== 0 || line(inside.stdout) !== "true") {
    throw gitError(inside.stderr || "Collaboration requires a Git working tree.");
  }
  const canonicalTargetWorktree = await realpath(
    line((await git(directory, ["rev-parse", "--show-toplevel"])).stdout),
  );
  const root = canonicalTargetWorktree;
  const [version, commonDir, head, sparse] = await Promise.all([
    git(root, ["--version"]),
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { allow: [1] }),
    configBool(root, "core.sparseCheckout"),
  ]);
  assertGitVersion(line(version.stdout));
  if (sparse) throw gitError("Sparse checkout is unsupported in Vela Collaboration.");
  if (head.exitCode === 1) {
    const ref = line((await git(root, ["symbolic-ref", "HEAD"])).stdout);
    const missing = await git(root, ["show-ref", "--verify", "--quiet", ref], { allow: [1] });
    if (missing.exitCode === 0) throw gitError("Git HEAD could not be resolved.");
  }
  return {
    kind: "git",
    canonicalTargetWorktree,
    gitCommonDir: await realpath(line(commonDir.stdout)),
    headOid: head.exitCode === 0 ? assertOid(line(head.stdout)) : null,
  };
}

export async function requireRepository(path: string) {
  const binding = await probeRepository(path);
  if (binding.kind !== "git")
    throw gitError(
      "A Git worktree is required for changes; research and decisions are available without Git.",
    );
  return binding;
}

export async function resolveTree(repo: string, oid: string) {
  return assertOid(
    line((await git(repo, ["rev-parse", "--verify", `${assertOid(oid)}^{tree}`])).stdout),
  );
}

export async function requireCommit(repo: string, oid: string) {
  const actual = line((await git(repo, ["cat-file", "-t", assertOid(oid)])).stdout);
  if (actual !== "commit") throw gitError(`Expected a snapshot commit, found ${actual}.`);
  return oid;
}

export async function commitTree(repo: string, tree: string, parent?: string) {
  const env = {
    GIT_AUTHOR_NAME: "Vela Collaboration",
    GIT_AUTHOR_EMAIL: "collaboration@vela.local",
    GIT_COMMITTER_NAME: "Vela Collaboration",
    GIT_COMMITTER_EMAIL: "collaboration@vela.local",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  return assertOid(
    line(
      (
        await git(
          repo,
          [
            "-c",
            "commit.gpgSign=false",
            "commit-tree",
            assertOid(tree),
            ...(parent === undefined ? [] : ["-p", assertOid(parent)]),
            "-m",
            "Vela Collaboration snapshot",
          ],
          { env },
        )
      ).stdout,
    ),
  );
}

export function parseEntry(mode: string | undefined, oid: string | undefined): CollabTreeEntry {
  if (mode !== "100644" && mode !== "100755" && mode !== "120000" && mode !== "160000") {
    throw gitError(`Unsupported Git entry mode ${mode}.`);
  }
  return { mode, oid: assertOid(oid ?? "") };
}

export async function snapshotEntry(repo: string, commit: string, path: string) {
  assertPath(path);
  if (isInternal(path)) return null;
  const { stdout } = await git(repo, [
    "--literal-pathspecs",
    "ls-tree",
    "-r",
    "-z",
    assertOid(commit),
    "--",
    path,
  ]);
  for (const field of nulFields(stdout)) {
    const separator = field.indexOf("\t");
    if (field.slice(separator + 1) !== path) continue;
    const [mode, , oid] = field.slice(0, separator).split(" ");
    return parseEntry(mode, oid);
  }
  return null;
}

export async function treeEntries(repo: string, oid: string, rejectInternal = false) {
  const result = new Map<string, CollabTreeEntry>();
  const { stdout } = await git(repo, ["ls-tree", "-r", "-z", assertOid(oid)]);
  for (const field of nulFields(stdout)) {
    const separator = field.indexOf("\t");
    const path = field.slice(separator + 1);
    if (isInternal(path)) {
      if (rejectInternal) throw gitError(`Collaboration snapshot contains reserved path ${path}.`);
      continue;
    }
    const [mode, , object] = field.slice(0, separator).split(" ");
    result.set(path, parseEntry(mode, object));
  }
  assertNoCollisions(result.keys());
  return result;
}

export async function checkAttributes(
  repo: string,
  paths: Iterable<string>,
  env?: NodeJS.ProcessEnv,
) {
  const input = [...paths].map((path) => path + "\0").join("");
  if (!input) return;
  const { stdout } = await git(
    repo,
    ["check-attr", ...(env ? ["--cached"] : []), "--all", "-z", "--stdin"],
    { input, ...(env ? { env } : {}) },
  );
  const fields = nulFields(stdout);
  for (let index = 0; index < fields.length; index += 3) {
    const [path, attribute, value] = fields.slice(index, index + 3);
    if (
      attribute === "filter" ||
      (attribute === "merge" && value !== "set" && value !== "unset") ||
      ((attribute === "working-tree-encoding" || attribute === "ident") && value !== "unset")
    ) {
      throw gitError(`Unsupported Git attribute ${attribute}=${value} on ${path}.`);
    }
  }
}

export async function withTreeIndex<T>(
  repo: string,
  tree: string,
  use: (env: NodeJS.ProcessEnv, directory: string) => Promise<T>,
) {
  return withTemp(async (directory) => {
    const env = { GIT_INDEX_FILE: join(directory, "index") };
    await git(repo, ["read-tree", assertOid(tree)], { env });
    return use(env, directory);
  });
}

export async function withIsolatedSnapshotRepository<T>(
  repo: string,
  tree: string,
  use: (directory: string, objects: string, config: NodeJS.ProcessEnv) => Promise<T>,
) {
  const [format, source] = await Promise.all([
    git(repo, ["rev-parse", "--show-object-format"]),
    git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]),
  ]);
  const objects = line(source.stdout);
  const config = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.attributesFile",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
  return withTemp(async (root) => {
    const directory = await realpath(root);
    await git(
      directory,
      ["init", "--quiet", "--template=", `--object-format=${line(format.stdout)}`],
      { env: config },
    );
    // Git's alternates file accepts a literal absolute directory on each line.
    if (objects.includes("\n"))
      throw gitError("Cannot isolate a Git objects directory containing a newline.");
    await writeFile(join(directory, ".git/objects/info/alternates"), objects + "\n");
    await git(directory, ["read-tree", assertOid(tree)], { env: config });
    return use(directory, objects, config);
  });
}

export async function checkTreeAttributes(repo: string, tree: string, paths: Iterable<string>) {
  await withTreeIndex(repo, tree, (env) => checkAttributes(repo, paths, env));
}

function quotePathForGit(path: string) {
  const bytes = Buffer.from(path);
  return (
    '"' +
    Array.from(bytes, (byte) =>
      byte >= 32 && byte <= 126 && byte !== 34 && byte !== 92
        ? String.fromCharCode(byte)
        : "\\" + byte.toString(8).padStart(3, "0"),
    ).join("") +
    '"'
  );
}

export async function hashRegularFiles(repo: string, paths: ReadonlyArray<string>, write: boolean) {
  if (paths.length === 0) return [];
  const { stdout } = await git(
    repo,
    ["hash-object", ...(write ? ["-w"] : []), "--no-filters", "--stdin-paths"],
    { input: paths.map(quotePathForGit).join("\n") + "\n" },
  );
  const ids = line(stdout).split("\n").map(assertOid);
  if (ids.length !== paths.length) throw gitError("Git did not hash every workspace file.");
  return ids;
}

export async function hashSymlink(repo: string, path: string, write: boolean) {
  const input = await readlink(join(repo, path), { encoding: "buffer" });
  decodeUtf8(input);
  return assertOid(
    line((await git(repo, ["hash-object", ...(write ? ["-w"] : []), "--stdin"], { input })).stdout),
  );
}

export async function inspectPath(repo: string, path: string, capture = false) {
  assertPath(path);
  const parts = path.split("/");
  let parent = repo;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const stats = await statPath(parent);
    if (stats?.isSymbolicLink()) {
      if (capture) return null;
      throw gitError(`Symbolic link in parent path of ${path}.`);
    }
    if (!stats?.isDirectory()) return null;
    if (await statPath(join(parent, ".git"))) throw gitError(`Nested Git repository at ${parent}.`);
  }
  return statPath(join(repo, path));
}

async function checkGitlink(repo: string, path: string, entry: CollabTreeEntry) {
  const directory = join(repo, path);
  const info = await inspectPath(repo, path);
  // Detached collaboration checkouts leave gitlinks uninitialized.
  if (!info) return entry;
  if (!info.isDirectory()) throw gitError(`Gitlink changed at ${path}.`);
  if (!(await statPath(join(directory, ".git")))) {
    if ((await readdir(directory)).length === 0) return entry;
    throw gitError(`Uninitialized submodule contains local files at ${path}.`);
  }
  const [head, status] = await Promise.all([
    git(directory, ["rev-parse", "--verify", "HEAD"]),
    git(directory, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]),
  ]);
  if (line(head.stdout) !== entry.oid || status.stdout.length !== 0) {
    throw gitError(`Dirty or changed submodule at ${path}.`);
  }
  return entry;
}

export async function captureTree(
  binding: Awaited<ReturnType<typeof requireRepository>>,
  includeUntracked = true,
  controlledPaths: Iterable<string> = [],
) {
  const { canonicalTargetWorktree: repo, headOid } = binding;
  const [head, index, files] = await Promise.all([
    headOid ? treeEntries(repo, headOid) : new Map<string, CollabTreeEntry>(),
    git(repo, ["ls-files", "--stage", "-t", "-z"]),
    includeUntracked ? git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]) : null,
  ]);
  const paths = new Set([...head.keys(), ...controlledPaths]);
  const indexPaths = new Set<string>();
  for (const field of nulFields(index.stdout)) {
    const separator = field.indexOf("\t");
    const path = field.slice(separator + 1);
    if (isInternal(path)) continue;
    const [flag, mode, oid, stage] = field.slice(0, separator).split(" ");
    if (flag === "S") throw gitError(`Skip-worktree entry at ${path}.`);
    if (stage !== "0") throw gitError(`Unmerged index entry at ${path}.`);
    const staged = parseEntry(mode, oid);
    const original = head.get(path);
    if ((original?.mode === "160000" || staged.mode === "160000") && !sameEntry(original, staged)) {
      throw gitError(`Staged gitlink changed at ${path}.`);
    }
    paths.add(path);
    indexPaths.add(path);
  }
  for (const [path, entry] of head) {
    if (entry.mode === "160000" && !indexPaths.has(path))
      throw gitError(`Staged gitlink removed at ${path}.`);
  }
  for (const file of files ? nulFields(files.stdout) : []) {
    if (isInternal(file)) continue;
    if (file.endsWith("/")) throw gitError(`Nested Git repository at ${file}.`);
    paths.add(file);
  }
  assertNoCollisions(paths);
  await checkAttributes(repo, paths);
  const regular: string[] = [];
  const entries = new Map<string, CollabTreeEntry>();
  const modes: Array<"100644" | "100755"> = [];
  const workspacePaths = [...paths];
  for (let index = 0; index < workspacePaths.length; index += 64) {
    await Promise.all(
      workspacePaths.slice(index, index + 64).map(async (path) => {
        const original = head.get(path);
        if (original?.mode === "160000") {
          entries.set(path, await checkGitlink(repo, path, original));
          return;
        }
        const info = await inspectPath(repo, path, true);
        if (!info) return;
        if (info.isFile()) {
          regular.push(path);
          modes.push((info.mode & 0o100) !== 0 ? "100755" : "100644");
        } else if (info.isSymbolicLink()) {
          entries.set(path, { mode: "120000", oid: await hashSymlink(repo, path, true) });
        } else if (!info.isDirectory() || (await statPath(join(repo, path, ".git")))) {
          throw gitError(`Unsupported workspace entry at ${path}.`);
        }
      }),
    );
  }
  const ids = await hashRegularFiles(repo, regular, true);
  for (const [index, path] of regular.entries()) {
    entries.set(path, parseEntry(modes[index], ids[index]));
  }
  return withTemp(async (directory) => {
    const env = { GIT_INDEX_FILE: join(directory, "index") };
    await git(repo, ["read-tree", "--empty"], { env });
    const input = [...entries]
      .map(([path, entry]) => `${entry.mode} ${entry.oid}\t${path}\0`)
      .join("");
    await git(repo, ["update-index", "-z", "--index-info"], { env, input });
    const oid = assertOid(line((await git(repo, ["write-tree"], { env })).stdout));
    return { treeOid: oid, entries };
  });
}

export function sameEntry(left?: CollabTreeEntry | null, right?: CollabTreeEntry | null): boolean {
  return (
    (left?.mode ?? null) === (right?.mode ?? null) && (left?.oid ?? null) === (right?.oid ?? null)
  );
}
