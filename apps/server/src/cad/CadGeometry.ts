import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { validateBytes } from "gltf-validator";

const MAX_BYTES = 128 * 1024 * 1024;
const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
const isObject = Schema.is(ObjectValue);
const BufferDefinition = Schema.Struct({
  byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
  uri: Schema.optionalKey(Schema.String),
});
const BufferView = Schema.Struct({
  buffer: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  byteOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
});
const Document = Schema.Struct({
  asset: Schema.Struct({ version: Schema.Literal("2.0") }),
  extensionsRequired: Schema.optionalKey(Schema.Array(Schema.String)),
  buffers: Schema.optionalKey(Schema.Array(BufferDefinition)),
  bufferViews: Schema.optionalKey(Schema.Array(BufferView)),
});
const jsonCodec = Schema.fromJsonString(ObjectValue);
const decodeJson = Schema.decodeUnknownEffect(jsonCodec);
const encodeJson = Schema.encodeEffect(jsonCodec);
const decodeDocument = Schema.decodeUnknownEffect(Document);
const decodeObjects = Schema.decodeUnknownEffect(Schema.Array(ObjectValue));
const decodeValidation = Schema.decodeUnknownEffect(
  Schema.Struct({
    issues: Schema.Struct({
      numErrors: Schema.Int,
      truncated: Schema.Boolean,
      messages: Schema.Array(Schema.Struct({ code: Schema.String })),
    }),
  }),
);
const align = (length: number) => Math.ceil(length / 4) * 4;

export class CadGeometryError extends Schema.TaggedErrorClass<CadGeometryError>()(
  "CadGeometryError",
  { reason: Schema.Literals(["invalid-geometry", "external-resource", "too-large"]) },
) {}
const invalid = () => new CadGeometryError({ reason: "invalid-geometry" });
const isGeometryError = Schema.is(CadGeometryError);

const embeddedBytes = (uri: string): Uint8Array => {
  const match =
    /^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/.exec(
      uri,
    );
  if (!match) throw new CadGeometryError({ reason: "external-resource" });
  const payload = match[1]!;
  if (payload.length % 4 !== 0) throw invalid();
  const bytes = Buffer.from(payload, "base64");
  if (bytes.toString("base64") !== payload) throw invalid();
  return bytes;
};

