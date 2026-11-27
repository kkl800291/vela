import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  LEGACY_T3_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_NAME,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";

const decodeT3ProjectFileJson = Schema.decodeEffect(T3ProjectFileFromJson);

export class T3ProjectFileLoadError extends Schema.TaggedError<T3ProjectFileLoadError>()(
  "T3ProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const fileName = this.filePath.split(/[\\/]/).pop() ?? "project file";
    return `Failed to ${this.operation} ${fileName} at ${this.filePath}.`;
  }
}

export interface T3ProjectFileSource {
  readonly filePath: string;
  readonly fileName: string;
  readonly content: string;
}

const readNamedProjectFile = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  workspaceRoot: string,
  fileName: string,
) => {
  const filePath = path.join(workspaceRoot, fileName);
  return fileSystem.readFileString(filePath).pipe(
    Effect.map(
      (content): Option.Option<T3ProjectFileSource> => Option.some({ filePath, fileName, content }),
    ),
    Effect.catchTags({
      PlatformError: (error) => {
        const readError = () =>
          Effect.fail(
            new T3ProjectFileLoadError({
              operation: "read",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          );
        if (error.reason._tag !== "NotFound") {
          return readError();
        }
        // A dangling symlink raises ENOENT on read but still exists at filePath; do not fall back to t3.json.
        return fileSystem.readLink(filePath).pipe(
          Effect.matchEffect({
            onSuccess: () => readError(),
            onFailure: () => Effect.succeed(Option.none<T3ProjectFileSource>()),
          }),
        );
      },
    }),
  );
};

/**
 * Reads `vela.json`, or `t3.json` only when `vela.json` is missing.
 * A present `vela.json` is never replaced by `t3.json`, including when it is empty or invalid.
 * Fails when the chosen file exists but cannot be read. Returns none when neither file is present.
 */
export const readT3ProjectFile = (
  workspaceRoot: string,
): Effect.Effect<
  Option.Option<T3ProjectFileSource>,
  T3ProjectFileLoadError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const primary = yield* readNamedProjectFile(
      fileSystem,
      path,
      workspaceRoot,
      T3_PROJECT_FILE_NAME,
    );
    if (Option.isSome(primary)) {
      return primary;
    }
    return yield* readNamedProjectFile(
      fileSystem,
      path,
      workspaceRoot,
      LEGACY_T3_PROJECT_FILE_NAME,
    );
  });

export class T3ProjectFileLoader extends Context.Service<
  T3ProjectFileLoader,
  {
    /** Never fails; missing/unreadable/invalid files return none, with warnings for invalid files. */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<T3ProjectFile>>;
  }
>()("t3/project/T3ProjectFileLoader") {}

const logT3ProjectFileLoadError = (error: T3ProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: T3ProjectFileLoader["Service"]["load"] = Effect.fn("T3ProjectFileLoader.load")(
    function* (workspaceRoot) {
      const raw = yield* readT3ProjectFile(workspaceRoot).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catchTag("T3ProjectFileLoadError", (error) =>
          logT3ProjectFileLoadError(error).pipe(Effect.as(Option.none<T3ProjectFileSource>())),
        ),
      );
      if (Option.isNone(raw)) {
        return Option.none<T3ProjectFile>();
      }
      return yield* decodeT3ProjectFileJson(raw.value.content).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) =>
            logT3ProjectFileLoadError(
              new T3ProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                filePath: raw.value.filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<T3ProjectFile>())),
        }),
      );
    },
  );

  return T3ProjectFileLoader.of({ load });
});

export const layer = Layer.effect(T3ProjectFileLoader, make);
