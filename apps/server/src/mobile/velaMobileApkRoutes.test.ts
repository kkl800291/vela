// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { afterEach, describe } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { layer as apkRoutesLayer, resolveMobileApkPath } from "./velaMobileApkRoutes.ts";

const platformLayer = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));

describe("velaMobileApkRoutes", () => {
  const originalEnv = process.env.VELA_MOBILE_APK_PATH;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VELA_MOBILE_APK_PATH;
    } else {
      process.env.VELA_MOBILE_APK_PATH = originalEnv;
    }
  });

  it("resolves explicit VELA_MOBILE_APK_PATH when present", () => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "vela-apk-test-"));
    try {
      const apkPath = NodePath.join(dir, "Vela-2.3.0-android-arm64.apk");
      NodeFs.writeFileSync(apkPath, "fake-apk-bytes");
      process.env.VELA_MOBILE_APK_PATH = apkPath;
      expect(resolveMobileApkPath()).toBe(apkPath);
    } finally {
      NodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.effect("issues path-based APK download tickets and serves GET/HEAD requests", () => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "vela-apk-route-"));
    const apkPath = NodePath.join(dir, "Vela-2.3.0-android-arm64.apk");
    const payload = Buffer.from("fake-android-apk-archive-payload");
    NodeFs.writeFileSync(apkPath, payload);
    process.env.VELA_MOBILE_APK_PATH = apkPath;

    return Effect.gen(function* () {
      const authLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
        authenticateHttpRequest: () =>
          Effect.succeed({
            sessionId: AuthSessionId.make("apk-test-session"),
            subject: "apk-test",
            method: "bearer-access-token",
            scopes: [AuthOrchestrationReadScope],
          }),
      });

      const { handler } = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            apkRoutesLayer.pipe(Layer.provide(platformLayer), Layer.provideMerge(authLayer)),
            { disableLogger: true },
          ),
        ),
        ({ dispose }) => Effect.promise(dispose),
      );

      const ticketRes = yield* Effect.promise(() =>
        handler(new Request("http://vela.test/api/vela/mobile/apk/ticket", { method: "POST" })),
      );
      expect(ticketRes.status).toBe(200);
      const ticketBody = (yield* Effect.promise(() => ticketRes.json())) as {
        downloadPath: string;
        fileName: string;
        sizeBytes: number;
      };
      expect(ticketBody.downloadPath.startsWith("/api/vela/mobile/apk/download/")).toBe(true);
      expect(ticketBody.downloadPath.includes("?")).toBe(false);
      expect(ticketBody.downloadPath.endsWith(".apk")).toBe(true);
      expect(ticketBody.sizeBytes).toBe(payload.byteLength);

      const headRes = yield* Effect.promise(() =>
        handler(new Request(`http://vela.test${ticketBody.downloadPath}`, { method: "HEAD" })),
      );
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("content-type")).toBe("application/vnd.android.package-archive");
      expect(headRes.headers.get("content-length")).toBe(String(payload.byteLength));
      expect(yield* Effect.promise(() => headRes.text())).toBe("");

      const getRes = yield* Effect.promise(() =>
        handler(new Request(`http://vela.test${ticketBody.downloadPath}`, { method: "GET" })),
      );
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("content-type")).toBe("application/vnd.android.package-archive");
      expect(Buffer.from(yield* Effect.promise(() => getRes.arrayBuffer()))).toEqual(payload);

      const token = ticketBody.downloadPath
        .slice("/api/vela/mobile/apk/download/".length)
        .split("/")[0]!;
      const legacyQueryRes = yield* Effect.promise(() =>
        handler(
          new Request(
            `http://vela.test/api/vela/mobile/apk/download?ticket=${encodeURIComponent(token)}`,
            { method: "GET" },
          ),
        ),
      );
      expect(legacyQueryRes.status).toBe(200);
      expect(Buffer.from(yield* Effect.promise(() => legacyQueryRes.arrayBuffer()))).toEqual(
        payload,
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          NodeFs.rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});
