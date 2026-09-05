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
import { ONSHAPE_API_BASE_PATH } from "./OnshapeApiPolicy.ts";

const MicroversionResponse = Schema.Struct({ microversion: OnshapeWorkspaceId });
const ElementsResponse = Schema.Array(
  Schema.Struct({
    id: OnshapeElementId,
    name: Schema.String,
    elementType: Schema.String,
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
    readonly discover: (
      source: OnshapeProjectSource,
    ) => Effect.Effect<OnshapeCadRootCatalog, OnshapeConnectionError | OnshapeCadRootsError>;
  }
>()("@cadsense/server/onshape/OnshapeCadRoots") {}

/**
 * Internal building block for an admitted, user-initiated CAD operation. Constructing
 * this layer does not contact Onshape; it is not exposed as a client or agent RPC.
 */
export const make = Effect.gen(function* () {
  const connections = yield* OnshapeConnections;
  const discover: OnshapeCadRoots["Service"]["discover"] = Effect.fn("OnshapeCadRoots.discover")(
    function* (source) {
      const read = (path: string, query = "") =>
        connections.readJson({ connectionId: source.connectionId, host: source.host, path, query });

      // Resolve once, then list at that immutable revision even if the workspace advances.
      const microversionId =
        source.workspaceType === "m"
          ? source.workspaceId
          : (yield* read(
              `${ONSHAPE_API_BASE_PATH}/documents/d/${source.documentId}/${source.workspaceType}/${source.workspaceId}/currentmicroversion`,
            ).pipe(
              Effect.flatMap(decodeMicroversion),
              Effect.catchTag("SchemaError", () =>
                Effect.fail(new OnshapeCadRootsError({ reason: "invalid-response" })),
              ),
            )).microversion;

      const elements = yield* read(
        `${ONSHAPE_API_BASE_PATH}/documents/d/${source.documentId}/m/${microversionId}/elements`,
        "withThumbnails=false",
      ).pipe(
        Effect.flatMap(decodeElements),
        Effect.catchTag("SchemaError", () =>
          Effect.fail(new OnshapeCadRootsError({ reason: "invalid-response" })),
        ),
      );

      const ids = new Set<OnshapeElementId>();
      for (const element of elements) {
        if (ids.has(element.id)) {
          return yield* new OnshapeCadRootsError({ reason: "invalid-response" });
        }
        ids.add(element.id);
      }

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
