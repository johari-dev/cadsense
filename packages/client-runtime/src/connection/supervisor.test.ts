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
import { ConnectionTransientError, type NetworkStatus, PrimaryConnectionTarget } from "./model.ts";
import { ConnectionWakeups, type ConnectionWakeup } from "./wakeups.ts";
import { make } from "./supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";

// Builds a supervisor against an in-memory driver. `initialNetwork` is what the
// browser reports at startup; push later browser events onto `network`.
const makeHarness = Effect.fnUntraced(function* (initialNetwork: NetworkStatus = "online") {
  const wakes = yield* Queue.unbounded<ConnectionWakeup>();
  const network = yield* Queue.unbounded<NetworkStatus>();
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
      status: Effect.succeed(initialNetwork),
      changes: Stream.fromQueue(network),
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
    network,
    probeStarted,
    probeResult,
    supervisor,
    counts: () => ({ connections, releases, probes }),
  };
});
const harness = makeHarness();

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

// The primary backend is a local process, so losing internet must not touch it.
it.effect("keeps a live session when the browser reports it went offline", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Queue.offer(h.network, "offline");
    yield* TestClock.adjust("100 millis");
    expect(h.counts()).toEqual({ connections: 1, releases: 0, probes: 0 });
    expect((yield* SubscriptionRef.get(h.supervisor.state)).phase).toBe("connected");
    expect(Option.isSome(yield* SubscriptionRef.get(h.supervisor.session))).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("connects when the browser already reports offline at startup", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("offline");
    expect(h.counts().connections).toBe(1);
    expect((yield* SubscriptionRef.get(h.supervisor.state)).phase).toBe("connected");
  }).pipe(Effect.scoped),
);
