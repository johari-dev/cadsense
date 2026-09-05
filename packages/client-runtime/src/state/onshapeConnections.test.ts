import {
  EnvironmentId,
  OnshapeConnectionId,
  type OnshapeConnectionListResult,
  type OnshapeConnectionSummary,
  WS_METHODS,
} from "@cadsense/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { executeAtomQuery } from "./runtime.ts";
import { createOnshapeConnectionAtoms } from "./onshapeConnections.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const SECOND_ENVIRONMENT_ID = EnvironmentId.make("environment-2");

const SUMMARY: OnshapeConnectionSummary = {
  connectionId: OnshapeConnectionId.make("00000000-0000-4000-8000-000000000001"),
  name: "Competition CAD",
  host: "https://cad.onshape.com",
  verifiedAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};
const LIST_RESULT: OnshapeConnectionListResult = {
  connections: [SUMMARY],
  catalogUpdatedAt: SUMMARY.updatedAt,
};

const CONNECTED_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

const makeHarness = Effect.fn("TestOnshapeConnectionAtoms.makeHarness")(function* (
  client: WsRpcProtocolClient,
) {
  const supervisorState = yield* SubscriptionRef.make(CONNECTED_STATE);
  const rpcSession: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: yield* SubscriptionRef.make(Option.some(rpcSession)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(supervisorState),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));

  return {
    atoms: createOnshapeConnectionAtoms(runtime),
    registry,
  };
});

describe("Onshape connection atoms", () => {
  it.effect("loads the redacted connection catalog through the environment RPC", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let listCalls = 0;
        const client = {
          [WS_METHODS.onshapeConnectionsList]: () =>
            Effect.sync((): OnshapeConnectionListResult => {
              listCalls += 1;
              return LIST_RESULT;
            }),
        } as unknown as WsRpcProtocolClient;
        const { atoms, registry } = yield* makeHarness(client);
        const result = yield* Effect.promise(() =>
          executeAtomQuery(
            registry,
            atoms.list({ environmentId: TARGET.environmentId, input: {} }),
            { reportFailure: false },
          ),
        );

        expect(result._tag).toBe("Success");
        if (result._tag === "Success") {
          expect(result.value).toEqual(LIST_RESULT);
        }
        expect(listCalls).toBe(1);
      }),
    ),
  );

  it.effect("refreshes the local catalog exactly once after a successful mutation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const refreshed = Latch.makeUnsafe();
        let listCalls = 0;
        const client = {
          [WS_METHODS.onshapeConnectionsList]: () =>
            Effect.sync(() => {
              listCalls += 1;
              if (listCalls === 2) refreshed.openUnsafe();
              return LIST_RESULT;
            }),
          [WS_METHODS.onshapeConnectionsRename]: () =>
            Effect.succeed({
              ...SUMMARY,
              name: "Renamed CAD",
              updatedAt: "2026-09-04T00:00:01.000Z",
            }),
        } as unknown as WsRpcProtocolClient;
        const { atoms, registry } = yield* makeHarness(client);
        yield* Effect.promise(() =>
          executeAtomQuery(
            registry,
            atoms.list({ environmentId: TARGET.environmentId, input: {} }),
            { reportFailure: false },
          ),
        );

        yield* Effect.promise(() =>
          atoms.rename.run(registry, {
            environmentId: TARGET.environmentId,
            input: { connectionId: SUMMARY.connectionId, name: "Renamed CAD" },
          }),
        );
        yield* refreshed.await;
        yield* Effect.yieldNow;

        expect(listCalls).toBe(2);
      }),
    ),
  );

  it.effect("serializes every connection mutation within one environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const createStarted = Latch.makeUnsafe();
        const releaseCreate = Latch.makeUnsafe();
        const order: string[] = [];
        const client = {
          [WS_METHODS.onshapeConnectionsList]: () => Effect.succeed(LIST_RESULT),
          [WS_METHODS.onshapeConnectionsCreate]: () =>
            Effect.gen(function* () {
              order.push("create:start");
              createStarted.openUnsafe();
              yield* releaseCreate.await;
              order.push("create:end");
              return SUMMARY;
            }),
          [WS_METHODS.onshapeConnectionsRename]: () =>
            Effect.sync(() => {
              order.push("rename");
              return { ...SUMMARY, name: "Renamed CAD" };
            }),
        } as unknown as WsRpcProtocolClient;
        const { atoms, registry } = yield* makeHarness(client);

        const creating = atoms.create.run(registry, {
          environmentId: TARGET.environmentId,
          input: {
            name: "Competition CAD",
            host: "https://cad.onshape.com",
            accessKeyId: "access-key",
            secretKey: "secret-key",
          },
        });
        yield* createStarted.await;
        const renaming = atoms.rename.run(registry, {
          environmentId: TARGET.environmentId,
          input: {
            connectionId: SUMMARY.connectionId,
            name: "Renamed CAD",
          },
        });

        expect(order).toEqual(["create:start"]);
        releaseCreate.openUnsafe();
        const results = yield* Effect.promise(() => Promise.all([creating, renaming]));

        expect(results.map((result) => result._tag)).toEqual(["Success", "Success"]);
        expect(order).toEqual(["create:start", "create:end", "rename"]);
      }),
    ),
  );

  it.effect("allows mutations in different environments to run concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = Latch.makeUnsafe();
        const secondStarted = Latch.makeUnsafe();
        const releaseFirst = Latch.makeUnsafe();
        const order: string[] = [];
        const client = {
          [WS_METHODS.onshapeConnectionsList]: () => Effect.succeed(LIST_RESULT),
          [WS_METHODS.onshapeConnectionsCreate]: (input: { readonly name: string }) =>
            input.name === "First CAD"
              ? Effect.gen(function* () {
                  order.push("first:start");
                  firstStarted.openUnsafe();
                  yield* releaseFirst.await;
                  order.push("first:end");
                  return SUMMARY;
                })
              : Effect.sync(() => {
                  order.push("second");
                  secondStarted.openUnsafe();
                  return SUMMARY;
                }),
        } as unknown as WsRpcProtocolClient;
        const { atoms, registry } = yield* makeHarness(client);

        const first = atoms.create.run(registry, {
          environmentId: TARGET.environmentId,
          input: {
            name: "First CAD",
            host: "cad.onshape.com",
            accessKeyId: "first-access-key",
            secretKey: "first-secret-key",
          },
        });
        yield* firstStarted.await;
        const second = atoms.create.run(registry, {
          environmentId: SECOND_ENVIRONMENT_ID,
          input: {
            name: "Second CAD",
            host: "cad.onshape.com",
            accessKeyId: "second-access-key",
            secretKey: "second-secret-key",
          },
        });
        yield* secondStarted.await;

        expect(order).toEqual(["first:start", "second"]);
        releaseFirst.openUnsafe();
        const results = yield* Effect.promise(() => Promise.all([first, second]));
        expect(results.map((result) => result._tag)).toEqual(["Success", "Success"]);
        expect(order).toEqual(["first:start", "second", "first:end"]);
      }),
    ),
  );
});
