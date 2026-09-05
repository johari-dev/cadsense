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
