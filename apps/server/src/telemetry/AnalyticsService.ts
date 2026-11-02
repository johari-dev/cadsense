/**
 * Anonymous PostHog usage analytics.
 *
 * Call sites increment typed daily counters (see AnalyticsEvents.ts). The service keeps today's
 * counts, turns them into a few events, and sends those in batches keyed by the anonymous
 * installation id from Identify.ts. It also sends a few of the server's error logs a day to
 * PostHog error tracking (see ErrorReports.ts). Counts, reached milestones, and unsent events persist in
 * `analytics-state.json` in the state directory, so a restart or a day offline loses nothing.
 *
 * Events are sent only when all three hold:
 *
 * - a PostHog key is configured: baked into release bundles (see `__CADSENSE_POSTHOG_KEY__` in
 *   apps/server/vite.config.ts) or set with `CADSENSE_POSTHOG_KEY`. Dev runs and tests have none,
 *   so they count and send nothing;
 * - `CADSENSE_TELEMETRY_ENABLED` isn't false;
 * - the user's `enableUsageAnalytics` setting is on. Turning it off drops all counts and unsent
 *   events and deletes the installation id.
 *
 * @module AnalyticsService
 */
import { HostProcessArchitecture, HostProcessPlatform } from "@cadsense/shared/hostProcess";
import type { ClientOs } from "@cadsense/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  AnalyticsDay,
  AnalyticsEvent,
  DAILY_COUNTERS,
  type DailyCounter,
  type FeedbackNote,
  MILESTONE_BY_COUNTER,
  Milestone,
} from "./AnalyticsEvents.ts";
import { takeReports } from "./ErrorReports.ts";
import { forgetTelemetryIdentity, getTelemetryIdentifier } from "./Identify.ts";

// Replaced with the release build's CADSENSE_POSTHOG_KEY when the server is bundled. Unbundled
// runs (dev, tests) leave it undeclared, which `typeof` reads as "undefined" without throwing.
declare const __CADSENSE_POSTHOG_KEY__: string | undefined;
const BUNDLED_POSTHOG_KEY =
  typeof __CADSENSE_POSTHOG_KEY__ === "string" && __CADSENSE_POSTHOG_KEY__ !== ""
    ? __CADSENSE_POSTHOG_KEY__
    : undefined;

/** Bump when an event's meaning changes, so dashboards can tell old data from new. */
const ANALYTICS_SCHEMA_VERSION = 1;
const STATE_FILE_NAME = "analytics-state.json";
/** Unsent events kept across restarts; the oldest are dropped when an install stays offline. */
const MAX_PENDING_EVENTS = 200;
/** How often counts are written to disk while they change. Shutdown always writes. */
const PERSIST_INTERVAL_MS = 10_000;
/** After a failed send, wait this long before trying again. */
const SEND_RETRY_DELAY_MS = 60_000;
/**
 * Distinct error reports sent per install per UTC day. Repeats of a sent failure are dropped.
 * Worst case 3 per active install a day; PostHog's free plan drops anything past its quota.
 */
const MAX_ERROR_REPORTS_PER_DAY = 3;

