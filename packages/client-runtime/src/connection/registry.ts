import { EnvironmentId } from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Persistence from "../platform/persistence.ts";
import type { ConnectionCatalogEntry, PlatformConnectionRegistration } from "./catalog.ts";
import { connectionRegistrationCatalogEntry } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import type { NetworkStatus, SupervisorConnectionState } from "./model.ts";
import * as ConnectionDriver from "./driver.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

export class EnvironmentNotRegisteredError extends Schema.TaggedErrorClass<EnvironmentNotRegisteredError>()(
  "EnvironmentNotRegisteredError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is not registered.`;
  }
}

export class EnvironmentRegistry extends Context.Service<
  EnvironmentRegistry,
  {
    readonly entries: SubscriptionRef.SubscriptionRef<
      ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
    >;
    readonly networkStatus: SubscriptionRef.SubscriptionRef<NetworkStatus>;
    readonly start: Effect.Effect<void>;
    readonly reconcilePlatform: (
      registrations: ReadonlyArray<PlatformConnectionRegistration>,
    ) => Effect.Effect<void>;
    readonly retryNow: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly state: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<SupervisorConnectionState, EnvironmentNotRegisteredError>;
    readonly stateChanges: (
      environmentId: EnvironmentId,
    ) => Stream.Stream<SupervisorConnectionState, EnvironmentNotRegisteredError>;
    readonly run: <A, E, R>(
      environmentId: EnvironmentId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | EnvironmentNotRegisteredError,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
    readonly runStream: <A, E, R>(
      environmentId: EnvironmentId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<
      A,
      E | EnvironmentNotRegisteredError,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
    readonly followStream: <A, E, R>(
      environmentId: EnvironmentId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<A, E, Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>>;
  }
>()("@cadsense/client-runtime/connection/registry/EnvironmentRegistry") {}

interface EnvironmentServiceScope {
  readonly entry: ConnectionCatalogEntry;
  readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  readonly scope: Scope.Closeable;
}

export const make = Effect.gen(function* () {
  const registryScope = yield* Scope.Scope;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const ownedDataCleanup = yield* Persistence.EnvironmentOwnedDataCleanup;
  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(),
  );
  const networkStatus = yield* SubscriptionRef.make(yield* connectivity.status);
  const serviceScopes = yield* SubscriptionRef.make<
    ReadonlyMap<EnvironmentId, EnvironmentServiceScope>
  >(new Map());
  const registryLock = yield* Semaphore.make(1);

  const getEntry = Effect.fn("EnvironmentRegistry.getEntry")(function* (
    environmentId: EnvironmentId,
  ) {
    const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
    if (entry === undefined) return yield* new EnvironmentNotRegisteredError({ environmentId });
    return entry;
  });

  const closeServiceScope = Effect.fn("EnvironmentRegistry.closeServiceScope")(function* (
    environmentId: EnvironmentId,
  ) {
    const current = yield* SubscriptionRef.get(serviceScopes);
    const lease = current.get(environmentId);
    if (lease === undefined) return;
    const next = new Map(current);
    next.delete(environmentId);
    yield* SubscriptionRef.set(serviceScopes, next);
    yield* Scope.close(lease.scope, Exit.void);
  });

  const createServiceScope = Effect.fn("EnvironmentRegistry.createServiceScope")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const scope = yield* Scope.fork(registryScope);
    const supervisor = yield* EnvironmentSupervisor.make(entry, { initiallyDesired: false }).pipe(
      Effect.provideService(Connectivity.Connectivity, connectivity),
      Effect.provideService(ConnectionDriver.ConnectionDriver, driver),
      Effect.provideService(ConnectionWakeups.ConnectionWakeups, wakeups),
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    yield* supervisor.connect;
    yield* SubscriptionRef.update(serviceScopes, (current) =>
      new Map(current).set(entry.target.environmentId, { entry, supervisor, scope }),
    );
    return supervisor;
  });

  const installEntry = Effect.fn("EnvironmentRegistry.installEntry")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const environmentId = entry.target.environmentId;
    const previous = (yield* SubscriptionRef.get(entries)).get(environmentId);
    const existing = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
    if (
      previous !== undefined &&
      existing !== undefined &&
      Equal.equals(previous, entry) &&
      Equal.equals(existing.entry, entry)
    ) {
      return;
    }
    yield* closeServiceScope(environmentId);
    yield* SubscriptionRef.update(entries, (current) => new Map(current).set(environmentId, entry));
    yield* createServiceScope(entry);
  });

  const acquireSupervisor = Effect.fn("EnvironmentRegistry.acquireSupervisor")(function* (
    environmentId: EnvironmentId,
  ) {
    return yield* registryLock.withPermits(1)(
      Effect.gen(function* () {
        const entry = yield* getEntry(environmentId);
        const existing = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
        if (existing !== undefined && Equal.equals(existing.entry, entry)) {
          return existing.supervisor;
        }
        if (existing !== undefined) yield* closeServiceScope(environmentId);
        return yield* createServiceScope(entry);
      }),
    );
  });

  const reconcilePlatform = Effect.fn("EnvironmentRegistry.reconcilePlatform")(function* (
    registrations: ReadonlyArray<PlatformConnectionRegistration>,
  ) {
    yield* registryLock.withPermits(1)(
      Effect.gen(function* () {
        const desired = new Map(
          registrations.map((registration) => {
            const entry = connectionRegistrationCatalogEntry(registration);
            return [entry.target.environmentId, entry] as const;
          }),
        );
        const current = yield* SubscriptionRef.get(entries);
        for (const environmentId of current.keys()) {
          if (desired.has(environmentId)) continue;
          yield* closeServiceScope(environmentId);
          yield* SubscriptionRef.update(entries, (value) => {
            const next = new Map(value);
            next.delete(environmentId);
            return next;
          });
          yield* cache.clear(environmentId).pipe(Effect.ignore);
          yield* ownedDataCleanup.clear(environmentId);
        }
        yield* Effect.forEach(desired.values(), installEntry, { discard: true });
      }),
    );
  });

  const run: EnvironmentRegistry["Service"]["run"] = Effect.fn("EnvironmentRegistry.run")(
    function* <A, E, R>(environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) {
      const supervisor = yield* acquireSupervisor(environmentId);
      return yield* Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      );
    },
  );

  const runStream: EnvironmentRegistry["Service"]["runStream"] = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.unwrap(
      acquireSupervisor(environmentId).pipe(
        Effect.map((supervisor) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        ),
      ),
    );

  const followStream: EnvironmentRegistry["Service"]["followStream"] = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(entries)),
      SubscriptionRef.changes(entries),
    ).pipe(
      Stream.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.empty,
          onSome: () =>
            Stream.unwrap(
              acquireSupervisor(environmentId).pipe(
                Effect.match({
                  onFailure: () => Stream.empty,
                  onSuccess: (supervisor) =>
                    Stream.provideService(
                      stream,
                      EnvironmentSupervisor.EnvironmentSupervisor,
                      supervisor,
                    ),
                }),
              ),
            ),
        }),
      ),
    );

  const retryNow = (environmentId: EnvironmentId) =>
    acquireSupervisor(environmentId).pipe(
      Effect.flatMap((supervisor) => supervisor.retryNow),
      Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.void),
    );
  const state = Effect.fn("EnvironmentRegistry.state")(function* (environmentId: EnvironmentId) {
    return yield* SubscriptionRef.get((yield* acquireSupervisor(environmentId)).state);
  });
  const stateChanges = (environmentId: EnvironmentId) =>
    followStream(
      environmentId,
      Stream.unwrap(
        EnvironmentSupervisor.EnvironmentSupervisor.pipe(
          Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
        ),
      ),
    );

  yield* Effect.addFinalizer(() =>
    SubscriptionRef.get(serviceScopes).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(current.values(), (lease) => Scope.close(lease.scope, Exit.void), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  );
  yield* connectivity.changes.pipe(
    Stream.runForEach((status) => SubscriptionRef.set(networkStatus, status)),
    Effect.forkScoped,
  );

  return EnvironmentRegistry.of({
    entries,
    networkStatus,
    start: Effect.void,
    reconcilePlatform,
    retryNow,
    state,
    stateChanges,
    run,
    runStream,
    followStream,
  });
});

export const layer = Layer.effect(EnvironmentRegistry, make);
