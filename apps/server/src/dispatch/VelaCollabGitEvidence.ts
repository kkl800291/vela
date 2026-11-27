// @effect-diagnostics nodeBuiltinImport:off
import {
  assertNoCollisions,
  assertOid,
  assertPath,
  checkTreeAttributes,
  gitError,
  commitTree,
  git,
  isInternal,
  nulFields,
  requireCommit,
  resolveTree,
  sameEntry,
  snapshotEntry,
  treeEntries,
  withIsolatedSnapshotRepository,
} from "./VelaCollabGitObjects.ts";
import type {
  CollabDeliveryWrite,
  CollabSnapshotFile,
  CollabTreeEntry,
} from "./VelaCollabTypes.ts";

export function effectiveWrites(
  before: ReadonlyMap<string, CollabTreeEntry>,
  after: ReadonlyMap<string, CollabTreeEntry>,
): ReadonlyArray<CollabDeliveryWrite> {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].sort().flatMap((path) => {
    const expectedOld = before.get(path) ?? null;
    const targetNew = after.get(path) ?? null;
    return sameEntry(expectedOld, targetNew) ? [] : [{ path, expectedOld, targetNew }];
  });
}

export function requireStableGitlinks(writes: ReadonlyArray<CollabDeliveryWrite>) {
  for (const write of writes) {
    if (write.expectedOld?.mode === "160000" || write.targetNew?.mode === "160000") {
      throw gitError(`Gitlink changes are unsupported at ${write.path}.`);
    }
  }
}

async function immutableDiff<T>(
  repo: string,
  target: string,
  use: (
    run: (
      args: ReadonlyArray<string>,
      consume?: (chunk: Buffer) => void,
      literal?: boolean,
    ) => ReturnType<typeof git>,
  ) => Promise<T>,
) {
  return withIsolatedSnapshotRepository(repo, target, (directory, _objects, config) =>
    use((args, consume, literal = true) =>
      git(
        directory,
        [
          ...(literal ? ["--literal-pathspecs"] : []),
          "diff-tree",
          "-r",
          "--no-commit-id",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          ...args,
        ],
        { env: config, ...(consume ? { consume } : {}) },
      ),
    ),
  );
}

const excludeInternal = [":(top,exclude,icase).vela", ":(top,exclude,icase).harness"];

interface Numstat {
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly oldPath?: string;
}

function parseNumstat(fields: ReadonlyArray<string>) {
  const stats = new Map<string, Numstat>();
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? "";
    const firstTab = field.indexOf("\t");
    const secondTab = field.indexOf("\t", firstTab + 1);
    const additions = field.slice(0, firstTab);
    const deletions = field.slice(firstTab + 1, secondTab);
    let path = field.slice(secondTab + 1);
    let oldPath: string | undefined;
    if (!path) {
      oldPath = fields[++index];
      path = fields[++index] ?? "";
      if (oldPath === undefined || !path) throw gitError("Invalid Git rename statistics.");
    }
    if (isInternal(path) || (oldPath !== undefined && isInternal(oldPath))) continue;
    if (
      firstTab < 0 ||
      secondTab < 0 ||
      !/^(?:\d+|-)$/.test(additions) ||
      !/^(?:\d+|-)$/.test(deletions)
    ) {
      throw gitError("Invalid Git diff statistics.");
    }
    stats.set(path, {
      additions: additions === "-" ? null : Number(additions),
      deletions: deletions === "-" ? null : Number(deletions),
      ...(oldPath === undefined ? {} : { oldPath }),
    });
  }
  return stats;
}

async function objectSizes(repo: string, oids: ReadonlyArray<string>) {
  if (oids.length === 0) return new Map<string, number>();
  const { stdout } = await git(
    repo,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { input: oids.join("\n") + "\n" },
  );
  const sizes = new Map<string, number>();
  for (const line of stdout.toString("ascii").trimEnd().split("\n")) {
    const [oid, type, size] = line.split(" ");
    if (type !== "blob" || !size || !/^\d+$/.test(size)) {
      throw gitError(`Snapshot blob ${oid} is missing or invalid.`);
    }
    sizes.set(assertOid(oid ?? ""), Number(size));
  }
  return sizes;
}

