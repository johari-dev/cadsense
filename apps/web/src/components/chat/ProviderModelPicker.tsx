// Provider submenu structure adapted from Synara. See THIRD_PARTY_NOTICES/Synara.txt.
import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@cadsense/contracts";
import { memo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { Badge } from "../ui/badge";
import { buttonVariants } from "../ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuItem,
  MenuSeparator,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { PlusIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { isProviderInstancePickerReady } from "../../providerInstances";
import { ProviderModelSubmenu } from "./ProviderModelSubmenu";

import {
  ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import { type ProviderInstanceEntry } from "../../providerInstances";
import { ComposerControl, ComposerControlChevron } from "./ComposerControl";

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  /**
   * The instance currently selected in the composer. Drives the trigger
   * icon, label and the default-highlighted combobox row.
   */
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** Configured instances, displayed as provider submenu triggers. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  triggerAriaLabel?: string;
  onOpenChange?: (open: boolean) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;

  const activeEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.activeInstanceId,
  );
  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  const selectedModel =
    selectedInstanceOptions.find((option) => option.slug === props.model) ??
    selectedInstanceOptions[0];
  const triggerTitle = selectedModel ? getTriggerDisplayModelName(selectedModel) : props.model;
  const triggerLabel = selectedModel
    ? `${getTriggerDisplayModelLabel(selectedModel)}${selectedModel.isUnavailable ? " (Unavailable)" : ""}`
    : props.model;

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <ComposerControl
            aria-label={props.triggerAriaLabel ?? "Choose model"}
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-between whitespace-nowrap",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {activeEntry ? (
            <ProviderInstanceIcon
              driverKind={activeEntry.driverKind}
              displayName={activeEntry.displayName}
              className="size-4"
              iconClassName={cn("size-4", props.activeProviderIconClassName)}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 overflow-hidden truncate" />}>
              {triggerTitle}
            </TooltipTrigger>
            <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
          </Tooltip>
          {selectedModel?.isUnavailable ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
        </span>
        <span aria-hidden="true" className="flex items-center">
          <ComposerControlChevron />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" side="top" sideOffset={8} className="composer-model-menu w-48">
        {props.instanceEntries
          .filter(
            (entry) =>
              !props.lockedProvider ||
              (entry.driverKind === props.lockedProvider &&
                (!props.lockedContinuationGroupKey ||
                  entry.continuationGroupKey === props.lockedContinuationGroupKey)),
          )
          .map((entry) => {
            const icon = (
              <ProviderInstanceIcon
                driverKind={entry.driverKind}
                displayName={entry.displayName}
                className="size-3.5"
                iconClassName="size-3.5"
              />
            );
            if (!isProviderInstancePickerReady(entry))
              return (
                <MenuItem key={entry.instanceId} disabled>
                  {icon}
                  <span className="truncate">{entry.displayName}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">Unavailable</span>
                </MenuItem>
              );
            return (
              <MenuSub key={entry.instanceId}>
                <MenuSubTrigger>
                  {icon}
                  <span className="truncate">{entry.displayName}</span>
                </MenuSubTrigger>
                <MenuSubPopup sideOffset={6} alignOffset={-4} className="composer-model-menu w-64">
                  <ProviderModelSubmenu
                    keybindings={props.keybindings}
                    entry={entry}
                    models={props.modelOptionsByInstance.get(entry.instanceId) ?? []}
                    activeInstanceId={activeInstanceId}
                    model={props.model}
                    getModelDisabledReason={props.getModelDisabledReason}
                    onSelect={handleInstanceModelChange}
                  />
                </MenuSubPopup>
              </MenuSub>
            );
          })}
        <MenuSeparator />
        <MenuItem render={<Link to="/settings/providers" />} onClick={() => setIsMenuOpen(false)}>
          <PlusIcon className="size-3.5" />
          Add providers
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