const TelemetryEnvConfig = Config.all({
  posthogKey: Config.string("CADSENSE_POSTHOG_KEY").pipe(Config.option),
  posthogHost: Config.string("CADSENSE_POSTHOG_HOST").pipe(
    Config.withDefault("https://us.i.posthog.com"),
  ),
  enabled: Config.boolean("CADSENSE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  flushBatchSize: Config.number("CADSENSE_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  wslDistroName: Config.string("WSL_DISTRO_NAME").pipe(Config.option),
});

const PendingEvent = Schema.Struct({
  /**
   * Sent as PostHog's `uuid`, so a batch retried after a lost response isn't counted twice.
   * Assigned by the tick that queues the event.
   */
  uuid: Schema.String,
  capturedAt: Schema.String,
  payload: AnalyticsEvent,
});
type PendingEvent = typeof PendingEvent.Type;

const Counts = Schema.Record(Schema.String, Schema.Number);

const AnalyticsState = Schema.Struct({
  version: Schema.Literal(1),
  /** The UTC day `counts` belong to; null before anything was counted. */
  day: Schema.NullOr(AnalyticsDay),
  // Stored loosely so a counter removed in a later version doesn't discard the whole file.
  counts: Counts,
  /** Whether `app.active` was already queued for `day`. */
  activeSent: Schema.Boolean,
  /** Fingerprints of the error reports queued on `day`, so a restart doesn't send them again. */
  reportedErrors: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Finished days whose counts still need a `usage.daily` event. */
  finished: Schema.Array(Schema.Struct({ day: AnalyticsDay, counts: Counts })),
  /** Milestones already queued or sent. Each is sent once per installation. */
  milestones: Schema.Array(Milestone),
  /** Events waiting to be sent, oldest first. Only the tick changes this. */
  pending: Schema.Array(PendingEvent),
});
type AnalyticsState = typeof AnalyticsState.Type;

const EMPTY_STATE: AnalyticsState = {
  version: 1,
  day: null,
  counts: {},
  activeSent: false,
  reportedErrors: [],
  finished: [],
  milestones: [],
  pending: [],
};

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(AnalyticsState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(AnalyticsState));

/** Every counter, zero where nothing was counted, so dashboards can sum any of them. */
const fullCounts = (counts: AnalyticsState["counts"]): Record<DailyCounter, number> => {
  const full = {} as Record<DailyCounter, number>;
  for (const counter of DAILY_COUNTERS) full[counter] = counts[counter] ?? 0;
  return full;
};

const utcDay = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis)).slice(0, 10);

/** Starts `today` if the state still counts an earlier day, keeping that day's counts aside. */
const rollOver = (state: AnalyticsState, today: string): AnalyticsState => {
  if (state.day === today) return state;
  const finished =
    state.day !== null && Object.keys(state.counts).length > 0
      ? [...state.finished, { day: state.day, counts: state.counts }]
      : state.finished;
  return { ...state, day: today, counts: {}, activeSent: false, reportedErrors: [], finished };
};

/**
 * The events the state now calls for, and the state with them marked as queued: a `usage.daily`
 * per finished day, `app.active` once a day has counted something, and each newly reached
 * milestone (`first_launch` on the first tick ever, then those counters or `reach` reached).
 */
const dueEvents = (
  state: AnalyticsState,
  reachedDirectly: ReadonlySet<Milestone>,
): readonly [ReadonlyArray<AnalyticsEvent>, AnalyticsState] => {
  const events: AnalyticsEvent[] = state.finished.map(({ day, counts }) => ({
    event: "usage.daily",
    properties: { day, counts: fullCounts(counts) },
  }));
  const counted = state.day !== null && Object.keys(state.counts).length > 0;
  if (counted && !state.activeSent && state.day !== null) {
    events.push({ event: "app.active", properties: { day: state.day } });
  }
  const reached = new Set<Milestone>(state.milestones);
  const newMilestones: Milestone[] = [];
  const markReached = (milestone: Milestone) => {
    if (reached.has(milestone)) return;
    reached.add(milestone);
    newMilestones.push(milestone);
    events.push({ event: "milestone.reached", properties: { milestone } });
  };
  markReached("first_launch");
  for (const milestone of Milestone.literals) {
    if (reachedDirectly.has(milestone)) markReached(milestone);
  }
  for (const counter of DAILY_COUNTERS) {
    const milestone = MILESTONE_BY_COUNTER[counter];
    if (milestone !== undefined && (state.counts[counter] ?? 0) > 0) markReached(milestone);
  }
  return [
    events,
    {
      ...state,
      activeSent: state.activeSent || counted,
      finished: [],
      milestones: [...state.milestones, ...newMilestones],
    },
  ];
};

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /**
     * Adds `by` (default 1) to today's count for `counter`. The first count of a UTC day also
     * marks the install active, and a counter's first count ever may reach a milestone. Cheap
     * (memory only), so call it where the action happens, once per action.
     */
    readonly count: (counter: DailyCounter, by?: number) => Effect.Effect<void>;

    /**
     * Reaches `milestone` if it wasn't already, without counting anything, so the day isn't
     * marked active. For onboarding states no user action counts toward, such as a provider
     * that was already signed in. Cheap (memory only) and idempotent.
     */
    readonly reach: (milestone: Milestone) => Effect.Effect<void>;

    /**
     * Sends a thumbs-down note the user chose to share, on the next tick. Does nothing while
     * the user has usage analytics off.
     */
    readonly sendFeedback: (feedback: FeedbackNote) => Effect.Effect<void>;

    /** Sends everything due now. Runs every second on its own, and at shutdown. */
    readonly flush: Effect.Effect<void>;
  }
