// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  effectiveWrites,
  mergeTrees,
  readSnapshotManifest,
  requireStableGitlinks,
} from "./VelaCollabGitEvidence.ts";
import {
  assertOid,
  assertPath,
  captureTree,
  checkTreeAttributes,
  gitError,
  commitTree,
  decodeUtf8,
  git,
  isInternal,
  requireCommit,
  requireRepository,
  resolveTree,
  statPath,
  treeEntries,
  withIsolatedSnapshotRepository,
  type GitBinding,
} from "./VelaCollabGitObjects.ts";
import {
  applyWrites,
  isCollabWorktreeChanged,
  materializeTree,
  preflightWrites,
  runSnapshotGates,
  worktreeChanged,
} from "./VelaCollabGitWorktree.ts";
import { globToRegExp } from "./VelaDispatchGit.ts";
import type {
  CollabDeliveryRecovery,
  CollabDeliveryWrite,
  CollabGateSummary,
  CollabReviewEvidence,
} from "./VelaCollabTypes.ts";

export {
  readSnapshotManifest,
  readSnapshotFileDiff,
  readSnapshotFileLines,
} from "./VelaCollabGitEvidence.ts";
export { assertGitVersion, CollabGitError, probeRepository } from "./VelaCollabGitObjects.ts";
export { CollabWorktreeChanged } from "./VelaCollabGitWorktree.ts";

function refComponent(id: string) {
  if (
    !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(id) ||
    id.includes("..") ||
    id.endsWith(".") ||
    id.endsWith(".lock")
  ) {
    throw gitError(`Invalid collaboration ref component ${JSON.stringify(id)}.`);
  }
  return id;
}

export function planRefs(planId: string) {
  const prefix = `refs/vela/collab/${refComponent(planId)}`;
  return {
    base: `${prefix}/base`,
    integration: `${prefix}/integration`,
    delivery: `${prefix}/delivery`,
  };
}

export function stepRefs(planId: string, stepId: string, attempt: number) {
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw gitError("Invalid collaboration attempt.");
  const prefix = `refs/vela/collab/${refComponent(planId)}/steps/${refComponent(stepId)}/r${attempt}`;
  return {
    base: `${prefix}/base`,
    candidate: `${prefix}/candidate`,
    reviewed: `${prefix}/reviewed`,
  };
}

export function deliveryOperationRefs(planId: string, operationId: string) {
  const prefix = `refs/vela/collab/${refComponent(planId)}/operations/${refComponent(operationId)}`;
  return { base: `${prefix}/base`, result: `${prefix}/result` };
}

async function validateCollabRef(repo: string, ref: string) {
  if (!ref.startsWith("refs/vela/collab/")) throw gitError("Expected a collaboration ref.");
  for (const part of ref.slice("refs/vela/collab/".length).split("/")) refComponent(part);
  await git(repo, ["check-ref-format", ref]);
}

export async function readCollabRef(repo: string, ref: string) {
  const result = await git(repo, ["show-ref", "--verify", "--hash", ref], { allow: [128] });
  if (result.exitCode === 128 && result.stderr === `fatal: '${ref}' - not a valid ref`) return null;
  if (result.exitCode !== 0) throw gitError(result.stderr || `Cannot read ${ref}.`);
  return assertOid(decodeUtf8(result.stdout).trim());
}

export async function compareAndSwapCollabRef(
  repo: string,
  ref: string,
  newOid: string,
  oldOid: string | null,
) {
  await validateCollabRef(repo, ref);
  if (oldOid !== null && !/^refs\/vela\/collab\/[^/]+\/(integration|delivery)$/.test(ref)) {
    throw gitError("Frozen collaboration evidence cannot be replaced.");
  }
  await requireCommit(repo, newOid);
  await git(repo, [
    "-c",
    "core.logAllRefUpdates=false",
    "update-ref",
    "--no-deref",
    ref,
    newOid,
    oldOid === null ? "0".repeat(newOid.length) : assertOid(oldOid),
  ]);
}

async function freezeRef(repo: string, ref: string, oid: string) {
  const current = await readCollabRef(repo, ref);
  if (current === oid) return;
  if (current !== null) throw gitError(`Immutable collaboration ref ${ref} is already frozen.`);
  await compareAndSwapCollabRef(repo, ref, oid, null);
}

