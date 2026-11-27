import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as RpcSession from "../rpc/session.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  SshConnectionTarget,
  type PreparedConnection,
} from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";

const sshTarget = (connectionId: string) =>
  new SshConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Test environment",
    connectionId,
  });

const ENTRY: ConnectionCatalogEntry = {
  target: sshTarget("ssh-first"),
  profile: Option.none(),
  enabled: true,
  alternateRoutes: [{ target: sshTarget("ssh-second"), profile: Option.none() }],
};

describe("ConnectionDriver", () => {
  it.effect("reports preparing before each route it prepares", () =>
    Effect.gen(function* () {
      const stages = yield* Ref.make<ReadonlyArray<string>>([]);
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ConnectionResolver.ConnectionResolver)({
              prepare: (entry) =>
                Effect.succeed({
                  environmentId: entry.target.environmentId,
                  label: entry.target.label,
                  httpBaseUrl: "http://127.0.0.1:1",
                  socketUrl: "ws://127.0.0.1:1/ws",
                  httpAuthorization: null,
                  target: entry.target,
                } satisfies PreparedConnection),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({
              connect: () =>
                Effect.fail(
                  new ConnectionTransientError({ reason: "transport", detail: "Socket closed." }),
                ),
            }),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({}),
            // SSH routes have no HTTP check, so the driver never sends a request.
            FetchHttpClient.layer,
          ),
        ),
      );

      yield* driver
        .connect(ENTRY, (progress) => Ref.update(stages, (all) => [...all, progress.stage]))
        .pipe(Effect.scoped, Effect.flip);

      expect(yield* Ref.get(stages)).toEqual([
        "preparing",
        "preparing",
        "opening",
        "preparing",
        "opening",
      ]);
    }),
  );

  it.effect("reuses a fresh HTTPS checkHost answer on the immediately following connect", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-1");
      const httpsTarget = new BearerConnectionTarget({
        environmentId,
        label: "Funnel environment",
        connectionId: "bearer:https",
      });
      const httpsProfile = new BearerConnectionProfile({
        connectionId: httpsTarget.connectionId,
        environmentId,
        label: "Funnel environment",
        httpBaseUrl: "https://funnel.example.test/",
        wsBaseUrl: "wss://funnel.example.test/",
      });
      const secondaryTarget = new BearerConnectionTarget({
        environmentId,
        label: "Funnel environment",
        connectionId: "bearer:secondary",
      });
      const secondaryProfile = new BearerConnectionProfile({
        connectionId: secondaryTarget.connectionId,
        environmentId,
        label: "Funnel environment",
        httpBaseUrl: "http://192.168.1.10:3773/",
        wsBaseUrl: "ws://192.168.1.10:3773/",
      });
      const entry: ConnectionCatalogEntry = {
        target: httpsTarget,
        profile: Option.some(httpsProfile),
        alternateRoutes: [{ target: secondaryTarget, profile: Option.some(secondaryProfile) }],
        enabled: true,
      };
      const descriptor: ExecutionEnvironmentDescriptor = {
        environmentId,
        label: "Funnel environment",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.1.0-test",
        capabilities: { repositoryIdentity: true },
      };
      const preparedHttps: PreparedConnection = {
        environmentId,
        label: "Funnel environment",
        httpBaseUrl: httpsProfile.httpBaseUrl,
        socketUrl: "wss://funnel.example.test/ws",
        httpAuthorization: null,
        target: httpsTarget,
      };
      const httpsDescriptorCalls: Array<string> = [];
      const fetchFn: typeof fetch = (input) => {
        const url = String(input);
        if (url.startsWith("https://funnel.example.test/")) {
          httpsDescriptorCalls.push(url);
          return Promise.resolve(Response.json(descriptor));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      };

      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ConnectionResolver.ConnectionResolver)({
              prepare: (selected) =>
                Effect.succeed({
                  environmentId: selected.target.environmentId,
                  label: selected.target.label,
                  httpBaseUrl: httpsProfile.httpBaseUrl,
                  socketUrl: "wss://funnel.example.test/ws",
                  httpAuthorization: null,
                  target: selected.target,
                } satisfies PreparedConnection),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({
              connect: () =>
                Effect.succeed({
                  ready: Effect.void,
                } as unknown as RpcSession.RpcSession),
            }),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({
              rememberCheckedDescriptor: () => Effect.void,
            }),
            RpcHttp.layerRemoteHttpClient(fetchFn),
          ),
        ),
      );

      expect(yield* driver.checkHost(preparedHttps)).toBe("answered");
      expect(httpsDescriptorCalls).toHaveLength(1);

      yield* driver.connect(entry, () => Effect.void).pipe(Effect.scoped);
      expect(httpsDescriptorCalls).toHaveLength(1);

      yield* driver.connect(entry, () => Effect.void).pipe(Effect.scoped);
      expect(httpsDescriptorCalls).toHaveLength(2);
    }),
  );
});
