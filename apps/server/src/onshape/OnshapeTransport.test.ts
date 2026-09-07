import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/unstable/http";

import * as OnshapeTransport from "./OnshapeTransport.ts";

const request: OnshapeTransport.OnshapeTransportRequest = {
  method: "GET",
  url: "https://cad.onshape.com/api/v17/documents/a?configuration=Size%3DLarge%3BWidth%3D20%20mm&literal=a+b&token=%2f%2F",
  headers: { Accept: "application/json" },
  responseType: "json",
};
type FetchHandler = (
  ...args: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;
const layer = (fetch: FetchHandler) =>
  OnshapeTransport.layer.pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(
          Layer.succeed(FetchHttpClient.Fetch, Object.assign(fetch, { preconnect: () => {} })),
        ),
      ),
    ),
  );

describe("bounded Onshape JSON transport", () => {
  it.effect("allows export submission two minutes before aborting without retry", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let aborted = false;
      let calls = 0;
      const fetch: FetchHandler = (_input, init) => {
        calls++;
        Deferred.doneUnsafe(started, Effect.void);
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
      };
      yield* Effect.gen(function* () {
        const transport = yield* OnshapeTransport.OnshapeTransport;
        const pending = yield* transport
          .execute({ ...request, method: "POST", body: "{}" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("119 seconds");
        assert.isFalse(aborted);
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Fiber.join(pending))._tag, "OnshapeTransportFailure");
        assert.isTrue(aborted);
        assert.equal(calls, 1);
      }).pipe(Effect.provide(layer(fetch)));
    }),
  );
  it.effect("sends the JSON export body and counts actual HTTP attempts", () => {
    const metrics = { requests: 0 };
    const body = '{"storeInDocument":false,"notifyUser":false}';
    const fetch: FetchHandler = async (_input, init) => {
      assert.equal(init?.method, "POST");
      assert.equal(await new Response(init?.body).text(), body);
      assert.equal(init?.redirect, "manual");
      return new Response('{"id":"export-job"}', { status: 200 });
    };
    return Effect.gen(function* () {
      const transport = yield* OnshapeTransport.OnshapeTransport;
      yield* transport.execute({ ...request, method: "POST", body });
      assert.equal(metrics.requests, 1);
    }).pipe(
      Effect.provide(layer(fetch)),
      Effect.provideService(OnshapeTransport.OnshapeRequestMetrics, metrics),
    );
  });
  it.effect(
    "allows binary downloads past the JSON deadline but still cancels at three minutes",
    () => {
      let cancelled = false;
      return Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fetch: FetchHandler = async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull() {
                  Deferred.doneUnsafe(started, Effect.void);
                },
                cancel() {
                  cancelled = true;
                },
              },
              { highWaterMark: 0 },
            ),
          );
        yield* Effect.gen(function* () {
          const transport = yield* OnshapeTransport.OnshapeTransport;
          const fiber = yield* transport
            .execute({ ...request, responseType: "binary" })
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(started);
          yield* TestClock.adjust("16 seconds");
          assert.isFalse(cancelled);
          yield* TestClock.adjust("164 seconds");
          assert.equal((yield* Fiber.join(fiber))._tag, "OnshapeTransportFailure");
          assert.isTrue(cancelled);
        }).pipe(Effect.provide(layer(fetch)));
      });
    },
  );
  it.effect("checks cumulative bytes and cancels immediately on a typed reserve failure", () => {
    let reads = 0;
    let cancelled = false;
    let calls = 0;
    const totals: number[] = [];
    const failure = { reason: "disk-space" };
    const fetch: FetchHandler = async () => {
      calls++;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              reads++;
              controller.enqueue(new Uint8Array([1, 2]));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      );
    };
    return Effect.gen(function* () {
      const transport = yield* OnshapeTransport.OnshapeTransport;
      assert.strictEqual(
        yield* transport
          .execute({
            ...request,
            responseType: "binary",
            beforeChunk: (received) =>
              Effect.suspend(() => {
                totals.push(received);
                return received >= 4 ? Effect.fail(failure) : Effect.void;
              }),
          })
          .pipe(Effect.flip),
        failure,
      );
      assert.deepEqual(totals, [2, 4]);
      assert.equal(reads, 2);
      assert.equal(calls, 1);
      assert.isTrue(cancelled);
    }).pipe(Effect.provide(layer(fetch)));
  });
  it.effect("returns bounded binary bytes and a normalized media type without assuming GLB", () => {
    const fetch: FetchHandler = async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "Model/GLTF+JSON; charset=utf-8" },
      });
    return Effect.gen(function* () {
      const transport = yield* OnshapeTransport.OnshapeTransport;
      const response = yield* transport.execute({ ...request, responseType: "binary" });
      assert.deepEqual(response.bytes, new Uint8Array([1, 2, 3]));
      assert.equal(response.contentType, "model/gltf+json");
      assert.isUndefined(response.body);
    }).pipe(Effect.provide(layer(fetch)));
  });

  it.effect("exposes redirect location without following it or consuming its body", () => {
    let calls = 0;
    let reads = 0;
    const location = "https://download.onshape.com/asset?token=%2f%2F";
    const fetch: FetchHandler = async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, "manual");
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              reads++;
            },
          },
          { highWaterMark: 0 },
        ),
        {
          status: 307,
          headers: { location, "content-type": "untrusted response text" },
        },
      );
    };
    return Effect.gen(function* () {
      const transport = yield* OnshapeTransport.OnshapeTransport;
      const response = yield* transport.execute({ ...request, responseType: "binary" });
      assert.equal(response.status, 307);
      assert.equal(response.location, location);
      assert.isNull(response.contentType);
      assert.isUndefined(response.bytes);
      assert.equal(calls, 1);
      assert.equal(reads, 0);
    }).pipe(Effect.provide(layer(fetch)));
  });

  it.effect("cancels a binary body when streamed bytes exceed the transport cap", () => {
    let cancelled = false;
    let chunks = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const fetch: FetchHandler = async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              chunks++;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-length": "1" } },
      );
    return Effect.gen(function* () {
      const transport = yield* OnshapeTransport.OnshapeTransport;
      assert.equal(
        (yield* transport.execute({ ...request, responseType: "binary" }).pipe(Effect.flip))._tag,
        "OnshapeTransportFailure",
      );
      assert.equal(chunks, OnshapeTransport.MAX_BINARY_BODY_BYTES / chunk.byteLength + 1);
      assert.isTrue(cancelled);
    }).pipe(Effect.provide(layer(fetch)));
  });

  it.effect("cancels a binary stream when the caller interrupts the download", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      let cancelled = false;
      const fetch: FetchHandler = async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                Deferred.doneUnsafe(reading, Effect.void);
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
        );
      yield* Effect.gen(function* () {
        const transport = yield* OnshapeTransport.OnshapeTransport;
        const pending = yield* transport
          .execute({ ...request, responseType: "binary" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(reading);
        yield* Fiber.interrupt(pending);
        assert.isTrue(cancelled);
      }).pipe(Effect.provide(layer(fetch)));
    }),
  );

  it.effect("decodes streamed JSON and preserves the encoded query with redirects disabled", () => {
    let calls = 0;
    const fetch: FetchHandler = async (input, init) => {
      calls++;
      assert.equal(String(input), request.url);
      assert.equal(init?.redirect, "manual");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"elements":'));
            controller.enqueue(new TextEncoder().encode("[]}"));
            controller.close();
          },
        }),
      );
    };
    return Effect.gen(function* () {
      const transport = yield* OnshapeTransport.OnshapeTransport;
      assert.deepEqual((yield* transport.execute(request)).body, { elements: [] });
      assert.equal(calls, 1);
    }).pipe(Effect.provide(layer(fetch)));
  });

  it.effect("rejects malformed JSON and invalid UTF-8 without exposing body contents", () => {
    const bodies = [new TextEncoder().encode("private-secret-not-json"), new Uint8Array([0xff])];
    let calls = 0;
    const fetch: FetchHandler = async () => new Response(bodies[calls++]);
    return Effect.gen(function* () {
      const transport = yield* OnshapeTransport.OnshapeTransport;
      for (let index = 0; index < bodies.length; index++) {
        const error = yield* transport.execute(request).pipe(Effect.flip);
        assert.equal(error._tag, "OnshapeTransportFailure");
        assert.notProperty(error, "cause");
        assert.deepEqual(Object.keys(error), ["_tag"]);
      }
      assert.equal(calls, 2);
    }).pipe(Effect.provide(layer(fetch)));
  });

  it.effect("caps actual streamed bytes even when content length understates the body", () => {
    let cancelled = false;
    let calls = 0;
    const fetch: FetchHandler = async () => {
      calls++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(OnshapeTransport.MAX_JSON_BODY_BYTES + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "1" } },
      );
    };
    return Effect.gen(function* () {
      const transport = yield* OnshapeTransport.OnshapeTransport;
      assert.equal(
        (yield* transport.execute(request).pipe(Effect.flip))._tag,
        "OnshapeTransportFailure",
      );
      assert.isTrue(cancelled);
      assert.equal(calls, 1);
    }).pipe(Effect.provide(layer(fetch)));
  });

  it.effect("preserves status-only verification and non-2xx responses without reading JSON", () => {
    let reads = 0;
    let calls = 0;
    const fetch: FetchHandler = async () => {
      calls++;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              reads++;
            },
          },
          { highWaterMark: 0 },
        ),
        { status: calls === 1 ? 200 : 429, headers: { "retry-after": "60" } },
      );
    };
    return Effect.gen(function* () {
      const transport = yield* OnshapeTransport.OnshapeTransport;
      const verification = yield* transport.execute({
        method: "GET",
        url: request.url,
        headers: request.headers,
      });
      assert.equal(verification.status, 200);
      assert.isUndefined(verification.body);
      const throttled = yield* transport.execute(request);
      assert.equal(throttled.status, 429);
      assert.equal(throttled.retryAfter, "60");
      assert.equal(reads, 0);
    }).pipe(Effect.provide(layer(fetch)));
  });

  it.effect("times out a hanging body and cancels it without retrying", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      let cancelled = false;
      let calls = 0;
      const fetch: FetchHandler = async () => {
        calls++;
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                Deferred.doneUnsafe(reading, Effect.void);
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
        );
      };
      yield* Effect.gen(function* () {
        const transport = yield* OnshapeTransport.OnshapeTransport;
        const pending = yield* transport.execute(request).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(reading);
        yield* TestClock.adjust("15 seconds");
        assert.equal((yield* Fiber.join(pending))._tag, "OnshapeTransportFailure");
        assert.isTrue(cancelled);
        assert.equal(calls, 1);
      }).pipe(Effect.provide(layer(fetch)));
    }),
  );
});