export async function releaseCollabRef(
  repo: string,
  ownership: { readonly ref: string; readonly oid: string; readonly released: boolean },
) {
  if (!ownership.released) return false;
  await validateCollabRef(repo, ownership.ref);
  const current = await readCollabRef(repo, ownership.ref);
  if (current === null) return false;
  if (current !== ownership.oid) throw gitError("Collaboration ref ownership is stale.");
  await git(repo, [
    "-c",
    "core.logAllRefUpdates=false",
    "update-ref",
    "--no-deref",
    "-d",
    ownership.ref,
    assertOid(ownership.oid),
  ]);
  return true;
}

export async function captureWorkspaceSnapshot(path: string, parentOid?: string) {
  const repository = await requireRepository(path);
  const { canonicalTargetWorktree: root, headOid } = repository;
  const parent = parentOid === undefined ? headOid : await requireCommit(root, parentOid);
  const { treeOid } = await captureTree(repository);
  return { repository, treeOid, commitOid: await commitTree(root, treeOid, parent ?? undefined) };
}

export async function initializeCollabPlan(repo: string, planId: string) {
  const refs = planRefs(planId);
  const binding = await requireRepository(repo);
  const root = binding.canonicalTargetWorktree;
  const existing = await readCollabRef(root, refs.base);
  if (existing) {
    if (!(await readCollabRef(root, refs.integration)))
      throw gitError("The plan has a base but no integration reference.");
    return { repository: binding, commitOid: existing, treeOid: await resolveTree(root, existing) };
  }
  const snapshot = await captureWorkspaceSnapshot(root);
  const input = `start\noption no-deref\ncreate ${refs.base} ${snapshot.commitOid}\noption no-deref\ncreate ${refs.integration} ${snapshot.commitOid}\nprepare\ncommit\n`;
  await git(root, ["-c", "core.logAllRefUpdates=false", "update-ref", "--stdin"], { input });
  return snapshot;
}

export async function freezeStepBase(
  repo: string,
  planId: string,
  stepId: string,
  attempt: number,
  oid: string,
) {
  await freezeRef(repo, stepRefs(planId, stepId, attempt).base, oid);
}

export async function freezeDelivery(
  repo: string,
  planId: string,
  oid: string,
  previousOid: string | null = null,
) {
  const { delivery } = planRefs(planId);
  if ((await readCollabRef(repo, delivery)) === oid) return;
  await compareAndSwapCollabRef(repo, delivery, oid, previousOid);
}

export interface ManagedCollabWorktree extends GitBinding {
  readonly path: string;
  readonly gitDir: string;
}

export async function createManagedWorktree(
  repo: string,
  managedRoot: string,
  commitOid: string,
  operationId = randomUUID() as string,
) {
  const source = await requireRepository(repo);
  const root = source.canonicalTargetWorktree;
  await requireCommit(root, commitOid);
  await mkdir(managedRoot, { recursive: true });
  const path = join(await realpath(managedRoot), `vela-collab-${refComponent(operationId)}`);
  const gitDirAtPath = async () =>
    decodeUtf8((await git(path, ["rev-parse", "--absolute-git-dir"])).stdout).replace(/\n$/, "");
  const readyPath = (gitDir: string) => join(gitDir, "vela-collab-worktree-ready");
  if (await statPath(path)) {
    const gitDir = await gitDirAtPath();
    const existing = {
      canonicalTargetWorktree: root,
      gitCommonDir: source.gitCommonDir,
      path,
      gitDir,
    };
    const attached = await verifyManagedWorktree(existing);
    const ready = readyPath(gitDir);
    if (await statPath(ready)) {
      if ((await readFile(ready, "utf8")) !== commitOid) {
        throw gitError("The managed worktree was allocated for a different pinned commit.");
      }
    } else {
      if (attached.headOid !== commitOid)
        throw gitError("The unfinished managed worktree has changed.");
      const entries = await treeEntries(root, commitOid, true);
      await checkTreeAttributes(root, commitOid, entries.keys());
      await applyWrites(
        attached,
        effectiveWrites(new Map(), entries).filter(({ targetNew }) => targetNew?.mode !== "160000"),
        true,
      );
      await git(path, ["read-tree", commitOid]);
      await writeFile(ready, commitOid, { flag: "wx" });
    }
    return existing;
  }
  await git(root, ["worktree", "add", "--detach", "--no-checkout", path, commitOid]);
  try {
    const worktree = await requireRepository(path);
    const entries = await treeEntries(root, commitOid, true);
    await checkTreeAttributes(root, commitOid, entries.keys());
    await materializeTree(worktree, entries);
    await git(path, ["read-tree", commitOid]);
    const gitDir = await gitDirAtPath();
    await writeFile(readyPath(gitDir), commitOid, { flag: "wx" });
    return {
      canonicalTargetWorktree: root,
      gitCommonDir: source.gitCommonDir,
      path,
      gitDir,
    } satisfies ManagedCollabWorktree;
  } catch (error) {
    await git(root, ["worktree", "remove", "--force", path]);
    throw error;
  }
}