export async function readSnapshotManifest(
  repo: string,
  baseOid: string,
  targetOid: string,
): Promise<ReadonlyArray<CollabSnapshotFile>> {
  const [base, target] = await Promise.all([
    resolveTree(repo, baseOid),
    resolveTree(repo, targetOid),
  ]);
  const [before, after] = await Promise.all([treeEntries(repo, base), treeEntries(repo, target)]);
  const writes = effectiveWrites(before, after);
  if (!writes.length) return [];
  const sizes = await objectSizes(repo, [
    ...new Set(
      writes.flatMap(({ expectedOld, targetNew }) => {
        const entry = targetNew ?? expectedOld;
        return !entry || entry.mode === "160000" ? [] : [entry.oid];
      }),
    ),
  ]);
  const stats = await immutableDiff(repo, target, async (run) =>
    parseNumstat(
      nulFields(
        (
          await run(
            ["--numstat", "-z", "--find-renames", base, target, "--", ...excludeInternal],
            undefined,
            false,
          )
        ).stdout,
      ),
    ),
  );
  const result: CollabSnapshotFile[] = [];
  const renamedFrom = new Set([...stats.values()].flatMap((numstat) => numstat.oldPath ?? []));
  for (const { path, expectedOld, targetNew } of writes) {
    if (renamedFrom.has(path)) continue;
    const stat = stats.get(path);
    const oldEntry = stat?.oldPath === undefined ? expectedOld : (before.get(stat.oldPath) ?? null);
    const entry = targetNew ?? expectedOld;
    const isGitlink = oldEntry?.mode === "160000" || targetNew?.mode === "160000";
    result.push({
      path,
      ...(stat?.oldPath === undefined ? {} : { oldPath: stat.oldPath }),
      status: stat?.oldPath !== undefined ? "R" : !expectedOld ? "A" : !targetNew ? "D" : "M",
      isBinary: isGitlink || stat?.additions === null,
      sizeBytes: entry ? (sizes.get(entry.oid) ?? 0) : 0,
      oldOid: oldEntry?.oid ?? null,
      newOid: targetNew?.oid ?? null,
      oldMode: oldEntry?.mode ?? null,
      newMode: targetNew?.mode ?? null,
      additions: isGitlink ? null : (stat?.additions ?? (stat ? null : 0)),
      deletions: isGitlink ? null : (stat?.deletions ?? (stat ? null : 0)),
    });
  }
  return result;
}

const MAX_EVIDENCE_BYTES = 64 * 1024;

function boundedInteger(value: number, min: number, max: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw gitError(`Invalid ${label}.`);
  }
  return value;
}

function encodePage(bytes: Buffer) {
  try {
    return {
      encoding: "utf8" as const,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  } catch {
    return { encoding: "base64" as const, dataBase64: bytes.toString("base64") };
  }
}

// Offsets and limits are measured in raw bytes, including when a page splits a UTF-8 code point.
export async function readSnapshotFileDiff(
  repo: string,
  baseOid: string,
  targetOid: string,
  filePath: string,
  options: { readonly offset?: number; readonly maxBytes?: number } = {},
) {
  assertPath(filePath);
  const offset = boundedInteger(
    options.offset ?? 0,
    0,
    Number.MAX_SAFE_INTEGER - MAX_EVIDENCE_BYTES,
    "diff offset",
  );
  const maxBytes = boundedInteger(
    options.maxBytes ?? MAX_EVIDENCE_BYTES,
    1,
    MAX_EVIDENCE_BYTES,
    "diff byte limit",
  );
  const file = (await readSnapshotManifest(repo, baseOid, targetOid)).find(
    ({ path, oldPath }) => path === filePath || oldPath === filePath,
  );
  if (!file) throw gitError(`Path ${filePath} did not change in the specified snapshots.`);
  if (file.isBinary) return { kind: "binary" as const, file };

  let seen = 0;
  const chunks: Buffer[] = [];
  const target = await resolveTree(repo, targetOid);
  await immutableDiff(repo, target, (run) =>
    run(
      [
        "--patch",
        "--no-indent-heuristic",
        "--unified=3",
        "--find-renames",
        assertOid(baseOid),
        target,
        "--",
        ...(file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]),
      ],
      (chunk) => {
        const start = Math.max(0, offset - seen);
        const end = Math.min(chunk.length, offset + maxBytes - seen);
        if (end > start) chunks.push(chunk.subarray(start, end));
        seen += chunk.length;
      },
    ),
  );
  const bytes = Buffer.concat(chunks);
  return {
    kind: "patch" as const,
    file,
    offset,
    byteLength: bytes.length,
    nextOffset: seen > offset + bytes.length ? offset + bytes.length : null,
    ...encodePage(bytes),
  };
}

