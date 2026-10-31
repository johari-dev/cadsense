/**
 * Anonymous PostHog telemetry service.
 *
 * Buffers events in memory and flushes batches over Effect's HTTP client, keyed by the anonymous
 * installation id from Identify.ts. Events are sent only when all three hold:
 *
 * - a PostHog key is configured: baked into release bundles (see `__CADSENSE_POSTHOG_KEY__` in
 *   apps/server/vite.config.ts) or set with `CADSENSE_POSTHOG_KEY`. Dev runs and tests have none,
 *   so they send nothing;
 * - `CADSENSE_TELEMETRY_ENABLED` isn't false;
 * - the user's `enableUsageAnalytics` setting is on. Turning it off drops queued events and
 *   deletes the installation id.
 *
 * @module AnalyticsService
 */
import { HostProcessArchitecture, HostProcessPlatform } from "@cadsense/shared/hostProcess";
import type { ClientOs } from "@cadsense/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import type * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { forgetTelemetryIdentity, getTelemetryIdentifier } from "./Identify.ts";

interface BufferedAnalyticsEvent {
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
}

// Replaced with the release build's CADSENSE_POSTHOG_KEY when the server is bundled. Unbundled
// runs (dev, tests) leave it undeclared, which `typeof` reads as "undefined" without throwing.
declare const __CADSENSE_POSTHOG_KEY__: string | undefined;
const BUNDLED_POSTHOG_KEY =
  typeof __CADSENSE_POSTHOG_KEY__ === "string" && __CADSENSE_POSTHOG_KEY__ !== ""
    ? __CADSENSE_POSTHOG_KEY__
    : undefined;

const TelemetryEnvConfig = Config.all({
  posthogKey: Config.string("CADSENSE_POSTHOG_KEY").pipe(Config.option),
  posthogHost: Config.string("CADSENSE_POSTHOG_HOST").pipe(
    Config.withDefault("https://us.i.posthog.com"),
  ),
  enabled: Config.boolean("CADSENSE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  flushBatchSize: Config.number("CADSENSE_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  maxBufferedEvents: Config.number("CADSENSE_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
  wslDistroName: Config.string("WSL_DISTRO_NAME").pipe(Config.option),
});

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Record an anonymous event for best-effort buffered delivery. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /** Flush all currently queued telemetry events. */
    readonly flush: Effect.Effect<void>;
  }
>()("@cadsense/server/telemetry/AnalyticsService") {
  /** No-op layer for callers that intentionally disable telemetry. */
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
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
    return AnalyticsService.of({ record: () => Effect.void, flush: Effect.void });
  }

  const httpClient = yield* HttpClient.HttpClient;
  const serverSettings = yield* ServerSettingsService;
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  // The hashed installation id once loaded; null until the first send and after forgetting it.
  const identifierRef = yield* Ref.make<string | null>(null);
  // Whether the installation id was deleted since analytics last sent, so a disabled install
  // removes the file once instead of on every flush tick.
  const forgottenRef = yield* Ref.make(false);
  // Serializes flushes (the ticker and the shutdown finalizer) with forgetting the identity, so a
  // send that started before the user opted out can't recreate the id they just deleted.
  const flushLock = yield* Semaphore.make(1);
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  // Identify.ts reads and writes the installation id file; capture what it needs now so the
  // service's own methods stay requirement-free.
  const identityServices = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Crypto.Crypto
  >();

  /**
   * The user's choice. An unreadable settings file reads as off: an explicit "off" silently
   * becoming "on" would break their stated choice, while the reverse loses a few events.
   */
  const userAllowsAnalytics = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.enableUsageAnalytics),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read server settings; not sending usage analytics.", {
        cause,
      }).pipe(Effect.as(false)),
    ),
  );

  const enqueueBufferedEvent = (event: string, properties?: Readonly<Record<string, unknown>>) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            event,
            ...(properties ? { properties } : {}),
            capturedAt: DateTime.formatIso(now),
          } satisfies BufferedAnalyticsEvent,
        ];

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

        return [
          {
            size: next.length,
            dropped: next.length !== appended.length,
          } as const,
          next,
        ] as const;
      }),
    );

  const loadIdentifier = Effect.gen(function* () {
    const cached = yield* Ref.get(identifierRef);
    if (cached !== null) return cached;
    const identifier = yield* getTelemetryIdentifier.pipe(Effect.provideContext(identityServices));
    yield* Ref.set(identifierRef, identifier);
    yield* Ref.set(forgottenRef, false);
    return identifier;
  });

  /** Drops queued events and deletes the installation id (once per opt-out). */
  const forgetEverything = Effect.gen(function* () {
    yield* Ref.set(bufferRef, []);
    yield* Ref.set(identifierRef, null);
    if (yield* Ref.get(forgottenRef)) return;
    yield* forgetTelemetryIdentity.pipe(Effect.provideContext(identityServices));
    yield* Ref.set(forgottenRef, true);
  });

  const sendBatch = Effect.fn("AnalyticsService.sendBatch")(function* (
    identifier: string,
    events: ReadonlyArray<BufferedAnalyticsEvent>,
  ) {
    const payload = {
      api_key: posthogKey,
      batch: events.map((event) => ({
        event: event.event,
        distinct_id: identifier,
        properties: {
          ...event.properties,
          $process_person_profile: false,
          platform: hostPlatform,
          wsl: Option.getOrUndefined(telemetryConfig.wslDistroName),
          arch: hostArchitecture,
          cadsenseCodeVersion: packageJson.version,
          clientType: "desktop-app",
          serverOs: serverOsFromNodePlatform(hostPlatform),
          serverArch: hostArchitecture,
          serverWslDistro: Option.getOrUndefined(telemetryConfig.wslDistroName),
          serverAppVersion: packageJson.version,
          serverMode: "desktop",
        },
        timestamp: event.capturedAt,
      })),
    };

    yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
  });

  const flush: AnalyticsService["Service"]["flush"] = Effect.gen(function* () {
    // Checked under the lock, right before sending, so turning analytics off takes effect on
    // the next tick even for events queued while it was on.
    if (!(yield* userAllowsAnalytics)) {
      return yield* forgetEverything;
    }
    if ((yield* Ref.get(bufferRef)).length === 0) return;

    const identifier = yield* loadIdentifier;
    if (identifier === null) return;

    while (true) {
      const batch = yield* Ref.modify(bufferRef, (current) => {
        if (current.length === 0) {
          return [[] as ReadonlyArray<BufferedAnalyticsEvent>, current] as const;
        }
        const nextBatch = current.slice(0, telemetryConfig.flushBatchSize);
        const remaining = current.slice(nextBatch.length);
        return [nextBatch, remaining] as const;
      });

      if (batch.length === 0) {
        return;
      }

      yield* sendBatch(identifier, batch).pipe(
        Effect.catch((error) =>
          Ref.update(bufferRef, (current) => [...batch, ...current]).pipe(
            Effect.flatMap(() => Effect.fail(error)),
          ),
        ),
      );
    }
  }).pipe(
    flushLock.withPermits(1),
    Effect.catch((cause) => Effect.logError("Failed to flush telemetry", { cause })),
  );

  const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
    function* (event, properties) {
      if (!(yield* userAllowsAnalytics)) return;

      const enqueueResult = yield* enqueueBufferedEvent(event, properties);
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  yield* Effect.forever(Effect.sleep(1000).pipe(Effect.flatMap(() => flush)), {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => flush);

  return AnalyticsService.of({ record, flush });
});

export const layer = Layer.effect(AnalyticsService, make);

export const layerTest = AnalyticsService.layerTest;