async function verifyManagedWorktree(worktree: ManagedCollabWorktree) {
  const bound = await requireRepository(worktree.path);
  const gitDir = decodeUtf8(
    (await git(worktree.path, ["rev-parse", "--absolute-git-dir"])).stdout,
  ).replace(/\n$/, "");
  if (
    bound.canonicalTargetWorktree !== worktree.path ||
    bound.gitCommonDir !== worktree.gitCommonDir ||
    gitDir !== worktree.gitDir ||
    gitDir === bound.gitCommonDir ||
    worktree.path === worktree.canonicalTargetWorktree
  ) {
    throw gitError("Managed worktree ownership no longer matches.");
  }
  return bound;
}

export async function releaseManagedWorktree(worktree: ManagedCollabWorktree, released: boolean) {
  if (!released) return { status: "retained" as const, path: worktree.path };
  if (!(await statPath(worktree.path))) return { status: "missing" as const, path: worktree.path };
  const binding = await verifyManagedWorktree(worktree);
  const status = await git(worktree.path, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored",
    "--ignore-submodules=none",
  ]);
  if (
    status.stdout.length ||
    (await captureTree(binding)).treeOid !==
      (await resolveTree(worktree.path, binding.headOid ?? ""))
  ) {
    return { status: "retained" as const, path: worktree.path };
  }
  await git(worktree.canonicalTargetWorktree, ["worktree", "remove", worktree.path]);
  return { status: "removed" as const, path: worktree.path };
}

// The caller first persists an integration intent and advances the integration ref via CAS.
export async function synchronizeIntegrationWorktree(
  worktree: ManagedCollabWorktree,
  previousOid: string,
  integratedOid: string,
) {
  const binding = await verifyManagedWorktree(worktree);
  const repo = worktree.path;
  if (binding.headOid !== previousOid && binding.headOid !== integratedOid) {
    throw gitError("Integration worktree HEAD does not match the stored operation.");
  }
  const [before, after, captured, head] = await Promise.all([
    treeEntries(repo, previousOid, true),
    treeEntries(repo, integratedOid, true),
    captureTree(binding),
    git(repo, ["symbolic-ref", "--quiet", "HEAD"], { allow: [1] }),
  ]);
  if (head.exitCode !== 1) throw gitError("Integration worktree must remain detached.");
  const writes = effectiveWrites(before, after);
  const allowed = new Set(writes.map(({ path }) => path));
  const unrelated = effectiveWrites(before, captured.entries).filter(
    ({ path }) => !allowed.has(path),
  );
  if (unrelated.length) throw worktreeChanged(unrelated.map(({ path }) => path));
  await applyWrites(binding, writes, true);
  await git(repo, ["read-tree", integratedOid]);
  if (binding.headOid !== integratedOid) {
    await git(repo, [
      "-c",
      "core.logAllRefUpdates=false",
      "update-ref",
      "--no-deref",
      "HEAD",
      assertOid(integratedOid),
      assertOid(previousOid),
    ]);
  }
}

interface StepCandidateInput {
  readonly repoDir: string;
  readonly planId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly stepBaseOid: string;
  readonly criteriaVersion: number;
  readonly candidate: { readonly worktreePath: string } | { readonly commitOid: string };
  readonly allowedPaths?: ReadonlyArray<string>;
  readonly allowedGlobs?: ReadonlyArray<string>;
  readonly forbiddenPaths?: ReadonlyArray<string>;
  readonly forbiddenGlobs?: ReadonlyArray<string>;
  readonly executionWorktreePath?: string;
  readonly hardGates: ReadonlyArray<string>;
  readonly reviewId?: string;
  readonly createdAt?: string;
  readonly signal?: AbortSignal;
  readonly gateTimeoutMs?: number;
}

