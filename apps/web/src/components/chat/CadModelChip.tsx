import { CubeIcon } from "~/lib/icons";
import { singleCadModelName } from "~/cad/cadModelName";
import { useModelThumbnail } from "~/cad/modelThumbnails";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { Project } from "~/types";

/**
 * The chat's CAD model in the header while the CAD panel is closed: its thumbnail, file name, and
 * "Open model" on one line, with how long ago it was imported in the tooltip. Clicking it opens
 * the panel. The chat is about this model,
 * so the header names it rather than offering a generic "Open" button.
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
      className="flex h-7.5 max-w-80 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-border bg-card ps-1 pe-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-border bg-(--cad-viewport-background)">
        {thumbnail ? (
          <img src={thumbnail} alt="" className="size-full object-contain" />
        ) : (
          <CubeIcon className="size-3 text-(--accent-text)" />
        )}
      </span>
      <span className="truncate font-medium text-[13px] text-foreground">{name}</span>
      <span className="shrink-0 text-foreground/80 text-xs">Open model</span>
    </button>
  );
}

/**
 * The model the agent works on, in the composer's footer: the CAD file a message is about. It
 * is a label, not a control; the header's CadModelChip opens the model. A compact footer (the
 * chat beside the CAD panel) shows a middle-cut name (index.css).
 */
export function ComposerCadContext({ project }: { readonly project: Project }) {
  const name =
    project.localCadSource?.filePath.split(/[\\/]/).at(-1) ?? singleCadModelName(project.cad);
  if (!name) return null;
  return (
    <span
      title={`Messages here are about ${name}`}
      className="flex h-6 min-w-0 max-w-56 items-center gap-1.5 rounded-md border border-border bg-foreground/[0.04] px-2 font-medium text-muted-foreground text-xs"
    >
      <CubeIcon aria-hidden="true" className="size-3.5 shrink-0 text-(--accent-text)" />
      <span data-composer-cad-name="full" className="truncate">
        {name}
      </span>
      {/* The compact footer cuts the name in the middle, keeping its start, last letter, and
          extension: "bracket-a…y.step". */}
      <span data-composer-cad-name="short" className="hidden">
        {shortenMiddle(name)}
      </span>
    </span>
  );
}

/** A file name cut in the middle: "bracket-assembly.step" -> "bracket-a…y.step". */
function shortenMiddle(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.length > 12 ? `${stem.slice(0, 9)}…${stem.slice(-1)}${extension}` : name;
}
