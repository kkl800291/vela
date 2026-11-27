// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  assertGitVersion,
  captureAndVerifyStepCandidate,
  captureWorkspaceSnapshot,
  compareAndSwapCollabRef,
  createManagedWorktree,
  freezeDelivery,
  freezeStepBase,
  initializeCollabPlan,
  integrateReviewedStep,
  planRefs,
  preflightAndApplyDelivery,
  probeRepository,
  readSnapshotFileDiff,
  readSnapshotFileLines,
  readSnapshotManifest,
  reconcileInterruptedDelivery,
  releaseCollabRef,
  releaseManagedWorktree,
  revertDeliverySafely,
  stepRefs,
  synchronizeIntegrationWorktree,
} from "./VelaCollabGit.ts";
import type { CollabDeliveryRecovery } from "./VelaCollabTypes.ts";

const directories: string[] = [];
const identity = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    env: { ...process.env, ...identity },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();

async function sandbox(files?: Record<string, string | Buffer>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vela-collab-test-")));
  directories.push(root);
  const repo = join(root, "target");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  if (files) {
    for (const [path, data] of Object.entries(files)) await write(repo, path, data);
    seed(repo);
  }
  return { root, repo };
}

function seed(repo: string) {
  git(repo, "add", "-Af", ".");
  const tree = git(repo, "write-tree");
  const oid = git(repo, "commit-tree", tree, "-m", "fixture");
  git(repo, "update-ref", "HEAD", oid);
  return oid;
}

async function write(repo: string, path: string, text: string | Buffer) {
  const destination = join(repo, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, text);
}