function pathRules(patterns: ReadonlyArray<string>) {
  return patterns.map((pattern) => {
    const normalized = pattern
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (normalized === ".") return () => true;
    assertPath(normalized.replace(/[?*]/g, "_"));
    if (isInternal(normalized)) throw gitError(`Reserved collaboration path ${pattern}.`);
    if (/[?*]/.test(normalized)) {
      const regex = globToRegExp(normalized);
      return (path: string) => regex.test(path);
    }
    return (path: string) => path === normalized || path.startsWith(normalized + "/");
  });
}

export async function captureAndVerifyStepCandidate(input: StepCandidateInput) {
  const binding = await requireRepository(input.repoDir);
  const repo = binding.canonicalTargetWorktree;
  const refs = stepRefs(input.planId, input.stepId, input.attempt);
  if ((await readCollabRef(repo, refs.base)) !== input.stepBaseOid) {
    throw gitError("Step candidate must use its pinned execution base.");
  }
  let candidateCommit = await readCollabRef(repo, refs.candidate);
  if (candidateCommit === null) {
    if ("worktreePath" in input.candidate) {
      const worker = await requireRepository(input.candidate.worktreePath);
      if (worker.gitCommonDir !== binding.gitCommonDir || worker.canonicalTargetWorktree === repo) {
        throw gitError("Step candidate requires an isolated worktree of the same Git repository.");
      }
      const captured = await captureTree(worker);
      candidateCommit = await commitTree(repo, captured.treeOid, input.stepBaseOid);
    } else {
      candidateCommit = await requireCommit(repo, input.candidate.commitOid);
    }
    await freezeRef(repo, refs.candidate, candidateCommit);
  } else if ("commitOid" in input.candidate && candidateCommit !== input.candidate.commitOid) {
    throw gitError("Step attempt already has a different frozen candidate.");
  }
  const [base, candidate] = await Promise.all([
    treeEntries(repo, input.stepBaseOid, true),
    treeEntries(repo, candidateCommit, true),
  ]);
  const writes = effectiveWrites(base, candidate);
  requireStableGitlinks(writes);
  const allowed = pathRules([...(input.allowedPaths ?? []), ...(input.allowedGlobs ?? [])]);
  const forbidden = pathRules([...(input.forbiddenPaths ?? []), ...(input.forbiddenGlobs ?? [])]);
  const violations = writes
    .filter(
      ({ path }) =>
        (allowed.length > 0 && !allowed.some((matches) => matches(path))) ||
        forbidden.some((matches) => matches(path)),
    )
    .map(({ path }) => path);
  if (violations.length)
    return { status: "boundary_violation" as const, candidateCommit, violations };
  const candidateTree = await resolveTree(repo, candidateCommit);
  const gateSummary = await verifySnapshotGates(repo, candidateCommit, input.hardGates, input);
  if (!gateSummary.passed) return { status: "gate_failed" as const, candidateCommit, gateSummary };
  const changedFiles = await readSnapshotManifest(repo, input.stepBaseOid, candidateTree);
  await freezeRef(repo, refs.reviewed, candidateCommit);
  return {
    status: "verified" as const,
    candidateCommit,
    evidence: {
      reviewId:
        input.reviewId ??
        createHash("sha256")
          .update(
            JSON.stringify([
              input.planId,
              input.stepId,
              input.attempt,
              candidateCommit,
              input.criteriaVersion,
            ]),
          )
          .digest("hex"),
      stepId: input.stepId,
      attempt: input.attempt,
      stepBaseOid: input.stepBaseOid,
      reviewedOid: candidateCommit,
      criteriaVersion: input.criteriaVersion,
      gateSummary,
      changedFiles,
      createdAt: input.createdAt ?? new Date().toISOString(),
    } satisfies CollabReviewEvidence,
  };
}

