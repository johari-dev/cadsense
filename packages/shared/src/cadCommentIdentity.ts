import type { CadSnapshotManifest } from "@cadsense/contracts";
/** Explicit JSON ordering; no lossy coordinate rounding or configuration normalization. */
export const canonicalCadJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalCadJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalCadJson(v)}`)
    .join(",")}}`;
};
export const cadCommentModelDescriptor = (m: CadSnapshotManifest) =>
  canonicalCadJson({
    version: "comment-model-v1",
    rootId: m.rootId,
    root: {
      host: m.root.host,
      documentId: m.root.documentId,
      elementId: m.root.elementId,
      kind: m.root.kind,
      microversionId: m.root.microversionId,
      configuration: m.root.configuration,
      tessellationProfile: m.root.tessellationProfile,
    },
    nodes: [...m.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    parts: [...m.parts].sort((a, b) => a.geometryKey.localeCompare(b.geometryKey)),
    dependencies: [...m.dependencies].sort((a, b) => {
      const x = canonicalCadJson(a),
        y = canonicalCadJson(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }),
    assets: [...m.assets]
      .sort((a, b) => a.geometryKey.localeCompare(b.geometryKey))
      .map((a) => ({ geometryKey: a.geometryKey, sha256: a.sha256, format: a.format })),
  });