export async function readSnapshotFileLines(
  repo: string,
  commitOid: string,
  filePath: string,
  options: {
    readonly startLine?: number;
    readonly endLine?: number;
    readonly maxBytes?: number;
  } = {},
) {
  assertPath(filePath);
  const startLine = boundedInteger(
    options.startLine ?? 1,
    1,
    Number.MAX_SAFE_INTEGER,
    "start line",
  );
  const endLine = boundedInteger(
    options.endLine ?? Number.MAX_SAFE_INTEGER,
    startLine,
    Number.MAX_SAFE_INTEGER,
    "end line",
  );
  const maxBytes = boundedInteger(
    options.maxBytes ?? MAX_EVIDENCE_BYTES,
    1,
    MAX_EVIDENCE_BYTES,
    "line byte limit",
  );
  const entry = await snapshotEntry(repo, await requireCommit(repo, commitOid), filePath);
  if (!entry || entry.mode === "160000") throw gitError(`No snapshot blob at ${filePath}.`);
  const chunks: Buffer[] = [];
  let line = 1;
  let length = 0;
  let truncated = false;
  let binary = false;
  let inspected = 0;
  await git(repo, ["cat-file", "blob", entry.oid], {
    consume: (chunk) => {
      if (inspected < 8000) {
        binary ||= chunk.subarray(0, 8000 - inspected).includes(0);
        inspected += chunk.length;
      }
      if (binary || (length === maxBytes && truncated) || line > endLine) return;
      let start = 0;
      while (start < chunk.length && line <= endLine) {
        const nextNewline = chunk.indexOf(10, start);
        const end = nextNewline < 0 ? chunk.length : nextNewline + 1;
        if (line >= startLine) {
          const take = Math.min(maxBytes - length, end - start);
          if (take > 0) chunks.push(chunk.subarray(start, start + take));
          length += take;
          if (take < end - start) {
            truncated = true;
            break;
          }
        }
        if (nextNewline >= 0) line++;
        start = end;
      }
    },
  });
  if (binary) return { kind: "binary" as const, entry };
  return {
    kind: "lines" as const,
    entry,
    startLine,
    endLine,
    byteLength: length,
    truncated,
    ...encodePage(Buffer.concat(chunks)),
  };
}

export async function mergeTrees(repo: string, base: string, left: string, right: string) {
  const [before, ours, theirs] = await Promise.all([
    treeEntries(repo, base, true),
    treeEntries(repo, left, true),
    treeEntries(repo, right, true),
  ]);
  const leftWrites = effectiveWrites(before, ours);
  const rightWrites = effectiveWrites(before, theirs);
  requireStableGitlinks(leftWrites);
  requireStableGitlinks(rightWrites);
  const paths = new Set([...leftWrites, ...rightWrites].map(({ path }) => path));
  for (const tree of new Set([base, left, right])) await checkTreeAttributes(repo, tree, paths);
  const defaultDriver = await git(repo, ["config", "--get", "merge.default"], { allow: [1] });
  if (defaultDriver.exitCode === 0 && defaultDriver.stdout.toString().trim() !== "text") {
    throw gitError("Custom default Git merge drivers are unsupported.");
  }

  const ourPaths = new Set(leftWrites.map(({ path }) => path));
  const overlap = rightWrites.filter(({ path }) => ourPaths.has(path));
  const binary = new Set<string>();
  if (overlap.length) {
    for (const tree of new Set([left, right])) {
      const stats = await immutableDiff(repo, tree, async (run) =>
        parseNumstat(
          nulFields(
            (
              await run([
                "--numstat",
                "-z",
                "--no-renames",
                base,
                tree,
                "--",
                ...overlap.map(({ path }) => path),
              ])
            ).stdout,
          ),
        ),
      );
      for (const { path } of overlap) if (stats.get(path)?.additions === null) binary.add(path);
    }
  }

  const parent = await commitTree(repo, base);
  const [oursCommit, theirsCommit] = await Promise.all([
    commitTree(repo, left, parent),
    commitTree(repo, right, parent),
  ]);
  const result = await withIsolatedSnapshotRepository(repo, left, (directory, objects, config) =>
    git(
      directory,
      [
        "merge-tree",
        "--write-tree",
        "--no-messages",
        "-z",
        "--name-only",
        oursCommit,
        theirsCommit,
      ],
      {
        allow: [1],
        env: { ...config, GIT_OBJECT_DIRECTORY: objects },
      },
    ),
  );
  const [treeOid, ...conflicts] = nulFields(result.stdout);
  for (const path of [...conflicts, ...binary]) assertPath(path);
  if (result.exitCode === 1 || binary.size) {
    // Older Git can report directory-rename conflicts without per-file stages.
    const reported = result.exitCode === 1 && conflicts.length === 0 ? [...paths] : conflicts;
    return {
      status: "conflict" as const,
      conflictFiles: [...new Set([...reported, ...binary])].sort(),
    };
  }
  const mergedTreeOid = assertOid(treeOid ?? "");
  const merged = await treeEntries(repo, mergedTreeOid, true);
  assertNoCollisions(merged.keys());
  await checkTreeAttributes(repo, mergedTreeOid, merged.keys());
  const writes = effectiveWrites(ours, merged);
  requireStableGitlinks(writes);
  return { status: "merged" as const, mergedTreeOid, writes, reviewedWrites: rightWrites };
}
