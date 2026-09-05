import type { CadSnapshotManifest, CadViewState } from "@cadsense/contracts";
import {
  CadRenderError,
  CAD_CAPTURE_SIZE,
  CadRenderReceipt,
  type CadRenderEvent,
  type CadRenderTicket,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export interface CadRenderRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly manifest: CadSnapshotManifest;
  readonly state: CadViewState;
  readonly readAsset: (sha256: string) => Effect.Effect<Uint8Array, CadRenderError>;
}
export interface CadRenderedImage {
  readonly receipt: CadRenderReceipt;
  readonly png: Uint8Array;
}
export class CadRenderBroker extends Context.Service<
  CadRenderBroker,
  {
    readonly connect: () => Stream.Stream<CadRenderEvent, CadRenderError>;
    readonly capture: (
      request: CadRenderRequest,
    ) => Effect.Effect<CadRenderedImage, CadRenderError>;
    readonly readJob: (
      ticket: CadRenderTicket,
    ) => Effect.Effect<Omit<CadRenderRequest, "readAsset">, CadRenderError>;
    readonly readAsset: (
      ticket: CadRenderTicket,
      sha256: string,
    ) => Effect.Effect<Uint8Array, CadRenderError>;
    readonly complete: (
      ticket: CadRenderTicket,
      receipt: unknown,
      png: Uint8Array,
    ) => Effect.Effect<void, CadRenderError>;
    readonly fail: (ticket: CadRenderTicket) => Effect.Effect<void, CadRenderError>;
  }
>()("@cadsense/server/cad/CadRenderBroker") {}

interface Pending {
  readonly ticket: CadRenderTicket;
  readonly host: Queue.Queue<CadRenderEvent>;
  readonly request: CadRenderRequest;
  readonly result: Deferred.Deferred<CadRenderedImage, CadRenderError>;
}
const error = (reason: CadRenderError["reason"]) => new CadRenderError({ reason });
const decodeReceipt = Schema.decodeUnknownEffect(CadRenderReceipt);
const { width: WIDTH, height: HEIGHT } = CAD_CAPTURE_SIZE;

/** One environment renderer host, bounded pending work, and no capture replay across disconnects. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const pending = new Map<string, Pending>();
  let host: Queue.Queue<CadRenderEvent> | null = null;
  const uuid = crypto.randomUUIDv4.pipe(Effect.mapError(() => error("unavailable")));
  const lookup = Effect.fn("CadRenderBroker.lookup")(function* (ticket: CadRenderTicket) {
    const item = pending.get(ticket.jobId);
    if (!item || item.ticket.token !== ticket.token || item.host !== host)
      return yield* error("interrupted");
    return item;
  });
  const disconnect = Effect.fn("CadRenderBroker.disconnect")(function* (
    queue: Queue.Queue<CadRenderEvent>,
  ) {
    if (host === queue) host = null;
    for (const [id, item] of pending) {
      if (item.host !== queue) continue;
      pending.delete(id);
      yield* Deferred.fail(item.result, error("interrupted"));
    }
    yield* Queue.shutdown(queue);
  });
  const connect = () =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const queue = yield* Queue.dropping<CadRenderEvent>(128);
          if (host) return yield* error("busy");
          host = queue;
          yield* Queue.offer(queue, { type: "ready" });
          return queue;
        }),
        disconnect,
      ).pipe(Effect.map(Stream.fromQueue)),
    );
  const capture = Effect.fn("CadRenderBroker.capture")(function* (request: CadRenderRequest) {
    if (
      request.manifest.snapshotId !== request.state.snapshotId ||
      request.manifest.rootId !== request.state.rootId
    )
      return yield* error("unavailable");
    const ticket = { jobId: yield* uuid, token: yield* uuid };
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const queue = host;
        if (!queue) return yield* error("unavailable");
        if (
          pending.size >= 64 ||
          [...pending.values()].filter((item) => item.request.sessionId === request.sessionId)
            .length >= 8
        )
          return yield* error("busy");
        const result = yield* Deferred.make<CadRenderedImage, CadRenderError>();
        const item: Pending = { ticket, host: queue, request, result };
        pending.set(ticket.jobId, item);
        if (!(yield* Queue.offer(queue, { type: "capture", ticket }))) {
          pending.delete(ticket.jobId);
          return yield* error("busy");
        }
        return item;
      }),
      (item) =>
        Deferred.await(item.result).pipe(
          Effect.timeoutOrElse({
            duration: "90 seconds",
            orElse: () => Effect.fail(error("interrupted")),
          }),
        ),
      (item) =>
        Effect.gen(function* () {
          // Successful completion removes the entry first, preserving a warm worker.
          if (pending.get(ticket.jobId) !== item) return;
          pending.delete(ticket.jobId);
          if (!(yield* Queue.offer(item.host, { type: "cancel", jobId: ticket.jobId })))
            yield* disconnect(item.host);
        }),
    );
  });
  const readJob = Effect.fn("CadRenderBroker.readJob")(function* (ticket: CadRenderTicket) {
    const { request } = yield* lookup(ticket);
    const { readAsset: _readAsset, ...job } = request;
    return job;
  });
  const readAsset = Effect.fn("CadRenderBroker.readAsset")(function* (
    ticket: CadRenderTicket,
    sha256: string,
  ) {
    const item = yield* lookup(ticket);
    if (!item.request.manifest.assets.some((asset) => asset.sha256 === sha256))
      return yield* error("unavailable");
    const bytes = yield* item.request.readAsset(sha256);
    yield* lookup(ticket);
    return bytes;
  });
  const complete = Effect.fn("CadRenderBroker.complete")(function* (
    ticket: CadRenderTicket,
    input: unknown,
    png: Uint8Array,
  ) {
    const receipt = yield* decodeReceipt(input).pipe(
      Effect.mapError(() => error("invalid-result")),
    );
    const item = yield* lookup(ticket);
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (
      png.byteLength < 33 ||
      png.byteLength > 16 * 1024 ** 2 ||
      signature.some((byte, index) => png[index] !== byte)
    )
      return yield* error("invalid-result");
    const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
    if (
      header.getUint32(8) !== 13 ||
      header.getUint32(12) !== 0x49484452 ||
      header.getUint32(16) !== WIDTH ||
      header.getUint32(20) !== HEIGHT ||
      receipt.snapshotId !== item.request.state.snapshotId ||
      receipt.revision !== item.request.state.revision
    )
      return yield* error("invalid-result");
    let offset = 8;
    let hasPixels = false;
    let ended = false;
    while (offset + 12 <= png.byteLength) {
      const length = header.getUint32(offset);
      const kind = header.getUint32(offset + 4);
      if (length > png.byteLength - offset - 12) return yield* error("invalid-result");
      offset += length + 12;
      if (kind === 0x49444154) hasPixels = true;
      if (kind === 0x49454e44) {
        ended = length === 0 && offset === png.byteLength;
        break;
      }
    }
    if (!hasPixels || !ended) return yield* error("invalid-result");
    pending.delete(ticket.jobId);
    yield* Deferred.succeed(item.result, { receipt, png });
  });
  const fail = Effect.fn("CadRenderBroker.fail")(function* (ticket: CadRenderTicket) {
    const item = yield* lookup(ticket);
    pending.delete(ticket.jobId);
    yield* Deferred.fail(item.result, error("unavailable"));
  });
  return CadRenderBroker.of({ connect, capture, readJob, readAsset, complete, fail });
});
export const layer = Layer.effect(CadRenderBroker, make);
