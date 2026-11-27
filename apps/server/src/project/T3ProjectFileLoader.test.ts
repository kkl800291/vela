import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (
  cwd: string,
  contents: string,
  fileName = "t3.json",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, fileName), contents).pipe(Effect.orDie);
});

it.layer(layerTest)("T3ProjectFileLoader", (it) => {
  describe("load", () => {
    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("prefers vela.json and falls back to t3.json only when vela.json is absent", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;

        yield* writeProjectFile(cwd, JSON.stringify({ ignoreRepositories: ["from-t3"] }));
        const legacy = yield* loader.load(cwd);
        expect(Option.isSome(legacy) && legacy.value.ignoreRepositories).toEqual(["from-t3"]);

        yield* writeProjectFile(
          cwd,
          JSON.stringify({ ignoreRepositories: ["from-vela"] }),
          "vela.json",
        );
        const primary = yield* loader.load(cwd);
        expect(Option.isSome(primary) && primary.value.ignoreRepositories).toEqual(["from-vela"]);

        yield* writeProjectFile(cwd, "{}", "vela.json");
        const empty = yield* loader.load(cwd);
        expect(Option.isSome(empty) && empty.value.ignoreRepositories).toBeUndefined();

        yield* writeProjectFile(cwd, "{ not json", "vela.json");
        const invalid = yield* loader.load(cwd);
        expect(Option.isNone(invalid)).toBe(true);
      }),
    );

    it.effect("does not fall back to t3.json when vela.json is a dangling symlink", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        yield* writeProjectFile(cwd, JSON.stringify({ ignoreRepositories: ["from-t3"] }));
        yield* fileSystem.symlink(
          path.join(cwd, "missing-target.json"),
          path.join(cwd, "vela.json"),
        );

        const readResult = yield* T3ProjectFileLoader.readT3ProjectFile(cwd).pipe(Effect.flip);
        expect(readResult._tag).toBe("T3ProjectFileLoadError");
        expect(readResult.operation).toBe("read");

        const loaded = yield* loader.load(cwd);
        expect(Option.isNone(loaded)).toBe(true);
      }),
    );
  });
});