/** Produces a self-contained GLB; no geometry loader can trigger an implicit remote request. */
export const normalizeCadGeometry = Effect.fn("normalizeCadGeometry")(function* (
  input: Uint8Array,
) {
  if (input.byteLength > MAX_BYTES) return yield* new CadGeometryError({ reason: "too-large" });
  const container = yield* Effect.try({
    try: () => {
      const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
      if (input.byteLength < 4 || view.getUint32(0, true) !== 0x46546c67) {
        return { json: new TextDecoder("utf-8", { fatal: true }).decode(input), bin: null };
      }
      if (
        input.byteLength < 20 ||
        view.getUint32(4, true) !== 2 ||
        view.getUint32(8, true) !== input.byteLength
      )
        throw invalid();
      let json: string | null = null;
      let bin: Uint8Array | null = null;
      for (let offset = 12, index = 0; offset < input.byteLength; index++) {
        if (offset + 8 > input.byteLength) throw invalid();
        const length = view.getUint32(offset, true);
        const type = view.getUint32(offset + 4, true);
        if (length % 4 !== 0 || offset + 8 + length > input.byteLength) throw invalid();
        const chunk = input.subarray(offset + 8, offset + 8 + length);
        if (index === 0 && type !== 0x4e4f534a) throw invalid();
        if (type === 0x4e4f534a) {
          if (index !== 0) throw invalid();
          json = new TextDecoder("utf-8", { fatal: true }).decode(chunk);
        } else if (type === 0x004e4942) {
          if (index !== 1) throw invalid();
          bin = chunk;
        }
        offset += 8 + length;
      }
      if (json === null) throw invalid();
      return { json, bin };
    },
    catch: invalid,
  });
  const raw = yield* decodeJson(container.json).pipe(Effect.mapError(invalid));
  const document = yield* decodeDocument(raw).pipe(Effect.mapError(invalid));
  if (
    document.extensionsRequired?.some(
      (name) => name !== "KHR_mesh_quantization" && name !== "KHR_materials_unlit",
    )
  )
    return yield* invalid();
  const normalized = yield* Effect.try({
    try: () => {
      // Resource URIs can also occur inside extensions; inspect them without interpreting geometry.
      const pending: unknown[] = [raw];
      while (pending.length > 0) {
        const value = pending.pop();
        if (Array.isArray(value)) {
          for (const child of value) pending.push(child);
        } else if (isObject(value)) {
          for (const [key, child] of Object.entries(value)) {
            if (
              key === "EXT_meshopt_compression" ||
              key === "KHR_draco_mesh_compression" ||
              key === "EXT_mesh_gpu_instancing"
            )
              throw invalid();
            if (key === "uri") {
              if (typeof child !== "string") throw invalid();
              embeddedBytes(child);
            } else pending.push(child);
          }
        }
      }
      const offsets: number[] = [];
      const buffers: Uint8Array[] = [];
      let length = 0;
      for (const [index, buffer] of (document.buffers ?? []).entries()) {
        const bytes =
          buffer.uri === undefined
            ? index === 0
              ? container.bin
              : null
            : embeddedBytes(buffer.uri);
        if (
          !bytes ||
          bytes.byteLength < buffer.byteLength ||
          bytes.byteLength > buffer.byteLength + (buffer.uri === undefined ? 3 : 0)
        )
          throw invalid();
        offsets.push(length);
        buffers.push(bytes.subarray(0, buffer.byteLength));
        length += align(buffer.byteLength);
        if (length > MAX_BYTES) throw new CadGeometryError({ reason: "too-large" });
      }
      const bin = new Uint8Array(length);
      buffers.forEach((buffer, index) => bin.set(buffer, offsets[index]));
      return { bin, offsets };
    },
    catch: (error) => (isGeometryError(error) ? error : invalid()),
  });
  const rawViews = yield* decodeObjects(raw.bufferViews ?? []).pipe(Effect.mapError(invalid));
  const views: Record<string, unknown>[] = [];
  for (const [index, view] of (document.bufferViews ?? []).entries()) {
    const buffer = document.buffers?.[view.buffer];
    const base = normalized.offsets[view.buffer];
    if (
      !buffer ||
      base === undefined ||
      (view.byteOffset ?? 0) + view.byteLength > buffer.byteLength
    )
      return yield* invalid();
    views.push({ ...rawViews[index], buffer: 0, byteOffset: base + (view.byteOffset ?? 0) });
  }
  const json = new TextEncoder().encode(
    yield* encodeJson({
      ...raw,
      ...(normalized.bin.byteLength > 0
        ? { buffers: [{ byteLength: normalized.bin.byteLength }] }
        : {}),
      ...(raw.bufferViews !== undefined ? { bufferViews: views } : {}),
    }).pipe(Effect.mapError(invalid)),
  );
  const jsonLength = align(json.byteLength);
  const total =
    20 + jsonLength + (normalized.bin.byteLength > 0 ? 8 + normalized.bin.byteLength : 0);
  if (total > MAX_BYTES) return yield* new CadGeometryError({ reason: "too-large" });
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(json, 20);
  if (normalized.bin.byteLength > 0) {
    view.setUint32(20 + jsonLength, normalized.bin.byteLength, true);
    view.setUint32(24 + jsonLength, 0x004e4942, true);
    output.set(normalized.bin, 28 + jsonLength);
  }
  const report = yield* Effect.tryPromise({
    try: () =>
      validateBytes(output, {
        maxIssues: 32,
        externalResourceFunction: () =>
          Promise.reject(new Error("External CAD resource unavailable")),
      }),
    catch: invalid,
  }).pipe(Effect.flatMap(decodeValidation), Effect.mapError(invalid));
  if (report.issues.numErrors > 0 || report.issues.truncated) return yield* invalid();
  return output;
});
