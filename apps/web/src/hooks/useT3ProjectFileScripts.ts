import {
  LEGACY_T3_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

export interface T3ProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  fileName: string | null;
  file: T3ProjectFile | null;
  scripts: ReadonlyArray<T3ProjectFileScript>;
  refresh: () => void;
}

export function useT3ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): T3ProjectFileState {
  const primaryQuery = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    T3_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const primaryContents =
    primaryQuery.data && !primaryQuery.data.truncated ? primaryQuery.data.contents : null;
  const shouldCheckLegacy = cwd !== null && !primaryQuery.isPending && primaryContents === null;
  const legacyQuery = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    LEGACY_T3_PROJECT_FILE_NAME,
    shouldCheckLegacy,
  );
  const legacyContents =
    shouldCheckLegacy && legacyQuery.data && !legacyQuery.data.truncated
      ? legacyQuery.data.contents
      : null;

  const isPending = primaryQuery.isPending || (shouldCheckLegacy && legacyQuery.isPending);
  const contents = primaryContents ?? legacyContents;
  const fileName =
    primaryContents !== null
      ? T3_PROJECT_FILE_NAME
      : legacyContents !== null
        ? LEGACY_T3_PROJECT_FILE_NAME
        : null;
  const refresh = () => {
    primaryQuery.refresh();
    if (shouldCheckLegacy) {
      legacyQuery.refresh();
    }
  };

  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      fileName: null,
      file: null,
      scripts: NO_SCRIPTS,
      refresh,
    } as const;
  }
  const file = parseT3ProjectFile(contents);
  if (file === null) {
    return { status: "invalid", fileName, file: null, scripts: NO_SCRIPTS, refresh } as const;
  }
  return { status: "valid", fileName, file, scripts: file.scripts ?? NO_SCRIPTS, refresh } as const;
}

export function useT3ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T3ProjectFileScript> {
  return useT3ProjectFileState(environmentId, cwd).scripts;
}
