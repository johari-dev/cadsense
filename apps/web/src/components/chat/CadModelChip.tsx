import { CubeIcon } from "~/lib/icons";
import { singleCadModelName } from "~/cad/cadModelName";
import { useModelThumbnail } from "~/cad/modelThumbnails";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { Project } from "~/types";

/**
 * The chat's CAD model in the header while the CAD panel is closed: its thumbnail and "Open
 * model", with the file name and how long ago it was imported in the tooltip. Clicking it opens
 * the panel. The composer's first row (ComposerCadContext) names the file, so the header does
 * not repeat it.
 */
export function CadModelChip({
  project,
  onOpen,
}: {
  readonly project: Project;
  readonly onOpen: () => void;
}) {
  const current = project.cad?.roots.filter((root) => root.current) ?? [];
  const snapshot = current.length === 1 ? current[0]!.current : null;
  const thumbnail = useModelThumbnail(project.environmentId, snapshot?.snapshotId).url;
  const name =
    project.localCadSource?.filePath.split(/[\\/]/).at(-1) ??
    singleCadModelName(project.cad) ??
    "CAD model";
  const synced = snapshot ? formatRelativeTimeLabel(snapshot.createdAt) : "";

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open CAD"
      title={
        synced
          ? `Open ${name} in the CAD panel · synced ${synced}`
          : `Open ${name} in the CAD panel`
      }
      className="flex h-7.5 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-border bg-card ps-1 pe-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-border bg-(--cad-viewport-background)">
        {thumbnail ? (
          <img src={thumbnail} alt="" className="size-full object-contain" />
        ) : (
          <CubeIcon className="size-3 text-(--accent-text)" />
        )}
      </span>
      <span className="font-medium text-[13px] text-foreground">Open model</span>
    </button>
  );
}

/**
 * The composer's top row for a CAD project: the model the next message is about, with its
 * thumbnail, file name, and how long ago it was imported. A label, not a control; the header's
 * CadModelChip opens the model.
 */
export function ComposerCadContext({ project }: { readonly project: Project }) {
  const current = project.cad?.roots.filter((root) => root.current) ?? [];
  const snapshot = current.length === 1 ? current[0]!.current : null;
  const thumbnail = useModelThumbnail(project.environmentId, snapshot?.snapshotId).url;
  const name =
    project.localCadSource?.filePath.split(/[\\/]/).at(-1) ?? singleCadModelName(project.cad);
  if (!name) return null;
  const synced = snapshot ? formatRelativeTimeLabel(snapshot.createdAt) : "";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return (
    <span
      title={`Messages here are about ${name}`}
      className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs"
    >
      <span className="flex size-4.5 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-border bg-(--cad-viewport-background)">
        {thumbnail ? (
          <img src={thumbnail} alt="" className="size-full object-contain" />
        ) : (
          <CubeIcon aria-hidden="true" className="size-3 text-(--accent-text)" />
        )}
      </span>
      {/* When space runs out the stem truncates and the extension stays: "bracket-assem….step". */}
      <span className="flex min-w-0 font-medium text-foreground/85">
        <span className="truncate">{stem}</span>
        <span className="shrink-0">{extension}</span>
      </span>
      {synced ? <span className="shrink-0 text-tertiary-foreground">· synced {synced}</span> : null}
    </span>
  );
}
