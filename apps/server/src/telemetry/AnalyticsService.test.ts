import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { HostProcessArchitecture, HostProcessPlatform } from "@cadsense/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as ErrorReports from "./ErrorReports.ts";

const SentEvent = Schema.Struct({
  event: Schema.String,
  uuid: Schema.String,
  distinct_id: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Unknown),
});
type SentEvent = typeof SentEvent.Type;
const decodeBatch = Schema.decodeUnknownEffect(Schema.Struct({ batch: Schema.Array(SentEvent) }));

/** The real service against an in-process ingest; `sent` collects every event it receives. */
const makeHarness = (prefix: string) => {
  const sent: SentEvent[] = [];
  const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix });
  const ingest = HttpServer.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* decodeBatch(yield* request.json);
      sent.push(...body.batch);
      return HttpServerResponse.jsonUnsafe({});
    }).pipe(Effect.orDie),
  );
  const analyticsLayer = AnalyticsService.layer.pipe(
    Layer.provide(serverConfigLayer),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          CADSENSE_POSTHOG_KEY: "phc_test_key",
          CADSENSE_POSTHOG_HOST: "http://localhost",
        }),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcessPlatform, "linux"),
        Layer.succeed(HostProcessArchitecture, "arm64"),
      ),
    ),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );
  return { sent, ingest, layer: Layer.merge(analyticsLayer, serverConfigLayer) };
};

it.layer(NodeServices.layer)("AnalyticsService", (it) => {
  it.effect("sends each failure once, and at most three error reports a day", () =>
    Effect.gen(function* () {
      const harness = makeHarness("cadsense-telemetry-errors-");
      ErrorReports.takeReports();
      const logError = (message: string) =>
        Effect.logError(message).pipe(Effect.provide(Logger.layer([ErrorReports.logger])));
      yield* Effect.gen(function* () {
        yield* Layer.launch(harness.ingest).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* logError("Provider refresh failed");
        yield* logError("Provider refresh failed");
        yield* analytics.flush;
        yield* logError("Provider refresh failed");
        yield* logError("Snapshot load failed");
        yield* logError("Asset signing key failed");
        yield* logError("Upload failed");
        yield* analytics.flush;
      }).pipe(Effect.provide(harness.layer));

      const reports = harness.sent.filter((event) => event.event === "$exception");
      assert.deepEqual(
        reports.map(
          (event) =>
            (event.properties.$exception_list as ReadonlyArray<{ readonly value: string }>)[0]
              ?.value,
        ),
        ["Provider refresh failed", "Snapshot load failed", "Asset signing key failed"],
      );
      // Errors alone don't make an install active.
      assert.isFalse(harness.sent.some((event) => event.event === "app.active"));
    }),
  );

  it.effect("a reached milestone is sent without marking the day active", () =>
    Effect.gen(function* () {
      const harness = makeHarness("cadsense-telemetry-reach-");
      yield* Effect.gen(function* () {
        yield* Layer.launch(harness.ingest).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.reach("first_provider_ready");
        yield* analytics.reach("first_provider_ready");
        yield* analytics.flush;
        yield* analytics.reach("first_provider_ready");
        yield* analytics.flush;
      }).pipe(Effect.provide(harness.layer));

      assert.deepEqual(
        harness.sent.map((event) => [event.event, event.properties.milestone]),
        [
          ["milestone.reached", "first_launch"],
          ["milestone.reached", "first_provider_ready"],
        ],
      );
    }),
  );

  it.effect("turns counts into active, milestone, and next-day summary events", () =>
    Effect.gen(function* () {
      const harness = makeHarness("cadsense-telemetry-counts-");
      const sent = harness.sent;

      yield* Effect.gen(function* () {
        yield* Layer.launch(harness.ingest).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;

        // The test clock starts at 1970-01-01T00:00:00Z.
        yield* analytics.count("agent_turns_codex");
        yield* analytics.count("agent_turns_codex");
        yield* analytics.count("fs_runs_panel");
        yield* analytics.flush;

        assert.deepEqual(
          sent.map((event) => [event.event, event.properties.day ?? event.properties.milestone]),
          [
            ["app.active", "1970-01-01"],
            ["milestone.reached", "first_launch"],
            ["milestone.reached", "first_agent_turn"],
            ["milestone.reached", "first_featurescript_preview"],
          ],
        );

        // A count on the next UTC day finishes the first day's counts.
        yield* TestClock.adjust("1 day");
        yield* analytics.count("ratings_up");
        yield* analytics.flush;
      }).pipe(Effect.provide(harness.layer));

      const summaries = sent.filter((event) => event.event === "usage.daily");
      assert.equal(summaries.length, 1);
      const summary = summaries[0]!.properties;
      assert.equal(summary.day, "1970-01-01");
      assert.equal(summary.agent_turns_codex, 2);
      assert.equal(summary.fs_runs_panel, 1);
      // Every counter is present, zero where nothing was counted.
      assert.equal(summary.ratings_up, 0);
      assert.deepEqual(
        sent.filter((event) => event.event === "app.active").map((event) => event.properties.day),
        ["1970-01-01", "1970-01-02"],
      );
      // Milestones go out once, however many times their counters move.
      assert.equal(
        sent.filter((event) => event.properties.milestone === "first_agent_turn").length,
        1,
      );
      assert.equal(new Set(sent.map((event) => event.uuid)).size, sent.length);
      assert.isTrue(
        sent.every(
          (event) =>
            event.properties.$process_person_profile === false &&
            event.properties.schemaVersion === 1 &&
            event.properties.os === "Linux" &&
            event.properties.arch === "arm64",
        ),
      );
    }),
  );
});
