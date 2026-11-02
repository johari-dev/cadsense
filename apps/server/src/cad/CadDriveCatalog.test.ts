import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ServerConfig from "../config.ts";
import { make } from "./CadDriveCatalog.ts";

// Each case maps to one line of "Catalog" in CadDriveOptions.md.

/** ReCalc's files by vendor and kind; anything missing is a 404, like a vendor with no sprockets. */
type Files = Record<string, Record<string, unknown[]>>;
const WCP: Files = {
  WCP: {
    gears: [
      { teeth: 12, dp: 20, bore: "SplineXS", sku: "WCP-1", url: "https://wcp/1", vendor: "WCP" },
      { dp: 20, bore: "SplineXS", sku: "WCP-bad", url: "https://wcp/bad", vendor: "WCP" },
    ],
    pulleys: [
      {
        teeth: 18,
        profile: "HTD",
        pitch: 5,
        bore: '1/2" Hex',
        sku: "WCP-2",
        url: "https://wcp/2",
        vendor: "WCP",
      },
    ],
    belts: [
      {
        teeth: 70,
        profile: "HTD",
        pitch: 5,
        width: 9,
        sku: "WCP-3",
        url: "https://wcp/3",
        vendor: "WCP",
      },
    ],
  },
  REV: {
    sprockets: [
      {
        teeth: 22,
        chainType: "#25",
        bore: '1/2" Hex',
        sku: null,
        url: "https://rev/4",
        vendor: "REV",
      },
    ],
  },
};

/** A fake GitHub that serves `files()` and counts requests. */
const github = (files: () => Files | "offline") => {
  let requests = 0;
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests++;
      const served = files();
      if (served === "offline") return Effect.die(new Error("network down"));
      const match = /\/app\/genData\/([^/]+)\/([^/.]+)\.json$/.exec(new URL(request.url).pathname);
      const body = match ? served[match[1]!]?.[match[2]!] : undefined;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          body ? Response.json(body) : new Response("404: Not Found", { status: 404 }),
        ),
      );
    }),
  );
  return { layer, requests: () => requests };
};
const services = (prefix: string, http: Layer.Layer<HttpClient.HttpClient>) =>
  ServerConfig.layerTest(process.cwd(), { prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(http),
  );

describe("CadDriveCatalog", () => {
  it.effect("skips missing files and malformed entries", () => {
    const http = github(() => WCP);
    return Effect.gen(function* () {
      const catalog = yield* (yield* make).current;
      assert.deepStrictEqual(
        catalog.gears.map((gear) => gear.sku),
        ["WCP-1"],
      );
      assert.deepStrictEqual(catalog.pulleys[0], {
        teeth: 18,
        profile: "HTD",
        pitchMm: 5,
        bore: '1/2" Hex',
        vendor: "WCP",
        sku: "WCP-2",
        url: "https://wcp/2",
      });
      assert.strictEqual(catalog.belts[0]?.widthMm, 9);
      assert.deepStrictEqual(catalog.sprockets[0], {
        teeth: 22,
        chain: "#25",
        bore: '1/2" Hex',
        vendor: "REV",
        sku: null,
        url: "https://rev/4",
      });
    }).pipe(Effect.scoped, Effect.provide(services("drive-catalog-parse", http.layer)));
  });

  it.effect("fails with a reason instead of answering from an empty catalog", () => {
    const http = github(() => "offline");
    return Effect.gen(function* () {
      const error = yield* (yield* make).current.pipe(Effect.flip);
      assert.strictEqual(error.reason, "capability-unavailable");
      assert.include(error.details ?? "", "ReCalc");
    }).pipe(Effect.scoped, Effect.provide(services("drive-catalog-offline", http.layer)));
  });

  it.effect("downloads once a day, and keeps the last good copy when a refresh fails", () => {
    let served: Files | "offline" = WCP;
    const http = github(() => served);
    return Effect.gen(function* () {
      const service = yield* make;
      const first = yield* service.current;
      const perDownload = http.requests();
      yield* service.current;
      assert.strictEqual(http.requests(), perDownload);
      served = "offline";
      yield* TestClock.adjust("25 hours");
      assert.deepStrictEqual(yield* service.current, first);
      assert.isAbove(http.requests(), perDownload);
    }).pipe(Effect.scoped, Effect.provide(services("drive-catalog-ttl", http.layer)));
  });

  it.effect("waits five minutes after a failed download before trying again", () => {
    const http = github(() => "offline");
    return Effect.gen(function* () {
      const service = yield* make;
      yield* service.current.pipe(Effect.flip);
      const afterFirst = http.requests();
      yield* service.current.pipe(Effect.flip);
      assert.strictEqual(http.requests(), afterFirst);
      yield* TestClock.adjust("6 minutes");
      yield* service.current.pipe(Effect.flip);
      assert.isAbove(http.requests(), afterFirst);
    }).pipe(Effect.scoped, Effect.provide(services("drive-catalog-retry", http.layer)));
  });

  it.effect("reads the last good copy from disk after a restart without a network", () => {
    let served: Files | "offline" = WCP;
    const http = github(() => served);
    return Effect.gen(function* () {
      const first = yield* (yield* make).current;
      served = "offline";
      const restarted = yield* make;
      assert.deepStrictEqual(yield* restarted.current, first);
    }).pipe(Effect.scoped, Effect.provide(services("drive-catalog-disk", http.layer)));
  });
});
