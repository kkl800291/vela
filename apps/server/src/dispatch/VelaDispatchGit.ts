// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type {
  DispatchBoundaryAudit,
  DispatchDiffSummary,
  DispatchHardGateItem,
  DispatchHardGateSummary,
} from "./VelaDispatchTypes.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const MAX_PATCH_CHARS = 32_000;
const MAX_GATE_OUTPUT_CHARS = 12_000;
const DEFAULT_GATE_TIMEOUT_MS = 180_000;

export interface WorkspaceSnapshot {
  readonly isGitRepo: boolean;
  readonly branchName: string;
  readonly baseCommit: string;
  readonly baselineTree: string | null;
}

async function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  envExtra?: Readonly<Record<string, string>>,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: envExtra ? { ...process.env, ...envExtra } : process.env,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string | Buffer; stderr?: string | Buffer; code?: number };
    return {
      stdout: err.stdout ? err.stdout.toString() : "",
      stderr: err.stderr ? err.stderr.toString() : String(error),
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

function isInternalDispatchPath(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
  return (
    normalized === ".vela" ||
    normalized.startsWith(".vela/") ||
    normalized === ".harness" ||
    normalized.startsWith(".harness/")
  );
}

/**
 * Captures the current workspace state into an immutable Git tree object using a temporary
 * GIT_INDEX_FILE, leaving the user's real git index, staged changes, and commits untouched.
 */
export async function captureWorkspaceSnapshot(projectRoot: string): Promise<WorkspaceSnapshot> {
  const inside = await runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return { isGitRepo: false, branchName: "workspace", baseCommit: "", baselineTree: null };
  }

  const [branchRes, headRes] = await Promise.all([
    runGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(projectRoot, ["rev-parse", "HEAD"]),
  ]);

  const branchName = branchRes.exitCode === 0 ? branchRes.stdout.trim() || "HEAD" : "HEAD";
  const baseCommit = headRes.exitCode === 0 ? headRes.stdout.trim() : "";

  const tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vela-dispatch-idx-"));
  const tempIndex = NodePath.join(tmpDir, "index");
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    if (baseCommit) {
      await runGit(projectRoot, ["read-tree", baseCommit], env);
    }
    await runGit(projectRoot, ["add", "-A", "--", ".", ":(exclude).vela", ":(exclude).harness"], env);
    const writeTree = await runGit(projectRoot, ["write-tree"], env);
    const baselineTree = writeTree.exitCode === 0 ? writeTree.stdout.trim() || null : null;
    return { isGitRepo: true, branchName, baseCommit, baselineTree };
  } finally {
    await NodeFSP.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function isValidGitTree(projectRoot: string, treeSha: string): Promise<boolean> {
  if (!treeSha) return false;
  const res = await runGit(projectRoot, ["cat-file", "-t", treeSha]);
  return res.exitCode === 0 && res.stdout.trim() === "tree";
}

/**
 * Computes exact incremental changed files + patch relative to `baselineTree` (direct mode)
 * or `HEAD` (worktree mode), automatically excluding `.vela/` and `.harness/` metadata.
 */
export async function inspectWorkspaceDelta(
  cwd: string,
  baselineTree: string | null,
): Promise<DispatchDiffSummary> {
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return { changedFiles: [], patch: "", truncated: false };
  }

  const tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vela-dispatch-diff-"));
  const tempIndex = NodePath.join(tmpDir, "index");
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    const baseRef =
      baselineTree && (await isValidGitTree(cwd, baselineTree)) ? baselineTree : "HEAD";

    await runGit(cwd, ["read-tree", baseRef], env);
    await runGit(cwd, ["add", "-A", "--", ".", ":(exclude).vela", ":(exclude).harness"], env);
    const currentTreeRes = await runGit(cwd, ["write-tree"], env);
    if (currentTreeRes.exitCode !== 0) {
      return { changedFiles: [], patch: "", truncated: false };
    }
    const currentTree = currentTreeRes.stdout.trim();
    if (!currentTree || currentTree === baseRef) {
      return { changedFiles: [], patch: "", truncated: false };
    }

    const [namesRes, patchRes] = await Promise.all([
      runGit(cwd, ["diff-tree", "-r", "--name-only", "--no-commit-id", baseRef, currentTree]),
      runGit(cwd, ["diff-tree", "-p", "--no-commit-id", "--unified=3", baseRef, currentTree]),
    ]);

    const changedFiles = namesRes.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !isInternalDispatchPath(line));

    const rawPatch = patchRes.stdout;
    const truncated = rawPatch.length > MAX_PATCH_CHARS;
    const patch = truncated
      ? `${rawPatch.slice(0, MAX_PATCH_CHARS)}\n\n... [diff truncated at ${MAX_PATCH_CHARS} chars]`
      : rawPatch;

    return { changedFiles, patch, truncated };
  } finally {
    await NodeFSP.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Safely reverts only the files touched since `baselineTree` back to their exact snapshot state
 * (restoring modified/deleted files and removing newly created files), without touching `.vela/`.
 */
export async function revertWorkspaceToSnapshot(
  cwd: string,
  baselineTree: string,
): Promise<{ readonly restoredFiles: ReadonlyArray<string>; readonly removedFiles: ReadonlyArray<string> }> {
  if (!(await isValidGitTree(cwd, baselineTree))) {
    throw new Error(`无效的快照树 (${baselineTree})，无法安全撤回`);
  }

  const tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vela-dispatch-revert-"));
  const tempIndex = NodePath.join(tmpDir, "index");
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    await runGit(cwd, ["read-tree", baselineTree], env);
    await runGit(cwd, ["add", "-A", "--", ".", ":(exclude).vela", ":(exclude).harness"], env);
    const currentTreeRes = await runGit(cwd, ["write-tree"], env);
    if (currentTreeRes.exitCode !== 0) {
      throw new Error("无法计算当前工作区变更");
    }
    const currentTree = currentTreeRes.stdout.trim();
    if (!currentTree || currentTree === baselineTree) {
      return { restoredFiles: [], removedFiles: [] };
    }

    const statusRes = await runGit(cwd, [
      "diff-tree",
      "-r",
      "--name-status",
      "--no-commit-id",
      baselineTree,
      currentTree,
    ]);

    const toRestore: string[] = [];
    const toRemove: string[] = [];
    for (const line of statusRes.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const code = parts[0]?.trim() ?? "";
      const filePath = parts[1]?.trim() ?? "";
      if (!filePath || isInternalDispatchPath(filePath)) continue;
      if (code.startsWith("A")) {
        toRemove.push(filePath);
      } else {
        toRestore.push(filePath);
      }
    }

    for (const rel of toRemove) {
      const abs = NodePath.join(cwd, rel);
      await NodeFSP.rm(abs, { recursive: true, force: true });
    }

    if (toRestore.length > 0) {
      // Restore files from baselineTree into working tree using temporary index so real index stays untouched.
      const restoreIdx = NodePath.join(tmpDir, "restore-index");
      const restoreEnv = { GIT_INDEX_FILE: restoreIdx };
      await runGit(cwd, ["read-tree", baselineTree], restoreEnv);
      await runGit(cwd, ["checkout-index", "-f", "--", ...toRestore], restoreEnv);
    }

    return { restoredFiles: toRestore, removedFiles: toRemove };
  } finally {
    await NodeFSP.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Applies uncommitted + newly created worktree changes back onto `targetWorkspaceRoot` without committing. */
export async function applyWorktreeDeltaToWorkspace(
  worktreePath: string,
  targetWorkspaceRoot: string,
): Promise<{ readonly appliedFiles: ReadonlyArray<string> }> {
  const inside = await runGit(worktreePath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return { appliedFiles: [] };
  }
  if (NodePath.resolve(worktreePath) === NodePath.resolve(targetWorkspaceRoot)) {
    return { appliedFiles: [] };
  }

  const tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vela-dispatch-merge-"));
  const tempIndex = NodePath.join(tmpDir, "index");
  const patchFile = NodePath.join(tmpDir, "delta.patch");
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    const headTreeRes = await runGit(worktreePath, ["rev-parse", "HEAD^{tree}"]);
    if (headTreeRes.exitCode !== 0) {
      throw new Error("无法读取 Worktree 的基线提交树");
    }
    const headTree = headTreeRes.stdout.trim();
    await runGit(worktreePath, ["read-tree", "HEAD"], env);
    await runGit(worktreePath, ["add", "-A", "--", ".", ":(exclude).vela", ":(exclude).harness"], env);
    const writeTreeRes = await runGit(worktreePath, ["write-tree"], env);
    if (writeTreeRes.exitCode !== 0) {
      throw new Error("无法计算 Worktree 增量改动");
    }
    const wtTree = writeTreeRes.stdout.trim();
    if (!wtTree || wtTree === headTree) {
      return { appliedFiles: [] };
    }

    const [namesRes, patchRes] = await Promise.all([
      runGit(worktreePath, ["diff-tree", "-r", "--name-only", "--no-commit-id", "HEAD", wtTree]),
      runGit(worktreePath, ["diff-tree", "-p", "--binary", "--no-commit-id", "HEAD", wtTree]),
    ]);

    const appliedFiles = namesRes.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !isInternalDispatchPath(line));

    if (appliedFiles.length === 0 || !patchRes.stdout) {
      return { appliedFiles: [] };
    }

    await NodeFSP.writeFile(patchFile, patchRes.stdout, "utf8");

    const checkRes = await runGit(targetWorkspaceRoot, [
      "apply",
      "--check",
      "--whitespace=nowarn",
      patchFile,
    ]);
    if (checkRes.exitCode !== 0) {
      throw new Error(`合并 Worktree 改动存在冲突，未修改当前工作区：${checkRes.stderr.trim()}`);
    }

    const applyRes = await runGit(targetWorkspaceRoot, [
      "apply",
      "--whitespace=nowarn",
      patchFile,
    ]);
    if (applyRes.exitCode !== 0) {
      throw new Error(`应用 Worktree 补丁失败：${applyRes.stderr.trim()}`);
    }

    return { appliedFiles };
  } finally {
    await NodeFSP.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Converts a standard glob (`*`, `**`, `?`) into a RegExp over POSIX relative paths. */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  let pattern = "^";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          pattern += "(?:.*/)?";
          i += 3;
          continue;
        }
        pattern += ".*";
        i += 2;
        continue;
      }
      pattern += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      pattern += "[^/]";
      i += 1;
      continue;
    }
    if ("+.^$()[]{}|\\".includes(ch)) {
      pattern += `\\${ch}`;
      i += 1;
      continue;
    }
    pattern += ch;
    i += 1;
  }
  pattern += "$";
  return new RegExp(pattern);
}

