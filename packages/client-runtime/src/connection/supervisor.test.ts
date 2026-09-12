import { EnvironmentId } from "@cadsense/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { Connectivity } from "./connectivity.ts";
import { ConnectionDriver } from "./driver.ts";
import { ConnectionTransientError, PrimaryConnectionTarget } from "./model.ts";
import { ConnectionWakeups, type ConnectionWakeup } from "./wakeups.ts";
import { make } from "./supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";

const harness = Effect.gen(function* () {
  const wakes = yield* Queue.unbounded<ConnectionWakeup>();
  const probeStarted = yield* Deferred.make<void>();
  const probeResult = yield* Deferred.make<void, ConnectionTransientError>();
  let connections = 0,
    releases = 0,
    probes = 0;
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("test"),
    label: "CAD test",
    httpBaseUrl: "http://localhost",
    wsBaseUrl: "ws://localhost",
  });
  const session: RpcSession = {
    client: {} as RpcSession["client"],
    initialConfig: Effect.die("Unused initial configuration in the connection driver fixture"),
    ready: Effect.void,
    closed: Effect.never,
    probe: Effect.gen(function* () {
      probes++;
      yield* Deferred.succeed(probeStarted, undefined);
      yield* Deferred.await(probeResult);
    }),
  };
  const supervisor = yield* make(
    { target, profile: Option.none() },
    { initiallyDesired: true },
  ).pipe(
    Effect.provideService(Connectivity, {
      status: Effect.succeed("online" as const),
      changes: Stream.never,
    }),
    Effect.provideService(ConnectionWakeups, { changes: Stream.fromQueue(wakes) }),
    Effect.provideService(ConnectionDriver, {
      connect: () =>
        Effect.gen(function* () {
          connections++;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              releases++;
            }),
          );
          return {
            session,
            prepared: {
              environmentId: target.environmentId,
              label: target.label,
              target,
              httpBaseUrl: target.httpBaseUrl,
              socketUrl: target.wsBaseUrl,
              httpAuthorization: null,
            },
          };
        }),
    }),
  );
  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.filter((state) => state.phase === "connected"),
    Stream.runHead,
  );
  return {
    wakes,
    probeStarted,
    probeResult,
    supervisor,
    counts: () => ({ connections, releases, probes }),
  };
});

it.effect("coalesces foreground notifications while a connection probe is pending", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Queue.offer(h.wakes, "application-active");
    yield* Deferred.await(h.probeStarted);
    yield* Queue.offer(h.wakes, "application-active");
    yield* Queue.offer(h.wakes, "application-active");
    yield* TestClock.adjust("100 millis");
    expect(h.counts()).toEqual({ connections: 1, releases: 0, probes: 1 });
    yield* Deferred.succeed(h.probeResult, undefined);
    yield* TestClock.adjust("100 millis");
    expect(h.counts()).toEqual({ connections: 1, releases: 0, probes: 1 });
    expect((yield* SubscriptionRef.get(h.supervisor.state)).phase).toBe("connected");
  }).pipe(Effect.scoped),
);

it.effect("still reconnects when the coalesced foreground probe fails", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Queue.offer(h.wakes, "application-active");
    yield* Deferred.await(h.probeStarted);
    yield* Queue.offer(h.wakes, "application-active");
    yield* TestClock.adjust("100 millis");
    yield* Deferred.fail(
      h.probeResult,
      new ConnectionTransientError({ reason: "transport", detail: "Disconnected" }),
    );
    yield* TestClock.adjust("100 millis");
    expect(h.counts().connections).toBe(2);
    expect(h.counts().releases).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("does not extend the health check timeout when foreground notifications repeat", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Queue.offer(h.wakes, "application-active");
    yield* Deferred.await(h.probeStarted);
    yield* TestClock.adjust("10 seconds");
    yield* Queue.offer(h.wakes, "application-active");
    yield* TestClock.adjust("5 seconds");
    expect(h.counts()).toEqual({ connections: 2, releases: 1, probes: 1 });
  }).pipe(Effect.scoped),
);
