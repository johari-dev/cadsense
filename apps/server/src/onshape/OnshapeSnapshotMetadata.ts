import {
  OnshapeWorkspaceId,
  type CadPartStudioSource,
  type CadSnapshotDraft,
  type CadSnapshotRoot,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ONSHAPE_API_BASE_PATH } from "./OnshapeApiPolicy.ts";
import { enrichSnapshotMetadata, snapshotPartStudioGroups } from "./OnshapeSnapshotManifest.ts";

const decodeMicroversion = Schema.decodeUnknownEffect(
  Schema.Struct({ microversion: OnshapeWorkspaceId }),
);
const decodeMetadataProof = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ microversionId: Schema.optionalKey(OnshapeWorkspaceId) })),
);
export class OnshapeSnapshotAcquisitionError extends Schema.TaggedErrorClass<OnshapeSnapshotAcquisitionError>()(
  "OnshapeSnapshotAcquisitionError",
  {
    reason: Schema.Literals(["invalid-response", "missing-linked-version", "identity-unavailable"]),
  },
) {}

export const onshapePartStudioRequest = Effect.fn(function* (
  root: CadSnapshotRoot,
  part: CadPartStudioSource,
) {
  const linked = part.documentId !== root.documentId;
  if (linked && part.documentVersion === null)
    return yield* new OnshapeSnapshotAcquisitionError({ reason: "missing-linked-version" });
  const query = new URLSearchParams({
    configuration: part.fullConfiguration || part.configuration || "default",
  });
  if (linked) query.set("linkDocumentId", root.documentId);
  return {
    path: `${ONSHAPE_API_BASE_PATH}/parts/d/${part.documentId}/${linked ? "v" : "m"}/${linked ? part.documentVersion : part.documentMicroversion}/e/${part.elementId}`,
    query,
  };
});

/** Read once per immutable Part Studio/configuration, verifying linked version identity. */
export const acquireSnapshotMetadata = <E, R>(
  draft: CadSnapshotDraft,
  read: (path: string, query?: string) => Effect.Effect<unknown, E, R>,
) =>
  Effect.gen(function* () {
    const { root } = draft;
    const groups = [];
    const verifiedVersions = new Map<string, string>();
    for (const group of snapshotPartStudioGroups(draft)) {
      const request = yield* onshapePartStudioRequest(root, group.source);
      request.query.set("withThumbnails", "false");
      request.query.set("includePropertyDefaults", "false");
      const response = yield* read(request.path, request.query.toString());
      if (group.source.documentId !== root.documentId) {
        const proof = yield* decodeMetadataProof(response).pipe(
          Effect.mapError(
            () => new OnshapeSnapshotAcquisitionError({ reason: "invalid-response" }),
          ),
        );
        if (proof.length === 0 || proof.some((row) => row.microversionId === undefined)) {
          const key = `${group.source.documentId}/${group.source.documentVersion}`;
          let resolved = verifiedVersions.get(key);
          if (resolved === undefined) {
            resolved = (yield* read(
              `${ONSHAPE_API_BASE_PATH}/documents/d/${group.source.documentId}/v/${group.source.documentVersion}/currentmicroversion`,
            ).pipe(
              Effect.flatMap(decodeMicroversion),
              Effect.catchTag("SchemaError", () =>
                Effect.fail(new OnshapeSnapshotAcquisitionError({ reason: "invalid-response" })),
              ),
            )).microversion;
            verifiedVersions.set(key, resolved);
          }
          if (resolved !== group.source.documentMicroversion)
            return yield* new OnshapeSnapshotAcquisitionError({ reason: "invalid-response" });
        }
      }
      groups.push({ source: group.source, response });
    }
    return yield* enrichSnapshotMetadata(draft, groups);
  });
