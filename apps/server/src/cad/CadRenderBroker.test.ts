import * as NodeServices from "@effect/platform-node/NodeServices";
import { CadSnapshotManifest, type CadRenderEvent } from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { initialCadView } from "./CadViewState.ts";
import { make } from "./CadRenderBroker.ts";

const manifest = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000001",
  rootId: "1".repeat(64),
  projectId: "project",
  createdAt: "2026-09-05T00:00:00Z",
  root: {
    host: "https://cad.onshape.com",
    documentId: "a".repeat(24),
    elementId: "b".repeat(24),
    kind: "assembly",
    originalRevision: { kind: "m", id: "c".repeat(24) },
    microversionId: "c".repeat(24),
    configuration: "default",
    tessellationProfile: "test",
  },
  nodes: [],
  parts: [],
  assets: [],
  dependencies: [],
});
const request = {
  sessionId: "primary",
  runId: "run",
  manifest,
  state: initialCadView(manifest),
  readAsset: () => Effect.die("Unexpected asset access"),
};
const receipt = {
  snapshotId: manifest.snapshotId,
  revision: 0,
  pose: {
    position: [2, 2, 2],
    target: [0, 0, 0],
    up: [0, 1, 0],
    projection: "perspective",
    zoom: 1,
  },
};
// The broker checks the bounded PNG envelope; pixel decoding belongs to the renderer.
const pngEnvelope = () => {
  const png = new Uint8Array(57);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = new DataView(png.buffer);
  header.setUint32(8, 13);
  header.setUint32(12, 0x49484452);
  header.setUint32(16, 1280);
  header.setUint32(20, 960);
  header.setUint32(37, 0x49444154);
  header.setUint32(49, 0x49454e44);
  return png;
};
const connect = Effect.fn(function* (broker: Effect.Success<typeof make>) {
  const events = yield* Queue.unbounded<CadRenderEvent>();
  const host = yield* broker.connect().pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkChild,
  );
  assert.equal((yield* Queue.take(events)).type, "ready");
  return { events, host };
});
const takeTicket = Effect.fn(function* (events: Queue.Queue<CadRenderEvent>) {
  const event = yield* Queue.take(events);
  if (event.type !== "capture") return yield* Effect.die("Expected capture ticket");
  return event.ticket;
});

it.effect(
  "accepts only the exact revision and token, and consumes each successful result once",
  () =>
    Effect.gen(function* () {
      const broker = yield* make;
      assert.equal((yield* broker.capture(request).pipe(Effect.flip)).reason, "unavailable");
      const { events } = yield* connect(broker);
      const capture = yield* broker.capture(request).pipe(Effect.forkChild);
      const ticket = yield* takeTicket(events);
      assert.deepEqual((yield* broker.readJob(ticket)).state, request.state);
      assert.equal(
        (yield* broker.readJob({ ...ticket, token: "wrong" }).pipe(Effect.flip)).reason,
        "interrupted",
      );
      assert.equal(
        (yield* broker
          .complete(ticket, { ...receipt, revision: 1 }, pngEnvelope())
          .pipe(Effect.flip)).reason,
        "invalid-result",
      );
      assert.equal(
        (yield* broker.readAsset(ticket, "f".repeat(64)).pipe(Effect.flip)).reason,
        "unavailable",
      );
      assert.equal(
        (yield* broker.complete(ticket, receipt, pngEnvelope().subarray(0, 33)).pipe(Effect.flip))
          .reason,
        "invalid-result",
      );
      yield* broker.complete(ticket, receipt, pngEnvelope());
      assert.equal((yield* Fiber.join(capture)).png.byteLength, 57);
      assert.equal(
        (yield* broker.complete(ticket, receipt, pngEnvelope()).pipe(Effect.flip)).reason,
        "interrupted",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("disconnect fails pending work and a replacement host cannot replay the old ticket", () =>
  Effect.gen(function* () {
    const broker = yield* make;
    const first = yield* connect(broker);
    const capture = yield* broker.capture(request).pipe(Effect.flip, Effect.forkChild);
    const ticket = yield* takeTicket(first.events);
    yield* Fiber.interrupt(first.host);
    assert.equal((yield* Fiber.join(capture)).reason, "interrupted");
    const second = yield* connect(broker);
    assert.equal((yield* broker.readJob(ticket).pipe(Effect.flip)).reason, "interrupted");
    const next = yield* broker.capture(request).pipe(Effect.forkChild);
    const newTicket = yield* takeTicket(second.events);
    assert.notEqual(newTicket.jobId, ticket.jobId);
    yield* broker.complete(newTicket, receipt, pngEnvelope());
    yield* Fiber.join(next);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("interruption emits cancellation and immediately revokes job access", () =>
  Effect.gen(function* () {
    const broker = yield* make;
    const { events } = yield* connect(broker);
    const capture = yield* broker.capture(request).pipe(Effect.forkChild);
    const ticket = yield* takeTicket(events);
    yield* Fiber.interrupt(capture);
    assert.deepEqual(yield* Queue.take(events), { type: "cancel", jobId: ticket.jobId });
    assert.equal((yield* broker.readJob(ticket).pipe(Effect.flip)).reason, "interrupted");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "bounds work globally and per viewer without evicting another viewer's accepted capture",
  () =>
    Effect.gen(function* () {
      const broker = yield* make;
      const { events } = yield* connect(broker);
      const runs = [];
      for (let index = 0; index < 64; index++) {
        runs.push(
          yield* broker
            .capture({ ...request, sessionId: `session-${Math.floor(index / 8)}` })
            .pipe(Effect.forkChild),
        );
        yield* takeTicket(events);
        if (index === 7)
          assert.equal(
            (yield* broker.capture({ ...request, sessionId: "session-0" }).pipe(Effect.flip))
              .reason,
            "busy",
          );
      }
      assert.equal((yield* broker.capture(request).pipe(Effect.flip)).reason, "busy");
      for (const run of runs) yield* Fiber.interrupt(run);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
