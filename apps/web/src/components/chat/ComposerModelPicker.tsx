// Composer model picker: one trigger pill (provider icon, model, effort) that opens a single
// panel with provider tabs, search, model rows, and the selected model's trait rows.
// Adapted from Synara 1.0.1's ComposerModelPicker and ComposerModelMenuTrigger.
// See THIRD_PARTY_NOTICES/Synara.txt.
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ResolvedKeybindingsConfig,
} from "@cadsense/contracts";
import { resolveSelectableModel } from "@cadsense/shared/model";
import {
  CaretDownIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  StarIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";

import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  getDisplayModelName,
  getTriggerDisplayModelName,
  type ModelEsque,
} from "./providerIconUtils";

const STARRED_TAB = "starred";
type PickerTab = typeof STARRED_TAB | ProviderInstanceId;

type PickerRow = {
  entry: ProviderInstanceEntry;
  model: ModelEsque;
  starred: boolean;
  selected: boolean;
  disabledReason: string | null;
};

const JUMP_SHORTCUT_OPTIONS = { context: { modelPickerOpen: true } } as const;
const TAB_CLASS_NAME =
  "relative flex h-7.5 min-w-7.5 shrink-0 cursor-pointer items-center justify-center rounded-lg px-1.5 text-muted-foreground/70 outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60 aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent";