export async function verifySnapshotGates(
  repo: string,
  commitOid: string,
  hardGates: ReadonlyArray<string>,
  options: {
    readonly signal?: AbortSignal;
    readonly gateTimeoutMs?: number;
    readonly executionWorktreePath?: string;
  } = {},
): Promise<CollabGateSummary> {
  const expected = await resolveTree(repo, await requireCommit(repo, commitOid));
  const controlled = await treeEntries(repo, expected, true);
  await checkTreeAttributes(repo, expected, controlled.keys());
  if (options.executionWorktreePath !== undefined) {
    const [source, worker] = await Promise.all([
      requireRepository(repo),
      requireRepository(options.executionWorktreePath),
    ]);
    const path = worker.canonicalTargetWorktree;
    if (worker.gitCommonDir !== source.gitCommonDir || path === source.canonicalTargetWorktree) {
      throw gitError("Hard gates require an isolated worktree of the same Git repository.");
    }
    const index = () => git(path, ["ls-files", "--stage", "-z"]);
    const [before, staged] = await Promise.all([captureTree(worker), index()]);
    if (before.treeOid !== expected) {
      throw gitError("Gate execution worktree does not match the frozen candidate.");
    }
    const summary = await runSnapshotGates(path, hardGates, {}, options);
    if (!summary.passed) return summary;
    const locked = await requireRepository(path);
    // Include candidate additions even when the developer never staged them.
    const [after, stagedAfter] = await Promise.all([
      captureTree(locked, false, controlled.keys()),
      index(),
    ]);
    if (
      locked.headOid !== worker.headOid ||
      !staged.stdout.equals(stagedAfter.stdout) ||
      after.treeOid !== expected
    ) {
      throw gitError("Hard gates changed the controlled snapshot or its index.");
    }
    return summary;
  }
  return withIsolatedSnapshotRepository(repo, expected, async (directory, _objects, config) => {
    await git(directory, ["update-ref", "--no-deref", "HEAD", commitOid], { env: config });
    await materializeTree(
      { canonicalTargetWorktree: directory, gitCommonDir: join(directory, ".git") },
      controlled,
    );
    const gateSummary = await runSnapshotGates(directory, hardGates, config, options);
    if (!gateSummary.passed) return gateSummary;
    // Gate-generated untracked output does not participate in the controlled tree.
    const locked = await requireRepository(directory);
    const [tree, index] = await Promise.all([
      captureTree(locked, false),
      git(directory, ["diff-index", "--cached", "--quiet", commitOid, "--"], {
        allow: [1],
        env: config,
      }),
    ]);
    if (
      locked.headOid !== commitOid ||
      index.exitCode !== 0 ||
      effectiveWrites(controlled, tree.entries).length !== 0
    ) {
      throw gitError("Hard gates changed the controlled snapshot or its index.");
    }
    return gateSummary;
  });
}

export async function integrateReviewedStep(input: {
  readonly repoDir: string;
  readonly integrationOid: string;
  readonly stepBaseOid: string;
  readonly reviewedOid: string;
}) {
  const { canonicalTargetWorktree: repo } = await requireRepository(input.repoDir);
  const snapshotTree = async (oid: string) => resolveTree(repo, await requireCommit(repo, oid));
  const [base, integration, reviewed] = await Promise.all([
    snapshotTree(input.stepBaseOid),
    snapshotTree(input.integrationOid),
    snapshotTree(input.reviewedOid),
  ]);
  const result = await mergeTrees(repo, base, integration, reviewed);
  if (result.status === "conflict") return result;
  const oid = await commitTree(repo, result.mergedTreeOid, input.integrationOid);
  return JSON.stringify(result.writes) === JSON.stringify(result.reviewedWrites)
    ? { status: "clean" as const, mergedCommitOid: oid }
    : { status: "manifest_changed" as const, mergedCandidateCommitOid: oid };
}

interface DeliveryInput {
  readonly binding: GitBinding;
  readonly planId: string;
  readonly operationId: string;
  readonly persistRecovery: (record: CollabDeliveryRecovery) => Promise<void>;
}

async function boundTarget(binding: GitBinding) {
  const actual = await requireRepository(binding.canonicalTargetWorktree);
  if (
    actual.canonicalTargetWorktree !== binding.canonicalTargetWorktree ||
    actual.gitCommonDir !== binding.gitCommonDir
  ) {
    throw gitError("Target worktree no longer matches the collaboration repository binding.");
  }
  return actual;
}

async function prepareMutation(
  input: DeliveryInput,
  baseTree: string,
  resultTree: string,
  writes: ReadonlyArray<CollabDeliveryWrite>,
  validate?: () => Promise<void>,
) {
  const repo = input.binding.canonicalTargetWorktree;
  try {
    await preflightWrites(input.binding, writes, false);
  } catch (error) {
    if (isCollabWorktreeChanged(error))
      return { status: "conflict" as const, conflictFiles: error.paths };
    throw error;
  }
  const refs = deliveryOperationRefs(input.planId, input.operationId);
  const record = {
    operationId: input.operationId,
    planId: input.planId,
    canonicalTargetWorktree: repo,
    gitCommonDir: input.binding.gitCommonDir,
    baseTree,
    resultTree,
    writes,
  } satisfies CollabDeliveryRecovery;
  await freezeRef(repo, refs.base, await commitTree(repo, baseTree));
  await freezeRef(repo, refs.result, await commitTree(repo, resultTree));
  await validate?.();
  await input.persistRecovery(record);
  await validate?.();
  await applyWrites(input.binding, writes, false);
  return { status: "written" as const };
}