async function fixture(files: Record<string, string | Buffer> = { "base.txt": "base\n" }) {
  const { root, repo } = await sandbox(files);
  const snapshot = await initializeCollabPlan(repo, "p");
  const managed = join(root, "managed");
  const worktree = () => createManagedWorktree(repo, managed, snapshot.commitOid);
  const candidate = async (changes: Record<string, string | Buffer>) => {
    const worker = await worktree();
    for (const [path, value] of Object.entries(changes)) await write(worker.path, path, value);
    return captureWorkspaceSnapshot(worker.path);
  };
  const publish = async (changes: Record<string, string | Buffer>) => {
    const result = await candidate(changes);
    await freezeDelivery(repo, "p", result.commitOid);
    return result;
  };
  const deliveryInput = (
    deliveryOid: string,
    persistRecovery: (record: CollabDeliveryRecovery) => Promise<void> = async () => {},
  ) => ({
    binding: snapshot.repository,
    planId: "p",
    operationId: "apply",
    baseOid: snapshot.commitOid,
    deliveryOid,
    expectedTargetState: snapshot.treeOid,
    persistRecovery,
  });
  return { repo, root, snapshot, worktree, candidate, publish, deliveryInput };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const lines = Array.from({ length: 30 }, (_, index) => `line ${index}\n`);
const changeLine = (index: number, value: string) =>
  lines.map((line, i) => (i === index ? value + "\n" : line)).join("");

describe("Vela Collaboration Git", () => {
  it("supports unrestricted paths, task globs and prepared worktrees without allowing gate drift", async () => {
    const { repo, snapshot, worktree } = await fixture({
      ".gitignore": "node_modules/\n",
      "base.txt": "base\n",
    });
    const worker = await worktree();
    await write(worker.path, "src/new.ts", "new");
    await write(worker.path, "node_modules/tool", "prepared");
    await freezeStepBase(repo, "p", "allow", 1, snapshot.commitOid);
    const input = {
      repoDir: repo,
      planId: "p",
      stepId: "allow",
      attempt: 1,
      stepBaseOid: snapshot.commitOid,
      criteriaVersion: 1,
      candidate: { worktreePath: worker.path },
      executionWorktreePath: worker.path,
      allowedPaths: [],
      hardGates: ["test -f node_modules/tool && test $(cat src/new.ts) = new"],
    };
    expect(await captureAndVerifyStepCandidate(input)).toMatchObject({ status: "verified" });
    await freezeStepBase(repo, "p", "glob", 1, snapshot.commitOid);
    expect(
      await captureAndVerifyStepCandidate({
        ...input,
        stepId: "glob",
        allowedGlobs: ["src/**/*.ts"],
        forbiddenGlobs: ["src/n?w.ts"],
      }),
    ).toMatchObject({ status: "boundary_violation", violations: ["src/new.ts"] });
    await freezeStepBase(repo, "p", "drift", 1, snapshot.commitOid);
    await expect(
      captureAndVerifyStepCandidate({
        ...input,
        stepId: "drift",
        allowedGlobs: ["src/**/*.ts"],
        hardGates: ["printf changed > src/new.ts"],
      }),
    ).rejects.toThrow(/changed the controlled snapshot/);
    await freezeStepBase(repo, "p", "wrong", 1, snapshot.commitOid);
    const other = await worktree();
    await expect(
      captureAndVerifyStepCandidate({
        ...input,
        stepId: "wrong",
        executionWorktreePath: other.path,
      }),
    ).rejects.toThrow(/does not match the frozen candidate/);
    const foreign = await fixture();
    await expect(
      captureAndVerifyStepCandidate({
        ...input,
        stepId: "wrong",
        executionWorktreePath: (await foreign.worktree()).path,
      }),
    ).rejects.toThrow(/same Git repository/);
  });

  it("probes non-Git, validates Git version and starts an unborn snapshot chain", async () => {
    const { root, repo } = await sandbox();
    expect(await probeRepository(root)).toEqual({
      kind: "non_git",
      canonicalTargetWorktree: root,
      gitCommonDir: null,
    });
    await expect(captureWorkspaceSnapshot(root)).rejects.toThrow(/research and decisions/);
    expect(() => assertGitVersion("git version 2.37.9")).toThrow(/Git 2.38/);
    expect(() => assertGitVersion("git version 2.38.0")).not.toThrow();
    await write(repo, "new", "pending\n");
    const base = await initializeCollabPlan(repo, "first");
    expect(base.repository.headOid).toBeNull();
    expect(git(repo, "rev-list", "--parents", "-1", base.commitOid)).toBe(base.commitOid);
    expect(git(repo, "rev-parse", planRefs("first").integration)).toBe(base.commitOid);
    expect(git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    await expect(readFile(join(repo, ".git/index"))).rejects.toMatchObject({ code: "ENOENT" });
    await write(repo, "new", "later\n");
    expect((await initializeCollabPlan(repo, "first")).commitOid).toBe(base.commitOid);
  });

  it("captures disk bytes for HEAD and index paths, including staged ignored adds, and excludes Vela metadata", async () => {
    const { repo } = await sandbox({
      "staged-delete": "head",
      ".vela/tracked": "internal",
      ".harness/tracked": "internal",
    });
    git(repo, "rm", "--cached", "staged-delete");
    await write(repo, "staged-delete", "working\r\n");
    await write(repo, "stage-me", "staged\n");
    git(repo, "add", "stage-me");
    await write(repo, ".gitignore", "stage-me\nignored\n");
    await write(repo, "stage-me", "working\n");
    await write(repo, "ignored", "ignore\n");
    await write(repo, ".vela/untracked", "internal");
    await write(repo, ".harness/tracked", "changed");
    await write(repo, "strange\tname\n雪.txt", "utf8");
    const before = await readFile(join(repo, ".git/index"));
    const headLog = await readFile(join(repo, ".git/logs/HEAD"));
    const snapshot = await captureWorkspaceSnapshot(repo);
    expect(git(repo, "ls-tree", "-r", "--name-only", snapshot.commitOid)).not.toMatch(
      /\.(vela|harness)|^ignored$/m,
    );
    expect(git(repo, "show", `${snapshot.commitOid}:stage-me`)).toBe("working");
    expect(git(repo, "show", `${snapshot.commitOid}:staged-delete`)).toBe("working");
    expect(
      (await readSnapshotFileLines(repo, snapshot.commitOid, "strange\tname\n雪.txt")).kind,
    ).toBe("lines");
    expect(await readFile(join(repo, ".git/index"))).toEqual(before);
    expect(await readFile(join(repo, ".git/logs/HEAD"))).toEqual(headLog);
  });

  it("rejects sparse checkouts, case collisions, nested repos, and custom filter / merge attributes", async () => {
    const { repo, snapshot, worktree } = await fixture();
    git(repo, "config", "core.sparseCheckout", "true");
    await expect(captureWorkspaceSnapshot(repo)).rejects.toThrow(/Sparse checkout/);
    git(repo, "config", "--unset", "core.sparseCheckout");
    await write(repo, ".gitattributes", "base.txt filter=custom\n");
    await expect(captureWorkspaceSnapshot(repo)).rejects.toThrow(/filter=custom/);
    await write(repo, ".gitattributes", "base.txt merge=custom\n");
    await expect(captureWorkspaceSnapshot(repo)).rejects.toThrow(/merge=custom/);
    await rm(join(repo, ".gitattributes"));
    await mkdir(join(repo, "nested"));
    git(join(repo, "nested"), "init", "-q");
    await expect(captureWorkspaceSnapshot(repo)).rejects.toThrow(/Nested Git repository/);
    const worker = await worktree();
    git(
      worker.path,
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${git(repo, "rev-parse", `${snapshot.commitOid}:base.txt`)},BASE.txt`,
    );
    await expect(captureWorkspaceSnapshot(worker.path)).rejects.toThrow(/collision/);
  });

  it("locks hard gates to a frozen input and refuses modified controlled files or boundary violations", async () => {
    const { repo, snapshot, worktree } = await fixture();
    const worker = await worktree();
    await write(worker.path, "base.txt", "reviewed\n");
    await freezeStepBase(repo, "p", "step", 1, snapshot.commitOid);
    const input = {
      repoDir: repo,
      planId: "p",
      stepId: "step",
      attempt: 1,
      stepBaseOid: snapshot.commitOid,
      criteriaVersion: 1,
      candidate: { worktreePath: worker.path },
      allowedPaths: ["base.txt"],
    };
    await expect(
      captureAndVerifyStepCandidate({ ...input, allowedPaths: ["other"], hardGates: [] }),
    ).resolves.toMatchObject({ status: "boundary_violation", violations: ["base.txt"] });
    await expect(
      captureAndVerifyStepCandidate({ ...input, hardGates: ["exit 3"] }),
    ).resolves.toMatchObject({ status: "gate_failed" });
    await expect(
      captureAndVerifyStepCandidate({ ...input, hardGates: ["printf changed > base.txt"] }),
    ).rejects.toThrow(/changed the controlled snapshot/);

    const workerFile = JSON.stringify(join(worker.path, "base.txt"));
    const result = await captureAndVerifyStepCandidate({
      ...input,
      hardGates: [
        `printf replaced > ${workerFile}; test "$(cat base.txt)" = reviewed; touch build-output`,
      ],
    });
    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("Expected frozen evidence.");
    expect(result.evidence.changedFiles).toMatchObject([{ path: "base.txt", status: "M" }]);
    expect(await readFile(join(worker.path, "base.txt"), "utf8")).toBe("replaced");
    expect(git(repo, "show", `${stepRefs("p", "step", 1).reviewed}:base.txt`)).toBe("reviewed");
  });

  it("returns clean, changed effective manifests, and conflicts, and synchronizes only after a ref CAS", async () => {
    const { repo, snapshot, candidate, worktree } = await fixture({ "base.txt": lines.join("") });
    const isolated = await worktree();
    const a = await candidate({ "base.txt": changeLine(0, "ours") });
    const b = await candidate({ "base.txt": changeLine(29, "theirs") });
    const c = await candidate({ "base.txt": changeLine(0, "conflict") });
    const d = await candidate({ "separate.txt": "separate\n" });
    const merge = (integrationOid: string, reviewedOid: string) =>
      integrateReviewedStep({
        repoDir: repo,
        stepBaseOid: snapshot.commitOid,
        integrationOid,
        reviewedOid,
      });
    await compareAndSwapCollabRef(repo, planRefs("p").integration, a.commitOid, snapshot.commitOid);
    await synchronizeIntegrationWorktree(isolated, snapshot.commitOid, a.commitOid);
    await expect(merge(a.commitOid, b.commitOid)).resolves.toMatchObject({
      status: "manifest_changed",
    });
    await expect(merge(a.commitOid, c.commitOid)).resolves.toEqual({
      status: "conflict",
      conflictFiles: ["base.txt"],
    });
    const clean = await merge(a.commitOid, d.commitOid);
    expect(clean.status).toBe("clean");
    expect(git(repo, "rev-parse", planRefs("p").integration)).toBe(a.commitOid);
    await expect(readFile(join(isolated.path, "separate.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (clean.status !== "clean") throw new Error("Expected clean integration.");
    await expect(
      compareAndSwapCollabRef(
        repo,
        planRefs("p").integration,
        clean.mergedCommitOid,
        snapshot.commitOid,
      ),
    ).rejects.toThrow();
    await compareAndSwapCollabRef(
      repo,
      planRefs("p").integration,
      clean.mergedCommitOid,
      a.commitOid,
    );
    await synchronizeIntegrationWorktree(isolated, a.commitOid, clean.mergedCommitOid);
    await synchronizeIntegrationWorktree(isolated, a.commitOid, clean.mergedCommitOid);
    expect(await readFile(join(isolated.path, "separate.txt"), "utf8")).toBe("separate\n");
  });

  it("reports binary metadata, renames, bounded patch pages, and frozen file lines", async () => {
    const { repo, snapshot, worktree } = await fixture({
      "base.txt": "one\ntwo\nthree\n",
      "old.txt": "move\n",
      "base.bin": Buffer.from([0, 1, 2]),
      ".vela/user": "internal",
    });
    const worker = await worktree();
    await write(worker.path, "base.txt", "one\n新内容\nthree\n");
    await write(worker.path, "new.txt", "move\n");
    await rm(join(worker.path, "old.txt"));
    await write(worker.path, "base.bin", Buffer.from([0, 2, 3, 4]));
    const target = await captureWorkspaceSnapshot(worker.path);
    const manifest = await readSnapshotManifest(repo, snapshot.commitOid, target.commitOid);
    expect(manifest).toMatchObject([
      {
        path: "base.bin",
        status: "M",
        isBinary: true,
        sizeBytes: 4,
        additions: null,
        deletions: null,
      },
      { path: "base.txt", status: "M", isBinary: false, additions: 1, deletions: 1 },
      { path: "new.txt", oldPath: "old.txt", status: "R" },
    ]);
    await expect(
      readSnapshotFileDiff(repo, snapshot.commitOid, target.commitOid, "base.bin"),
    ).resolves.toMatchObject({ kind: "binary" });
    const first = await readSnapshotFileDiff(
      repo,
      snapshot.commitOid,
      target.commitOid,
      "base.txt",
      { maxBytes: 12 },
    );
    expect(first).toMatchObject({ kind: "patch", byteLength: 12, nextOffset: 12 });
    const second = await readSnapshotFileDiff(
      repo,
      snapshot.commitOid,
      target.commitOid,
      "base.txt",
      { offset: 12, maxBytes: 12 },
    );
    expect(second).toMatchObject({ kind: "patch", byteLength: 12, nextOffset: 24 });
    await write(worker.path, "base.txt", "overwrite");
    await expect(
      readSnapshotFileLines(repo, target.commitOid, "base.txt", { startLine: 2, endLine: 2 }),
    ).resolves.toMatchObject({ kind: "lines", text: "新内容\n", byteLength: 10, truncated: false });
    await expect(
      readSnapshotFileLines(repo, target.commitOid, "base.txt", { startLine: 2, maxBytes: 2 }),
    ).resolves.toMatchObject({ kind: "lines", encoding: "base64", byteLength: 2, truncated: true });
    await expect(readSnapshotFileLines(repo, target.commitOid, "../base.txt")).rejects.toThrow(
      /safely/,
    );
  });

  it("conflicts when both branches change binary content, even when their bytes agree", async () => {
    const { repo, snapshot, candidate } = await fixture({ "file.bin": Buffer.from([0, 1]) });
    const both = await candidate({ "file.bin": Buffer.from([0, 2]) });
    await expect(
      integrateReviewedStep({
        repoDir: repo,
        stepBaseOid: snapshot.commitOid,
        integrationOid: both.commitOid,
        reviewedOid: both.commitOid,
      }),
    ).resolves.toEqual({ status: "conflict", conflictFiles: ["file.bin"] });
  });

  it("preserves pinned clean submodules and blocks dirty, staged-changed, and removed gitlinks", async () => {
    const { root, repo } = await sandbox();
    const sub = join(root, "source");
    await mkdir(sub);
    git(sub, "init", "-q");
    await write(sub, "file", "content");
    seed(sub);
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
    seed(repo);
    const opening = await initializeCollabPlan(repo, "p");
    expect(git(repo, "ls-tree", opening.commitOid, "sub")).toMatch(/^160000 commit /);
    const worktree = await createManagedWorktree(repo, join(root, "managed"), opening.commitOid);
    expect((await captureWorkspaceSnapshot(worktree.path)).treeOid).toBe(opening.treeOid);
    await write(repo, "sub/file", "dirty");
    await expect(captureWorkspaceSnapshot(repo)).rejects.toThrow(/Dirty or changed submodule/);
    await write(repo, "sub/file", "content");
    git(repo, "rm", "--cached", "sub");
    await expect(captureWorkspaceSnapshot(repo)).rejects.toThrow(/gitlink removed/);
  });

  it("keeps the real index through a dirty start, detects drift, then applies a reverified delivery once", async () => {
    const { repo, root } = await sandbox({ "base.txt": lines.join(""), "other.txt": "clean\n" });
    await write(repo, "other.txt", "already dirty before plan\n");
    const snapshot = await initializeCollabPlan(repo, "p");
    const worker = await createManagedWorktree(repo, join(root, "managed"), snapshot.commitOid);
    await write(worker.path, "base.txt", changeLine(0, "agent"));
    const delivery = await captureWorkspaceSnapshot(worker.path);
    await freezeDelivery(repo, "p", delivery.commitOid);
    await write(repo, "base.txt", changeLine(29, "user"));
    git(repo, "add", "other.txt");
    const before = await readFile(join(repo, ".git/index"));
    const persistRecovery = async () => {};
    const input = {
      binding: snapshot.repository,
      planId: "p",
      operationId: "a",
      baseOid: snapshot.commitOid,
      deliveryOid: delivery.commitOid,
      expectedTargetState: snapshot.treeOid,
      persistRecovery,
    };
    const drift = await preflightAndApplyDelivery(input);
    expect(drift.status).toBe("drifted_needs_reverify");
    expect(await readFile(join(repo, "base.txt"), "utf8")).toBe(changeLine(29, "user"));
    if (drift.status !== "drifted_needs_reverify")
      throw new Error("Expected a candidate for re-verification.");
    await freezeDelivery(repo, "p", drift.mergedCandidateCommitOid, delivery.commitOid);
    await expect(preflightAndApplyDelivery(input)).rejects.toThrow(/stale/);
    await expect(
      preflightAndApplyDelivery({
        ...input,
        baseOid: drift.expectedTargetState,
        deliveryOid: drift.mergedCandidateCommitOid,
        expectedTargetState: drift.expectedTargetState,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(await readFile(join(repo, "base.txt"), "utf8")).toMatch(/^agent\n[\s\S]+user\n$/);
    expect(await readFile(join(repo, "other.txt"), "utf8")).toBe("already dirty before plan\n");
    expect(await readFile(join(repo, ".git/index"))).toEqual(before);
  });

  it("keeps conflicts zero-write and will not write through an ignored symlink parent", async () => {
    const { repo, root, snapshot, worktree, deliveryInput } = await fixture({
      ".gitignore": "container\n",
      "base.txt": "base\n",
    });
    const worker = await worktree();
    await write(worker.path, "container/file", "new");
    git(worker.path, "add", "-f", "container/file");
    await write(worker.path, "base.txt", "agent");
    const delivery = await captureWorkspaceSnapshot(worker.path);
    await freezeDelivery(repo, "p", delivery.commitOid);
    await write(repo, "base.txt", "user");
    await expect(preflightAndApplyDelivery(deliveryInput(delivery.commitOid))).resolves.toEqual({
      status: "conflict",
      conflictFiles: ["base.txt"],
    });
    await write(repo, "base.txt", "base\n");
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(repo, "container"));
    await expect(preflightAndApplyDelivery(deliveryInput(delivery.commitOid))).resolves.toEqual({
      status: "conflict",
      conflictFiles: ["container/file"],
    });
    await expect(readFile(join(outside, "file"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(repo, "base.txt"), "utf8")).toBe("base\n");
    expect((await captureWorkspaceSnapshot(repo)).treeOid).toBe(snapshot.treeOid);
  });

  it("materializes symlink entries and executable modes without following the link target", async () => {
    const { repo, root, worktree, deliveryInput } = await fixture();
    const worker = await worktree();
    const outside = join(root, "outside");
    await writeFile(outside, "outside");
    await symlink(outside, join(worker.path, "link"));
    await write(worker.path, "tool", "executable");
    await chmod(join(worker.path, "tool"), 0o755);
    const candidate = await captureWorkspaceSnapshot(worker.path);
    await freezeDelivery(repo, "p", candidate.commitOid);
    await expect(
      preflightAndApplyDelivery(deliveryInput(candidate.commitOid)),
    ).resolves.toMatchObject({ status: "applied" });
    expect(await readlink(join(repo, "link"))).toBe(outside);
    expect(await readFile(outside, "utf8")).toBe("outside");
    expect(git(repo, "ls-tree", candidate.commitOid, "tool")).toMatch(/^100755/);
  });

  it("persists recovery before writes, stops on third content, and completes an interrupted application", async () => {
    const { repo, snapshot, publish, deliveryInput } = await fixture({
      a: "original a",
      b: "original b",
    });
    const delivery = await publish({ a: "new a", b: "new b" });
    const records: CollabDeliveryRecovery[] = [];
    await expect(
      preflightAndApplyDelivery(
        deliveryInput(delivery.commitOid, async (record) => {
          records.push(record);
          expect(await readFile(join(repo, "a"), "utf8")).toBe("original a");
          throw new Error("simulated crash");
        }),
      ),
    ).rejects.toThrow(/simulated crash/);
    const record = records[0];
    if (!record) throw new Error("No recovery record.");
    await write(repo, "a", "new a");
    await write(repo, "b", "external");
    await expect(reconcileInterruptedDelivery(snapshot.repository, record)).rejects.toMatchObject({
      paths: ["b"],
    });
    expect(await readFile(join(repo, "a"), "utf8")).toBe("new a");
    expect(await readFile(join(repo, "b"), "utf8")).toBe("external");
    await write(repo, "b", "original b");
    await expect(reconcileInterruptedDelivery(snapshot.repository, record)).resolves.toMatchObject({
      status: "reconciled",
    });
    await expect(reconcileInterruptedDelivery(snapshot.repository, record)).resolves.toMatchObject({
      status: "reconciled",
    });
    expect(await readFile(join(repo, "b"), "utf8")).toBe("new b");
  });

  it("reverts the entire delivery while preserving later user edits, and leaves conflicts untouched", async () => {
    const { repo, snapshot, publish, deliveryInput } = await fixture({
      "base.txt": lines.join(""),
      second: "old\n",
    });
    const delivery = await publish({ "base.txt": changeLine(0, "agent"), second: "new\n" });
    const applied = await preflightAndApplyDelivery(deliveryInput(delivery.commitOid));
    if (applied.status !== "applied") throw new Error("Expected delivery applied.");
    const input = {
      ...applied,
      binding: snapshot.repository,
      planId: "p",
      operationId: "revert",
      persistRecovery: async () => {},
    };
    await write(repo, "base.txt", changeLine(0, "user-conflict"));
    await expect(revertDeliverySafely(input)).resolves.toEqual({
      status: "conflict",
      conflictFiles: ["base.txt"],
    });
    expect(await readFile(join(repo, "second"), "utf8")).toBe("new\n");
    await write(repo, "base.txt", changeLine(0, "agent").replace("line 29", "user"));
    await expect(revertDeliverySafely(input)).resolves.toMatchObject({ status: "reverted" });
    expect(await readFile(join(repo, "base.txt"), "utf8")).toBe(changeLine(29, "user"));
    expect(await readFile(join(repo, "second"), "utf8")).toBe("old\n");
  });

  it("only reclaims released, clean managed worktrees and exact hidden refs", async () => {
    const { repo, snapshot, worktree } = await fixture();
    const clean = await worktree();
    const dirty = await worktree();
    await write(dirty.path, "keep", "local");
    await expect(releaseManagedWorktree(clean, false)).resolves.toMatchObject({
      status: "retained",
    });
    await expect(releaseManagedWorktree(dirty, true)).resolves.toMatchObject({
      status: "retained",
    });
    await expect(releaseManagedWorktree(clean, true)).resolves.toMatchObject({ status: "removed" });
    await freezeStepBase(repo, "p", "released", 1, snapshot.commitOid);
    const ref = stepRefs("p", "released", 1).base;
    await expect(
      releaseCollabRef(repo, { ref, oid: snapshot.commitOid, released: false }),
    ).resolves.toBe(false);
    await expect(
      releaseCollabRef(repo, { ref, oid: "0".repeat(snapshot.commitOid.length), released: true }),
    ).rejects.toThrow();
    await expect(
      releaseCollabRef(repo, { ref, oid: snapshot.commitOid, released: true }),
    ).resolves.toBe(true);
  });
});