>()("@cadsense/server/telemetry/AnalyticsService") {
  /** No-op layer for callers that intentionally disable telemetry. */
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      count: () => Effect.void,
      reach: () => Effect.void,
      sendFeedback: () => Effect.void,
      flush: Effect.void,
    }),
  );
}

export function serverOsFromNodePlatform(platform: string): ClientOs {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return "other";
  }
}

export const make = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig;
  const posthogKey = Option.getOrUndefined(telemetryConfig.posthogKey) ?? BUNDLED_POSTHOG_KEY;
  if (!telemetryConfig.enabled || posthogKey === undefined || posthogKey === "") {
    return AnalyticsService.of({
      count: () => Effect.void,
      reach: () => Effect.void,
      sendFeedback: () => Effect.void,
      flush: Effect.void,
    });
  }

  const httpClient = yield* HttpClient.HttpClient;
  const serverSettings = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  // Identify.ts reads and writes the installation id file; capture what it needs now so the
  // service's own methods stay requirement-free.
  const identityServices = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Crypto.Crypto
  >();
  const statePath = path.join(stateDir, STATE_FILE_NAME);

  /**
   * The user's choice. An unreadable settings file reads as off: an explicit "off" silently
   * becoming "on" would break their stated choice, while the reverse loses a few events.
   */
  const readUserAllows = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.enableUsageAnalytics),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read server settings; not sending usage analytics.", {
        cause,
      }).pipe(Effect.as(false)),
    ),
  );

  const loaded = yield* fileSystem.readFileString(statePath).pipe(
    Effect.flatMap(decodeState),
    Effect.catch((cause) =>
      cause._tag === "PlatformError" && cause.reason._tag === "NotFound"
        ? Effect.succeed(EMPTY_STATE)
        : Effect.logWarning("Discarding unreadable usage analytics state.", { cause }).pipe(
            Effect.as(EMPTY_STATE),
          ),
    ),
  );
  const stateRef = yield* Ref.make(loaded);
  // Refreshed every tick, so `count` stays a memory-only update.
  const allowedRef = yield* Ref.make(yield* readUserAllows);
  // Whether state changed since it was last written, and when it was last written.
  const dirtyRef = yield* Ref.make(false);
  const lastPersistRef = yield* Ref.make(0);
  // The hashed installation id once loaded; null until the first send and after forgetting it.
  const identifierRef = yield* Ref.make<string | null>(null);
  // Milestones passed to `reach`. Kept in memory only: a run that ends before the next tick
  // reaches them again on the next launch.
  const reachedRef = yield* Ref.make<ReadonlySet<Milestone>>(new Set());
  // Shared notes waiting for the next tick, which is the only writer of `pending`.
  const feedbackRef = yield* Ref.make<ReadonlyArray<FeedbackNote>>([]);
  // Whether the id and state file were deleted since analytics last ran, so an opted-out
  // install deletes them once instead of on every tick.
  const forgottenRef = yield* Ref.make(false);
  // No send is tried before this time; pushed back after a failure so an offline install doesn't
  // retry every second.
  const nextSendAtRef = yield* Ref.make(0);
  // Serializes ticks (the timer and the shutdown finalizer), so a send that started before the
  // user opted out can't recreate the id they just deleted.
  const tickLock = yield* Semaphore.make(1);

  const envelope = {
    $process_person_profile: false,
    // PostHog would otherwise look up a location from the request's IP address.
    $geoip_disable: true,
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    appVersion: packageJson.version,
    channel: packageJson.version.includes("-nightly.") ? "nightly" : "latest",
    os: serverOsFromNodePlatform(hostPlatform),
    arch: hostArchitecture,
    isWsl: Option.isSome(telemetryConfig.wslDistroName),
  } as const;

  const count: AnalyticsService["Service"]["count"] = (counter, by = 1) =>
    Effect.gen(function* () {
      if (!(yield* Ref.get(allowedRef)) || by <= 0) return;
      const today = utcDay(yield* Clock.currentTimeMillis);
      yield* Ref.update(stateRef, (current) => {
        const next = rollOver(current, today);
        return { ...next, counts: { ...next.counts, [counter]: (next.counts[counter] ?? 0) + by } };
      });
      yield* Ref.set(dirtyRef, true);
    });

  const reach: AnalyticsService["Service"]["reach"] = (milestone) =>
    Effect.gen(function* () {
      if (!(yield* Ref.get(allowedRef))) return;
      yield* Ref.update(reachedRef, (reached) =>
        reached.has(milestone) ? reached : new Set([...reached, milestone]),
      );
    });

  const sendFeedback: AnalyticsService["Service"]["sendFeedback"] = (feedback) =>
    Effect.gen(function* () {
      if (!(yield* Ref.get(allowedRef))) return;
      yield* Ref.update(feedbackRef, (notes) => [...notes, feedback]);
    });

  /** Appends `payloads` to the unsent events, giving each its uuid. */
  const enqueue = (payloads: ReadonlyArray<AnalyticsEvent>, nowMillis: number) =>
    Effect.gen(function* () {
      if (payloads.length === 0) return;
      const now = DateTime.formatIso(DateTime.makeUnsafe(nowMillis));
      const queued = yield* Effect.forEach(payloads, (payload) =>
        crypto.randomUUIDv4.pipe(
          Effect.map(
            (uuid): PendingEvent => ({
              uuid,
              // A summary is stamped with the last moment of its day, so PostHog charts it on
              // that day even when it's sent days later.
              capturedAt:
                payload.event === "usage.daily" ? `${payload.properties.day}T23:59:59.999Z` : now,
              payload,
            }),
          ),
        ),
      );
      // `count` never touches `pending`, so appending here can't lose a concurrent change.
      yield* Ref.update(stateRef, (current) => {
        const pending = [...current.pending, ...queued];
        return {
          ...current,
          pending: pending.slice(Math.max(0, pending.length - MAX_PENDING_EVENTS)),
        };
      });
      yield* Ref.set(dirtyRef, true);
    });

  /** Queues whatever the state calls for (see `dueEvents`). */
  const queueDueEvents = (nowMillis: number) =>
    Effect.gen(function* () {
      const today = utcDay(nowMillis);
      const reachedDirectly = yield* Ref.get(reachedRef);
      const due = yield* Ref.modify(stateRef, (current) =>
        dueEvents(rollOver(current, today), reachedDirectly),
      );
      yield* enqueue(due, nowMillis);
    });

  /**
   * Queues the error reports ErrorReports.ts holds: each failure once a day, and at most
   * {@link MAX_ERROR_REPORTS_PER_DAY} a day.
   */
  const queueErrorReports = (nowMillis: number) =>
    Effect.gen(function* () {
      const held = takeReports();
      if (held.length === 0) return;
      const today = utcDay(nowMillis);
      const fresh = yield* Ref.modify(stateRef, (current) => {
        const state = rollOver(current, today);
        const reported = new Set(state.reportedErrors);
        const fresh: AnalyticsEvent[] = [];
        for (const { fingerprint, report } of held) {
          if (reported.size >= MAX_ERROR_REPORTS_PER_DAY) break;
          if (reported.has(fingerprint)) continue;
          reported.add(fingerprint);
          fresh.push({ event: "$exception", properties: { $exception_list: [report] } });
        }
        return [fresh, { ...state, reportedErrors: [...reported] }];
      });
      yield* enqueue(fresh, nowMillis);
    });

  const persist = Effect.gen(function* () {
    if (!(yield* Ref.get(dirtyRef))) return;
    const contents = yield* encodeState(yield* Ref.get(stateRef));
    yield* Ref.set(dirtyRef, false);
    yield* writeFileStringAtomically({ filePath: statePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catch((cause) =>
        Ref.set(dirtyRef, true).pipe(
          Effect.andThen(Effect.logWarning("Could not save usage analytics state.", { cause })),
        ),
      ),
    );
    yield* Ref.set(lastPersistRef, yield* Clock.currentTimeMillis);
  });

  /** Drops all counts and unsent events and deletes the id and state file (once per opt-out). */
  const forgetEverything = Effect.gen(function* () {
    yield* Ref.set(stateRef, EMPTY_STATE);
    yield* Ref.set(dirtyRef, false);
    yield* Ref.set(identifierRef, null);
    yield* Ref.set(reachedRef, new Set());
    yield* Ref.set(feedbackRef, []);
    if (yield* Ref.get(forgottenRef)) return;
    yield* forgetTelemetryIdentity.pipe(Effect.provideContext(identityServices));
    yield* fileSystem
      .remove(statePath, { force: true })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not delete usage analytics state.", { cause }),
        ),
      );
    yield* Ref.set(forgottenRef, true);
  });

  const loadIdentifier = Effect.gen(function* () {
    const cached = yield* Ref.get(identifierRef);
    if (cached !== null) return cached;
    const identifier = yield* getTelemetryIdentifier.pipe(Effect.provideContext(identityServices));
    yield* Ref.set(identifierRef, identifier);
    return identifier;
  });

  const sendBatch = Effect.fn("AnalyticsService.sendBatch")(function* (
    identifier: string,
    events: ReadonlyArray<PendingEvent>,
    timeout: Duration.Input,
  ) {
    const payload = {
      api_key: posthogKey,
      batch: events.map(({ uuid, capturedAt, payload: { event, properties } }) => ({
        event,
        uuid,
        distinct_id: identifier,
        timestamp: capturedAt,
        // `usage.daily` counts go out as flat properties, which PostHog can sum and chart.
        properties: {
          ...("counts" in properties ? { day: properties.day, ...properties.counts } : properties),
          ...envelope,
        },
      })),
    };

    yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout(timeout),
    );
  });

  /** Sends pending events in batches, removing each batch only once the ingest accepted it. */
  const sendPending = (timeout: Duration.Input) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(stateRef)).pending.length === 0) return;
      const identifier = yield* loadIdentifier;
      if (identifier === null) return;
      while (true) {
        const batch = (yield* Ref.get(stateRef)).pending.slice(0, telemetryConfig.flushBatchSize);
        if (batch.length === 0) return;
        yield* sendBatch(identifier, batch, timeout);
        const sent = new Set(batch.map((event) => event.uuid));
        yield* Ref.update(stateRef, (state) => ({
          ...state,
          pending: state.pending.filter((event) => !sent.has(event.uuid)),
        }));
        yield* Ref.set(dirtyRef, true);
      }
    });

  /**
   * One pass: honor the user's setting, roll counts over at UTC midnight, send what's due, and
   * save state at most every {@link PERSIST_INTERVAL_MS} (always when `final`).
   */
  const tick = (final: boolean) =>
    Effect.gen(function* () {
      const allowed = yield* readUserAllows;
      yield* Ref.set(allowedRef, allowed);
      if (!allowed) {
        takeReports();
        return yield* forgetEverything;
      }
      // Counting may write the state file again, so a later opt-out must delete it again.
      yield* Ref.set(forgottenRef, false);

      const nowMillis = yield* Clock.currentTimeMillis;
      yield* queueDueEvents(nowMillis);
      yield* queueErrorReports(nowMillis);
      const notes = yield* Ref.getAndSet(feedbackRef, []);
      yield* enqueue(
        notes.map((properties) => ({ event: "feedback.sent", properties })),
        nowMillis,
      );
      if (final || nowMillis >= (yield* Ref.get(nextSendAtRef))) {
        // Shutdown waits for the last send, so keep it short there.
        yield* sendPending(final ? "2 seconds" : "10 seconds").pipe(
          Effect.catch((cause) =>
            Ref.set(nextSendAtRef, nowMillis + SEND_RETRY_DELAY_MS).pipe(
              Effect.andThen(
                Effect.logDebug("Usage analytics send failed; will retry.", { cause }),
              ),
            ),
          ),
        );
      }
      if (final || nowMillis - (yield* Ref.get(lastPersistRef)) >= PERSIST_INTERVAL_MS) {
        yield* persist;
      }
    }).pipe(
      tickLock.withPermits(1),
      Effect.catchCause((cause) => Effect.logError("Usage analytics tick failed", { cause })),
    );

  yield* Effect.forever(Effect.sleep(1000).pipe(Effect.flatMap(() => tick(false))), {
    disableYield: true,
  }).pipe(Effect.forkScoped);
  yield* Effect.addFinalizer(() => tick(true));

  return AnalyticsService.of({ count, reach, sendFeedback, flush: tick(false) });
});

export const layer = Layer.effect(AnalyticsService, make);

export const layerTest = AnalyticsService.layerTest;
