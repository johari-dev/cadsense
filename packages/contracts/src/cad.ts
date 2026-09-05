import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt, ProjectId } from "./baseSchemas.ts";
import {
  OnshapeConnectionHost,
  OnshapeDocumentId,
  OnshapeElementId,
  OnshapeWorkspaceId,
  OnshapeWorkspaceType,
} from "./onshape.ts";

export const CadHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const CadSnapshotId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
);
export const CadRootKind = Schema.Literals(["assembly", "part-studio"]);
const Text = Schema.String.check(Schema.isMaxLength(4096));
export const CadTransform = Schema.Array(Schema.Number.check(Schema.isFinite())).check(
  Schema.isMinLength(16),
  Schema.isMaxLength(16),
);
export const CadSnapshotRoot = Schema.Struct({
  host: OnshapeConnectionHost,
  documentId: OnshapeDocumentId,
  elementId: OnshapeElementId,
  kind: CadRootKind,
  originalRevision: Schema.Struct({ kind: OnshapeWorkspaceType, id: OnshapeWorkspaceId }),
  microversionId: OnshapeWorkspaceId,
  configuration: Text,
  tessellationProfile: Text.check(Schema.isNonEmpty()),
});
export type CadSnapshotRoot = typeof CadSnapshotRoot.Type;
export const CadSnapshotContext = Schema.Struct({
  snapshotId: CadSnapshotId,
  rootId: CadHash,
  projectId: ProjectId,
  createdAt: IsoDateTime,
  root: CadSnapshotRoot,
});
export type CadSnapshotContext = typeof CadSnapshotContext.Type;

export const CadPartStudioSource = Schema.Struct({
  host: OnshapeConnectionHost,
  documentId: OnshapeDocumentId,
  documentMicroversion: OnshapeWorkspaceId,
  documentVersion: Schema.NullOr(OnshapeWorkspaceId),
  elementId: OnshapeElementId,
  configuration: Text,
  fullConfiguration: Text,
});
export type CadPartStudioSource = typeof CadPartStudioSource.Type;
export const CadPartSource = Schema.Struct({
  ...CadPartStudioSource.fields,
  partId: Text.check(Schema.isNonEmpty()),
  tessellationProfile: Text.check(Schema.isNonEmpty()),
});
export type CadPartSource = typeof CadPartSource.Type;
export const CadPartAppearance = Schema.Struct({
  color: Schema.Struct({ red: Schema.Int, green: Schema.Int, blue: Schema.Int }),
  opacity: Schema.Int,
});
const MaterialProperty = Schema.Struct({
  category: Schema.optionalKey(Text),
  description: Schema.optionalKey(Text),
  displayName: Schema.optionalKey(Text),
  name: Schema.optionalKey(Text),
  type: Schema.optionalKey(Text),
  units: Schema.optionalKey(Text),
  value: Schema.optionalKey(Text),
});
export const CadPartMaterial = Schema.Struct({
  displayName: Schema.optionalKey(Text),
  id: Schema.optionalKey(Text),
  libraryName: Schema.optionalKey(Text),
  libraryReference: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        documentId: Schema.optionalKey(Text),
        elementId: Schema.optionalKey(Text),
        elementMicroversionId: Schema.optionalKey(Text),
        versionId: Schema.optionalKey(Text),
      }),
    ),
  ),
  properties: Schema.optionalKey(Schema.Array(MaterialProperty).check(Schema.isMaxLength(1024))),
});
export const CadPartMetadata = Schema.Struct({
  name: Text,
  bodyType: Text,
  isHidden: Schema.Boolean,
  isMesh: Schema.Boolean,
  partIdentity: Schema.NullOr(Text),
  configurationId: Schema.NullOr(Text),
  appearance: Schema.NullOr(CadPartAppearance),
  material: Schema.NullOr(CadPartMaterial),
});
export type CadPartMetadata = typeof CadPartMetadata.Type;
export const CadSnapshotPart = Schema.Struct({
  geometryKey: CadHash,
  source: CadPartSource,
  geometryRequired: Schema.Boolean,
  metadata: Schema.NullOr(CadPartMetadata),
});
export type CadSnapshotPart = typeof CadSnapshotPart.Type;
export const CadSnapshotNode = Schema.Struct({
  id: CadHash,
  parentId: Schema.NullOr(CadHash),
  occurrencePath: Schema.Array(Text.check(Schema.isNonEmpty())).check(Schema.isMaxLength(128)),
  instanceId: Schema.NullOr(Text),
  name: Text,
  kind: Schema.Literals(["assembly", "part-studio", "part", "unsupported"]),
  suppressed: Schema.Boolean,
  defaultVisible: Schema.Boolean,
  transform: CadTransform,
  sourcePartKey: Schema.NullOr(CadHash),
});
export type CadSnapshotNode = typeof CadSnapshotNode.Type;
export const CadSnapshotDraft = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  ...CadSnapshotContext.fields,
  nodes: Schema.Array(CadSnapshotNode).check(Schema.isMaxLength(100_000)),
  parts: Schema.Array(CadSnapshotPart).check(Schema.isMaxLength(100_000)),
  dependencies: Schema.Array(CadPartStudioSource).check(Schema.isMaxLength(100_000)),
});
export type CadSnapshotDraft = typeof CadSnapshotDraft.Type;
export const CadGeometryAsset = Schema.Struct({
  geometryKey: CadHash,
  sha256: CadHash,
  byteLength: PositiveInt,
  format: Schema.Literal("glb"),
  relativePath: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}\.glb$/)),
});
export type CadGeometryAsset = typeof CadGeometryAsset.Type;
/** A completed manifest still requires content/hash verification by the snapshot store. */
export const CadSnapshotManifest = Schema.Struct({
  ...CadSnapshotDraft.fields,
  assets: Schema.Array(CadGeometryAsset).check(Schema.isMaxLength(100_000)),
}).check(
  Schema.makeFilter((manifest) => {
    const parts = new Map(manifest.parts.map((part) => [part.geometryKey, part]));
    const assets = new Set(manifest.assets.map((asset) => asset.geometryKey));
    return (
      parts.size === manifest.parts.length &&
      assets.size === manifest.assets.length &&
      manifest.parts.every(
        (part) =>
          !part.geometryRequired || (part.metadata !== null && assets.has(part.geometryKey)),
      ) &&
      manifest.assets.every(
        (asset) =>
          asset.relativePath === `${asset.sha256}.glb` &&
          parts.get(asset.geometryKey)?.geometryRequired === true,
      )
    );
  }),
);
export type CadSnapshotManifest = typeof CadSnapshotManifest.Type;