export async function preflightAndApplyDelivery(
  input: DeliveryInput & {
    readonly baseOid: string;
    readonly deliveryOid: string;
    readonly expectedTargetState: string;
  },
) {
  const binding = await boundTarget(input.binding);
  const repo = binding.canonicalTargetWorktree;
  const frozen = planRefs(input.planId);
  const verifyDeliveryRef = async () => {
    if ((await readCollabRef(repo, frozen.delivery)) !== input.deliveryOid) {
      throw gitError("Delivery snapshot is stale.");
    }
  };
  await verifyDeliveryRef();
  const [base, approved, expected, target, opening] = await Promise.all([
    resolveTree(repo, input.baseOid),
    resolveTree(repo, input.deliveryOid),
    resolveTree(repo, input.expectedTargetState),
    captureTree(binding),
    readCollabRef(repo, frozen.base),
  ]);
  if (opening === null || (input.baseOid !== opening && base !== expected)) {
    throw gitError("Delivery base does not match the plan or the verified target state.");
  }
  const result = await mergeTrees(repo, base, target.treeOid, approved);
  if (result.status === "conflict") return result;
  try {
    await preflightWrites(input.binding, result.writes, false);
  } catch (error) {
    if (isCollabWorktreeChanged(error))
      return { status: "conflict" as const, conflictFiles: error.paths };
    throw error;
  }
  if (target.treeOid !== expected || result.mergedTreeOid !== approved) {
    return {
      status: "drifted_needs_reverify" as const,
      expectedTargetState: target.treeOid,
      mergedCandidateTreeOid: result.mergedTreeOid,
      mergedCandidateCommitOid: await commitTree(repo, result.mergedTreeOid, input.deliveryOid),
    };
  }
  const applied = await prepareMutation(
    input,
    target.treeOid,
    result.mergedTreeOid,
    result.writes,
    verifyDeliveryRef,
  );
  if (applied.status === "conflict") return applied;
  return {
    status: "applied" as const,
    appliedBaseTree: target.treeOid,
    appliedResultTree: result.mergedTreeOid,
  };
}

export async function reconcileInterruptedDelivery(
  binding: GitBinding,
  record: CollabDeliveryRecovery,
) {
  const actual = await boundTarget(binding);
  const repo = actual.canonicalTargetWorktree;
  if (repo !== record.canonicalTargetWorktree || actual.gitCommonDir !== record.gitCommonDir) {
    throw gitError("Delivery recovery record belongs to another worktree.");
  }
  const [before, after] = await Promise.all([
    treeEntries(repo, record.baseTree, true),
    treeEntries(repo, record.resultTree, true),
  ]);
  const expected = effectiveWrites(before, after);
  if (JSON.stringify(expected) !== JSON.stringify(record.writes)) {
    throw gitError("Delivery recovery does not match its frozen trees.");
  }
  const refs = deliveryOperationRefs(record.planId, record.operationId);
  const [base, result] = await Promise.all([
    readCollabRef(repo, refs.base),
    readCollabRef(repo, refs.result),
  ]);
  if (
    !base ||
    !result ||
    (await resolveTree(repo, base)) !== record.baseTree ||
    (await resolveTree(repo, result)) !== record.resultTree
  ) {
    throw gitError("Delivery recovery no longer matches its pinned operation snapshots.");
  }
  await applyWrites(binding, expected, true);
  return {
    status: "reconciled" as const,
    baseTree: record.baseTree,
    resultTree: record.resultTree,
  };
}

export async function revertDeliverySafely(
  input: DeliveryInput & {
    readonly appliedBaseTree: string;
    readonly appliedResultTree: string;
  },
) {
  const binding = await boundTarget(input.binding);
  const target = await captureTree(binding);
  const result = await mergeTrees(
    binding.canonicalTargetWorktree,
    input.appliedResultTree,
    target.treeOid,
    input.appliedBaseTree,
  );
  if (result.status === "conflict") return result;
  const reverted = await prepareMutation(
    input,
    target.treeOid,
    result.mergedTreeOid,
    result.writes,
  );
  if (reverted.status === "conflict") return reverted;
  return {
    status: "reverted" as const,
    revertedBaseTree: target.treeOid,
    revertedResultTree: result.mergedTreeOid,
  };
}
