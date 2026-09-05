import type { OnshapeProjectSource } from "@cadsense/contracts";

/** Reconstructs the immutable CAD source without exposing its managed workspace. */
export function onshapeProjectUrl(source: OnshapeProjectSource): string {
  const element = source.elementId ? `/e/${source.elementId}` : "";
  const url = new URL(
    `/documents/${source.documentId}/${source.workspaceType}/${source.workspaceId}${element}`,
    source.host,
  );
  if (source.configuration) url.searchParams.set("configuration", source.configuration);
  return url.href;
}
