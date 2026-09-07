import { ChevronDown } from "lucide-react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
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
}: {
  scenes: ReadonlyArray<{ id: string; label: string }>;
  selectedId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const onlyScene = scenes.length === 1 ? scenes[0] : undefined;
  if (scenes.length === 0 || onlyScene) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Tooltip>
          <TooltipTrigger
            render={<h2 className="min-w-0 flex-1 truncate py-2 text-sm font-medium" />}
          >
            {onlyScene?.label ?? "CAD"}
          </TooltipTrigger>
          <TooltipPopup>{onlyScene?.label ?? "CAD"}</TooltipPopup>
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
  const selected = scenes.find((scene) => scene.id === selectedId);
  return (
    <Select
      value={selected?.id ?? null}
      disabled={disabled}
      onValueChange={(value) => {
        if (value && value !== selectedId) onSelect(value);
      }}
    >
      <SelectTrigger
        aria-label="CAD scene"
        className="w-full min-w-0 gap-3 px-3 py-2 text-sm"
        icon={<ChevronDown className="size-4 shrink-0 opacity-60" />}
      >
        <SelectValue>{selected?.label ?? "Select CAD"}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {scenes.map((scene) => (
          <SelectItem key={scene.id} value={scene.id}>
            {scene.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