export const ComposerModelPicker = memo(function ComposerModelPicker(props: {
  /** The instance currently selected in the composer. */
  activeInstanceId: ProviderInstanceId;
  model: string;
  /** Set once a thread has started: only instances of this driver stay pickable. */
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  keybindings?: ResolvedKeybindingsConfig;
  /** Effort label and fast-mode state shown after the model name, or null for none. */
  traits: { label: string; showFastModeIcon: boolean } | null;
  /** Trait rows (effort, speed, ...) for the selected model, from renderProviderTraitsRows. */
  traitRows: ReactNode;
  activeProviderIconClassName?: string;
  /** Narrow composer: the effort label moves to the tooltip. */
  compact?: boolean;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledOpen;
  const setMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) setUncontrolledOpen(open);
  };

  const favorites = useClientSettings((settings) => settings.favorites ?? []);
  const updateSettings = useUpdateClientSettings();
  const isStarred = (instanceId: ProviderInstanceId, slug: string) =>
    favorites.some((favorite) => favorite.provider === instanceId && favorite.model === slug);
  const toggleStar = (instanceId: ProviderInstanceId, slug: string) =>
    updateSettings({
      favorites: isStarred(instanceId, slug)
        ? favorites.filter(
            (favorite) => favorite.provider !== instanceId || favorite.model !== slug,
          )
        : [...favorites, { provider: instanceId, model: slug }],
    });

  const entries = props.instanceEntries.filter(
    (entry) =>
      !props.lockedProvider ||
      (entry.driverKind === props.lockedProvider &&
        (!props.lockedContinuationGroupKey ||
          entry.continuationGroupKey === props.lockedContinuationGroupKey)),
  );
  const readyEntries = entries.filter(isProviderInstancePickerReady);
  const activeEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.activeInstanceId,
  );
  const activeModels = props.modelOptionsByInstance.get(props.activeInstanceId) ?? [];
  const activeModel = activeModels.find((option) => option.slug === props.model) ?? activeModels[0];

  const toRow = (entry: ProviderInstanceEntry, model: ModelEsque): PickerRow => ({
    entry,
    model,
    starred: isStarred(entry.instanceId, model.slug),
    selected: entry.instanceId === props.activeInstanceId && model.slug === props.model,
    disabledReason: props.getModelDisabledReason?.(entry.instanceId, model.slug) ?? null,
  });
  const starredRows = favorites.flatMap((favorite) => {
    const entry = readyEntries.find((candidate) => candidate.instanceId === favorite.provider);
    const model = entry
      ? props.modelOptionsByInstance.get(entry.instanceId)?.find((m) => m.slug === favorite.model)
      : undefined;
    return entry && model ? [toRow(entry, model)] : [];
  });

  // Every open starts on Starred when there is anything starred, otherwise on the
  // composer's own provider, with an empty search.
  const [tab, setTab] = useState<PickerTab>(STARRED_TAB);
  const [query, setQuery] = useState("");
  const [wasMenuOpen, setWasMenuOpen] = useState(isMenuOpen);
  if (wasMenuOpen !== isMenuOpen) {
    setWasMenuOpen(isMenuOpen);
    if (isMenuOpen) {
      const ownTab = readyEntries.some((entry) => entry.instanceId === props.activeInstanceId)
        ? props.activeInstanceId
        : (readyEntries[0]?.instanceId ?? STARRED_TAB);
      setTab(starredRows.length > 0 ? STARRED_TAB : ownTab);
      setQuery("");
    }
  }
  const tabEntry =
    tab === STARRED_TAB ? null : (readyEntries.find((entry) => entry.instanceId === tab) ?? null);
  const openTab: PickerTab = tabEntry?.instanceId ?? STARRED_TAB;

  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (row: PickerRow) =>
    normalizedQuery.length === 0 ||
    `${row.model.name} ${row.model.slug} ${row.model.subProvider ?? ""} ${tabEntry ? "" : row.entry.displayName}`
      .toLowerCase()
      .includes(normalizedQuery);
  const rows = (
    tabEntry
      ? (props.modelOptionsByInstance.get(tabEntry.instanceId) ?? []).map((model) =>
          toRow(tabEntry, model),
        )
      : starredRows
  ).filter(matchesQuery);
  // Jump shortcuts and Enter in the search field address the rows that can be picked.
  const pickableRows = rows.filter((row) => row.disabledReason === null);

  const selectRow = (row: PickerRow) => {
    if (props.disabled || row.disabledReason !== null) return;
    const resolved = resolveSelectableModel(
      row.entry.driverKind,
      row.model.slug,
      props.modelOptionsByInstance.get(row.entry.instanceId) ?? [],
    );
    if (!resolved) return;
    props.onInstanceModelChange(row.entry.instanceId, resolved);
    setMenuOpen(false);
  };

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isMenuOpen) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isMenuOpen, openTab]);

  const jumpHintFor = (row: PickerRow) => {
    const index = pickableRows.indexOf(row);
    const command = index === -1 ? null : modelPickerJumpCommandForIndex(index);
    return command && props.keybindings
      ? shortcutLabelForCommand(props.keybindings, command, JUMP_SHORTCUT_OPTIONS)
      : null;
  };

  const tabs: PickerTab[] = [STARRED_TAB, ...readyEntries.map((entry) => entry.instanceId)];
  const cycleTab = (direction: 1 | -1) => {
    const index = tabs.indexOf(openTab);
    setTab(tabs[(index + direction + tabs.length) % tabs.length] ?? STARRED_TAB);
    setQuery("");
  };

  const modelName = activeModel ? getTriggerDisplayModelName(activeModel) : props.model;
  const unavailable = activeModel?.isUnavailable ?? false;
  const triggerTitle = [modelName, unavailable ? "Unavailable" : null, props.traits?.label]
    .filter(Boolean)
    .join(" · ");

  return (
    <Menu open={isMenuOpen} onOpenChange={(open) => setMenuOpen(props.disabled ? false : open)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Change model and reasoning"
                  data-chat-provider-model-picker="true"
                  disabled={props.disabled}
                  className={cn(
                    // 28px pill with 10px side padding at the default 15px interface size.
                    "flex h-7.5 min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-full bg-foreground/[0.07] px-2.75 text-[0.8333rem] text-foreground/90 outline-none transition-colors duration-150 hover:bg-foreground/[0.11] focus-visible:ring-1 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-60 data-popup-open:bg-foreground/[0.13] data-popup-open:text-foreground motion-reduce:transition-none",
                    props.compact ? "max-w-40" : "max-w-64",
                  )}
                />
              }
            />
          }
        >
          {activeEntry ? (
            <ProviderInstanceIcon
              driverKind={activeEntry.driverKind}
              displayName={activeEntry.displayName}
              className="size-3.75"
              iconClassName={cn("size-3.75", props.activeProviderIconClassName)}
            />
          ) : null}
          <span className="min-w-0 truncate">{modelName}</span>
          {unavailable ? <span className="shrink-0 text-muted-foreground">Unavailable</span> : null}
          {props.traits?.showFastModeIcon ? (
            <>
              <LightningIcon aria-hidden="true" weight="fill" className="size-3.5 shrink-0" />
              <span className="sr-only">Fast mode on</span>
            </>
          ) : null}
          {props.traits?.label ? (
            <span className={props.compact ? "sr-only" : "shrink-0 text-muted-foreground"}>
              {props.traits.label}
            </span>
          ) : null}
          <CaretDownIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 opacity-60" />
        </TooltipTrigger>
        {isMenuOpen ? null : <TooltipPopup side="top">{triggerTitle}</TooltipPopup>}
      </Tooltip>
      <MenuPopup
        align="end"
        side="top"
        sideOffset={8}
        className="composer-model-panel w-[min(18.5rem,92vw)]"
        onKeyDownCapture={(event) => {
          // Tab walks the provider tabs instead of leaving (and closing) the menu.
          if (event.key === "Tab") {
            event.preventDefault();
            event.stopPropagation();
            cycleTab(event.shiftKey ? -1 : 1);
            return;
          }
          // mod+1...9 picks a row. Focus stays inside the panel while it is open, and the
          // sidebar yields the chord to us because of data-model-picker-content below.
          if (event.repeat) return;
          const command = resolveShortcutCommand(event.nativeEvent, props.keybindings ?? [], {
            platform: navigator.platform,
            ...JUMP_SHORTCUT_OPTIONS,
          });
          const index = modelPickerJumpIndexFromCommand(command ?? "");
          const row = index === null ? undefined : pickableRows[index];
          if (!row) return;
          event.preventDefault();
          event.stopPropagation();
          selectRow(row);
        }}
      >
        {/* -m-1 bleeds over the popup body padding so the dividers run edge to edge.
            data-model-picker-content tells the sidebar to yield mod+1...9 (modelPickerVisibility.ts). */}
        <div data-model-picker-content className="-m-1 flex flex-col">
          <div
            role="tablist"
            aria-label="Model sources"
            className="flex shrink-0 items-center gap-0.5 border-b border-border px-1.5 pt-1.5 pb-[7px]"
          >
            <PickerTabButton
              label="Starred"
              active={openTab === STARRED_TAB}
              onSelect={() => {
                setTab(STARRED_TAB);
                setQuery("");
              }}
            >
              <StarIcon aria-hidden="true" weight="fill" className="size-3.5" />
            </PickerTabButton>
            {entries.map((entry) => {
              const ready = isProviderInstancePickerReady(entry);
              return (
                <PickerTabButton
                  key={entry.instanceId}
                  label={ready ? entry.displayName : `${entry.displayName} is unavailable`}
                  active={openTab === entry.instanceId}
                  disabled={!ready}
                  onSelect={() => {
                    setTab(entry.instanceId);
                    setQuery("");
                  }}
                >
                  <ProviderInstanceIcon
                    driverKind={entry.driverKind}
                    displayName={entry.displayName}
                    className="size-4"
                    iconClassName="size-4"
                  />
                </PickerTabButton>
              );
            })}
            <span className="flex-1" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Link
                    to="/settings/providers"
                    aria-label="Add providers"
                    className={TAB_CLASS_NAME}
                    onClick={() => setMenuOpen(false)}
                  />
                }
              >
                <PlusIcon aria-hidden="true" className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Add providers</TooltipPopup>
            </Tooltip>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3">
            <MagnifyingGlassIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground/60"
            />
            <input
              ref={searchRef}
              type="text"
              aria-label="Search models"
              placeholder={tabEntry ? "Search models…" : "Search starred…"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8.5 min-w-0 flex-1 bg-transparent text-[0.8667rem] outline-none placeholder:text-muted-foreground/55"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  // No row is highlighted while typing, so Enter takes the top hit.
                  event.preventDefault();
                  event.stopPropagation();
                  const first = pickableRows[0];
                  if (first) selectRow(first);
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  event.currentTarget
                    .closest(".composer-model-panel")
                    ?.querySelector<HTMLElement>(
                      '[data-model-picker-row]:not([data-disabled]):not([aria-disabled="true"])',
                    )
                    ?.focus();
                  return;
                }
                // Keep typing out of the menu's typeahead; Escape still closes the menu.
                if (event.key !== "Escape") event.stopPropagation();
              }}
            />
          </div>
          <div
            role="tabpanel"
            className="flex max-h-[min(12.5rem,40vh)] min-h-20 flex-col gap-px overflow-y-auto overscroll-contain p-1"
          >
            {rows.map((row) => {
              const hint = jumpHintFor(row);
              return (
                <MenuItem
                  key={`${row.entry.instanceId}:${row.model.slug}`}
                  data-model-picker-row=""
                  aria-current={row.selected ? "true" : undefined}
                  disabled={row.disabledReason !== null}
                  title={row.disabledReason ?? undefined}
                  className={cn("composer-model-row group", row.selected && "bg-foreground/[0.06]")}
                  onClick={() => selectRow(row)}
                >
                  {tabEntry ? null : (
                    <ProviderInstanceIcon
                      driverKind={row.entry.driverKind}
                      displayName={row.entry.displayName}
                      className="size-3.5"
                      iconClassName="size-3.5"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {getDisplayModelName(row.model)}
                    {row.model.isUnavailable ? " (Unavailable)" : ""}
                  </span>
                  {hint ? (
                    <kbd className="h-4 shrink-0 rounded border border-border px-1 font-mono text-[10px] leading-[14px] text-muted-foreground">
                      {hint}
                    </kbd>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`${row.starred ? "Unstar" : "Star"} ${row.model.name}`}
                    aria-pressed={row.starred}
                    className={cn(
                      "-me-0.5 shrink-0 rounded p-1 text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
                      row.starred ? "opacity-90" : "opacity-40",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleStar(row.entry.instanceId, row.model.slug);
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <StarIcon
                      aria-hidden="true"
                      className="size-3.25"
                      weight={row.starred ? "fill" : "regular"}
                    />
                  </button>
                </MenuItem>
              );
            })}
            {rows.length === 0 ? (
              <div className="px-2 py-3 text-[0.8667rem] leading-relaxed text-muted-foreground">
                {normalizedQuery.length > 0
                  ? "No matching models"
                  : tabEntry
                    ? "No models found"
                    : "Star a model to keep it here, across every provider."}
              </div>
            ) : null}
          </div>
          {props.traitRows ? (
            <div className="flex flex-col gap-px border-t border-border p-1">{props.traitRows}</div>
          ) : null}
        </div>
      </MenuPopup>
    </Menu>
  );
});

function PickerTabButton(props: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="tab"
            aria-label={props.label}
            aria-selected={props.active}
            aria-disabled={props.disabled ?? false}
            className={cn(
              TAB_CLASS_NAME,
              props.active &&
                "text-foreground after:absolute after:inset-x-1.5 after:-bottom-[5px] after:h-0.5 after:rounded-full after:bg-foreground",
            )}
            onClick={() => {
              if (!props.disabled) props.onSelect();
            }}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
