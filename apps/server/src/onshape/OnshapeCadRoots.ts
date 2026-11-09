import * as NodeCrypto from "node:crypto";
import {
  OnshapeElementId,
  type OnshapeConnectionError,
  type OnshapeProjectSource,
  OnshapeWorkspaceId,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { OnshapeConnections } from "./OnshapeConnections.ts";
import { OnshapeRecentElements } from "./OnshapeRecentElements.ts";
import { ONSHAPE_API_BASE_PATH } from "./OnshapeApiPolicy.ts";

const MicroversionResponse = Schema.Struct({ microversion: OnshapeWorkspaceId });
const ElementsResponse = Schema.Array(
  Schema.Struct({
    id: OnshapeElementId,
    name: Schema.String,
    elementType: Schema.String,
    microversionId: Schema.optionalKey(OnshapeWorkspaceId),
  }),
).check(Schema.isMaxLength(10_000));
const decodeMicroversion = Schema.decodeUnknownEffect(MicroversionResponse);
const decodeElements = Schema.decodeUnknownEffect(ElementsResponse);

export interface OnshapeCadRoot {
  readonly elementId: OnshapeElementId;
  readonly name: string;
  readonly kind: "assembly" | "part-studio";
}

export interface OnshapeCadRootCatalog {
  readonly microversionId: OnshapeWorkspaceId;
  readonly roots: ReadonlyArray<OnshapeCadRoot>;
  readonly sourceElement: {
    readonly elementId: OnshapeElementId;
    readonly status: "available" | "missing" | "unsupported";
  } | null;
}

/** Contains no remote response data, which may include private document metadata. */
export class OnshapeCadRootsError extends Schema.TaggedErrorClass<OnshapeCadRootsError>()(
  "OnshapeCadRootsError",
  { reason: Schema.Literal("invalid-response") },
) {}

export class OnshapeCadRoots extends Context.Service<
  OnshapeCadRoots,
  {
    readonly discover: <E = never, R = never>(
      source: OnshapeProjectSource,
      beforeRequest?: Effect.Effect<void, E, R>,
    ) => Effect.Effect<OnshapeCadRootCatalog, OnshapeConnectionError | OnshapeCadRootsError | E, R>;
  }
>()("@cadsense/server/onshape/OnshapeCadRoots") {}

/**
 * Internal building block for an admitted, user-initiated CAD operation. Constructing
 * this layer does not contact Onshape; it is not exposed as a client or agent RPC.
 */
export const make = Effect.gen(function* () {
  const connections = yield* OnshapeConnections;
  const recent = yield* OnshapeRecentElements;
  const discover: OnshapeCadRoots["Service"]["discover"] = Effect.fn("OnshapeCadRoots.discover")(
    function* <E = never, R = never>(
      source: OnshapeProjectSource,
      beforeRequest?: Effect.Effect<void, E, R>,
    ) {
      const read = (path: string, query = "") =>
        (beforeRequest ?? Effect.void).pipe(
          Effect.andThen(
            connections.readJson({
              connectionId: source.connectionId,
              host: source.host,
              path,
              query,
            }),
          ),
        );

      const invalidResponse = () =>
        Effect.fail(new OnshapeCadRootsError({ reason: "invalid-response" }));
      // One read of the source revision lists every element with its own revision.
      const elements = yield* read(
        `${ONSHAPE_API_BASE_PATH}/documents/d/${source.documentId}/${source.workspaceType}/${source.workspaceId}/elements`,
        "withThumbnails=false",
      ).pipe(Effect.flatMap(decodeElements), Effect.catchTag("SchemaError", invalidResponse));
      const ids = new Set<OnshapeElementId>();
      for (const element of elements) {
        if (ids.has(element.id)) {
          return yield* new OnshapeCadRootsError({ reason: "invalid-response" });
        }
        ids.add(element.id);
      }
      // The first sync after discovery records this list instead of reading it again.
      if (source.workspaceType !== "m") yield* recent.remember(source, elements);

      // Nothing reads the catalog revision; it only changes with the listed elements. Like the
      // local catalog's, a workspace catalog's is a stand-in derived from element revisions.
      const revisions = elements.flatMap((element) =>
        element.microversionId === undefined ? [] : [`${element.id}:${element.microversionId}`],
      );
      const microversionId =
        source.workspaceType === "m"
          ? source.workspaceId
          : revisions.length === elements.length
            ? OnshapeWorkspaceId.make(
                NodeCrypto.createHash("sha256")
                  .update(revisions.sort().join(","))
                  .digest("hex")
                  .slice(0, 24),
              )
            : (yield* read(
                `${ONSHAPE_API_BASE_PATH}/documents/d/${source.documentId}/${source.workspaceType}/${source.workspaceId}/currentmicroversion`,
              ).pipe(
                Effect.flatMap(decodeMicroversion),
                Effect.catchTag("SchemaError", invalidResponse),
              )).microversion;

      const roots: OnshapeCadRoot[] = [];
      for (const element of elements) {
        const kind =
          element.elementType === "ASSEMBLY"
            ? "assembly"
            : element.elementType === "PARTSTUDIO"
              ? "part-studio"
              : null;
        if (kind === null) continue;
        roots.push({ elementId: element.id, name: element.name || element.id, kind });
      }
      // An element link suggests the initial selection; it does not restrict a
      // Document's catalog or silently choose a substitute when that tab is gone.
      const sourceElement: OnshapeCadRootCatalog["sourceElement"] =
        source.elementId === undefined
          ? null
          : {
              elementId: source.elementId,
              status: roots.some((root) => root.elementId === source.elementId)
                ? "available"
                : ids.has(source.elementId)
                  ? "unsupported"
                  : "missing",
            };
      return { microversionId, roots, sourceElement };
    },
  );
  return OnshapeCadRoots.of({ discover });
});

export const layer = Layer.effect(OnshapeCadRoots, make);