export function matchesAnyGlob(filePath: string, globs: ReadonlyArray<string>): boolean {
  if (globs.length === 0) return false;
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return globs.some((glob) => {
    const trimmed = glob.trim();
    if (!trimmed) return false;
    // Allow directory prefix shorthand like "apps/web/src" to match anything underneath.
    if (!trimmed.includes("*") && !trimmed.includes("?")) {
      const clean = trimmed.replace(/\/+$/, "");
      if (normalized === clean || normalized.startsWith(`${clean}/`)) return true;
    }
    return globToRegExp(trimmed).test(normalized);
  });
}

export function auditPathBoundaries(
  changedFiles: ReadonlyArray<string>,
  rules: {
    readonly allowedGlobs: ReadonlyArray<string>;
    readonly forbiddenGlobs: ReadonlyArray<string>;
    readonly sensitiveGlobs: ReadonlyArray<string>;
  },
): DispatchBoundaryAudit {
  const outOfScopeFiles: string[] = [];
  const forbiddenFiles: string[] = [];
  const sensitiveFiles: string[] = [];

  for (const file of changedFiles) {
    if (isInternalDispatchPath(file)) continue;
    if (matchesAnyGlob(file, rules.forbiddenGlobs)) {
      forbiddenFiles.push(file);
    }
    if (matchesAnyGlob(file, rules.sensitiveGlobs)) {
      sensitiveFiles.push(file);
    }
    if (rules.allowedGlobs.length > 0 && !matchesAnyGlob(file, rules.allowedGlobs)) {
      outOfScopeFiles.push(file);
    }
  }

  return {
    ok: outOfScopeFiles.length === 0 && forbiddenFiles.length === 0 && sensitiveFiles.length === 0,
    outOfScopeFiles,
    forbiddenFiles,
    sensitiveFiles,
  };
}

function runSingleGateCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DispatchHardGateItem> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const isWindows = NodePath.sep === "\\";
    const shell = isWindows ? "cmd.exe" : "/bin/zsh";
    const shellArgs = isWindows ? ["/d", "/s", "/c", command] : ["-lc", command];
    const child = NodeChildProcess.spawn(shell, shellArgs, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const append = (chunk: Buffer) => {
      if (output.length >= MAX_GATE_OUTPUT_CHARS * 2) return;
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let finished = false;
    const finish = (exitCode: number, extraNote?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const trimmed = (extraNote ? `${output}\n${extraNote}` : output).trim();
      const bounded =
        trimmed.length > MAX_GATE_OUTPUT_CHARS
          ? `... [truncated]\n${trimmed.slice(-MAX_GATE_OUTPUT_CHARS)}`
          : trimmed;
      resolve({
        command,
        ok: exitCode === 0,
        exitCode,
        durationMs: Date.now() - startedAt,
        output: bounded,
      });
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      finish(130, "命令已中止");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(124, `命令超时 (${Math.round(timeoutMs / 1000)}s)`);
    }, timeoutMs);

    child.on("error", (err) => finish(1, err.message));
    child.on("close", (code) => finish(code ?? 1));
  });
}

export async function runHardGates(
  cwd: string,
  commands: ReadonlyArray<string>,
  options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<DispatchHardGateSummary> {
  const uniqueCommands = [...new Set(commands.map((c) => c.trim()).filter(Boolean))];
  if (uniqueCommands.length === 0) {
    return { ok: true, results: [], logText: "" };
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const results: DispatchHardGateItem[] = [];
  for (const command of uniqueCommands) {
    if (options?.signal?.aborted) break;
    if (!NodeFS.existsSync(cwd)) {
      results.push({
        command,
        ok: false,
        exitCode: 1,
        durationMs: 0,
        output: `工作目录不存在：${cwd}`,
      });
      break;
    }
    const item = await runSingleGateCommand(cwd, command, timeoutMs, options?.signal);
    results.push(item);
    if (!item.ok) break;
  }

  const ok = results.length === uniqueCommands.length && results.every((r) => r.ok);
  const logText = results
    .map(
      (r) =>
        `$ ${r.command} (exit ${r.exitCode}, ${r.durationMs}ms)\n${r.output || "(no output)"}`,
    )
    .join("\n\n");

  return { ok, results, logText };
}
