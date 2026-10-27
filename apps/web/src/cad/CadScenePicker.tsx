import { CaretDownIcon as ChevronDown } from "~/lib/icons";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { readLocalApi } from "../localApi";
import { toastManager } from "../components/ui/toast";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

export function CadScenePicker({
  scenes,
  selectedId,
  disabled,
  onSelect,
  documentUrl,
  openFile,
}: {
  scenes: ReadonlyArray<{ id: string; label: string }>;
  selectedId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  documentUrl?: string | undefined;
  /** A local CAD file's counterpart to the Onshape link: opens the shown file in its own app. */
  openFile?: { action: string; onOpen: () => void } | undefined;
}) {
  const onlyScene = scenes.length === 1 ? scenes[0] : undefined;
  const selected = scenes.find((scene) => scene.id === selectedId);
  const label = onlyScene?.label ?? selected?.label ?? "CAD";
  // The document's source leads its name ("Onshape / [SUS] Cascade"), so an Onshape element
  // or file name reads as a document rather than raw data.
  const source = documentUrl ? "Onshape" : openFile ? "File" : null;
  const labelWithSource = source ? (
    <>
      {source}
      <span aria-hidden className="px-1 text-tertiary-foreground">
        /
      </span>
      {label}
    </>
  ) : (
    label
  );
  const heading = documentUrl ? (
    <a
      href={documentUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="min-w-0 flex-1 truncate rounded-sm py-2 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={(event) => {
        const api = readLocalApi();
        if (!api) return;
        event.preventDefault();
        void api.shell.openExternal(documentUrl).catch(() => {
          toastManager.add({
            type: "error",
            title: "Could not open Onshape",
            description: "Try opening the link in your browser.",
          });
        });
      }}
    >
      {labelWithSource}
    </a>
  ) : openFile ? (
    <button
      type="button"
      className="min-w-0 flex-1 truncate rounded-sm py-2 text-left text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={openFile.onOpen}
    >
      {labelWithSource}
    </button>
  ) : (
    <h2 className="min-w-0 flex-1 truncate py-2 text-xs font-normal text-muted-foreground">
      {label}
    </h2>
  );
  const action = documentUrl ? "Open in Onshape" : openFile?.action;
  if (scenes.length === 0 || onlyScene) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Tooltip>
          <TooltipTrigger render={heading} />
          <TooltipPopup>{action ? `${label} · ${action}` : label}</TooltipPopup>
        </Tooltip>
        {onlyScene && selectedId !== onlyScene.id && (
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onSelect(onlyScene.id)}
          >
            View CAD
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      {action && (
        <Tooltip>
          <TooltipTrigger render={heading} />
          <TooltipPopup>
            {label} · {action}
          </TooltipPopup>
        </Tooltip>
      )}
      <Select
        value={selected?.id ?? null}
        disabled={disabled}
        onValueChange={(value) => {
          if (value && value !== selectedId) onSelect(value);
        }}
      >
        <SelectTrigger
          aria-label="CAD scene"
          className={
            action ? "w-9 shrink-0 justify-center px-2" : "w-full min-w-0 gap-3 px-3 py-2 text-sm"
          }
          icon={<ChevronDown className="size-4 shrink-0 opacity-60" />}
        >
          <SelectValue className={action ? "sr-only" : undefined}>
            {selected?.label ?? "Select CAD"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {scenes.map((scene) => (
            <SelectItem key={scene.id} value={scene.id}>
              {scene.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
