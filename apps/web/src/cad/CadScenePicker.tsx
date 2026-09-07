import { ChevronDown } from "lucide-react";
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
}: {
  scenes: ReadonlyArray<{ id: string; label: string }>;
  selectedId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  documentUrl?: string | undefined;
}) {
  const onlyScene = scenes.length === 1 ? scenes[0] : undefined;
  const selected = scenes.find((scene) => scene.id === selectedId);
  const label = onlyScene?.label ?? selected?.label ?? "CAD";
  const heading = documentUrl ? (
    <a
      href={documentUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="min-w-0 flex-1 truncate rounded-sm py-2 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
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
      {label}
    </a>
  ) : (
    <h2 className="min-w-0 flex-1 truncate py-2 text-sm font-medium">{label}</h2>
  );
  if (scenes.length === 0 || onlyScene) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Tooltip>
          <TooltipTrigger render={heading} />
          <TooltipPopup>{documentUrl ? `${label} · Open in Onshape` : label}</TooltipPopup>
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
      {documentUrl && (
        <Tooltip>
          <TooltipTrigger render={heading} />
          <TooltipPopup>{label} · Open in Onshape</TooltipPopup>
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
            documentUrl
              ? "w-9 shrink-0 justify-center px-2"
              : "w-full min-w-0 gap-3 px-3 py-2 text-sm"
          }
          icon={<ChevronDown className="size-4 shrink-0 opacity-60" />}
        >
          <SelectValue className={documentUrl ? "sr-only" : undefined}>
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
