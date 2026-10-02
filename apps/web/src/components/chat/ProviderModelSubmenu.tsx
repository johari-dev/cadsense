// Adapted from Synara's ProviderModelMenuItems and ProviderModelOptionGroupList.
// See THIRD_PARTY_NOTICES/Synara.txt.
import { useEffect, useMemo, useState } from "react";
import { CheckIcon, MagnifyingGlassIcon, StarIcon } from "@phosphor-icons/react";
import { resolveSelectableModel } from "@cadsense/shared/model";
import type { ProviderInstanceId, ResolvedKeybindingsConfig } from "@cadsense/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { modelPickerJumpIndexFromCommand, resolveShortcutCommand } from "../../keybindings";
import { MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";

export function ProviderModelSubmenu(props: {
  entry: ProviderInstanceEntry;
  models: ReadonlyArray<ModelEsque>;
  activeInstanceId: ProviderInstanceId;
  model: string;
  keybindings?: ResolvedKeybindingsConfig | undefined;
  getModelDisabledReason?:
    | ((instanceId: ProviderInstanceId, model: string) => string | null)
    | undefined;
  onSelect: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const [query, setQuery] = useState("");
  const favorites = useClientSettings((settings) => settings.favorites ?? []);
  const updateSettings = useUpdateClientSettings();
  const favoriteSlugs = useMemo(
    () =>
      new Set(
        favorites
          .filter((favorite) => favorite.provider === props.entry.instanceId)
          .map((favorite) => favorite.model),
      ),
    [favorites, props.entry.instanceId],
  );
  const models = props.models
    .filter((model) =>
      `${model.name} ${model.slug} ${model.subProvider ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .toSorted((a, b) => Number(favoriteSlugs.has(b.slug)) - Number(favoriteSlugs.has(a.slug)));
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, props.keybindings ?? [], {
        platform: navigator.platform,
        context: { modelPickerOpen: true },
      });
      const index = modelPickerJumpIndexFromCommand(command ?? "");
      if (index === null) return;
      const target = models.filter(
        (model) => !props.getModelDisabledReason?.(props.entry.instanceId, model.slug),
      )[index];
      if (!target) return;
      const resolved = resolveSelectableModel(props.entry.driverKind, target.slug, props.models);
      if (!resolved) return;
      event.preventDefault();
      event.stopPropagation();
      props.onSelect(props.entry.instanceId, resolved);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [models, props]);
  return (
    <div data-model-picker-content>
      {props.models.length >= 8 ? (
        <div className="mb-1 flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
          <MagnifyingGlassIcon className="size-3.5 text-muted-foreground" />
          <input
            aria-label="Search models"
            placeholder="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                event.currentTarget
                  .closest("[data-model-picker-content]")
                  ?.querySelector<HTMLElement>('[role="menuitemradio"]:not([aria-disabled="true"])')
                  ?.focus();
              }
              if (!["Escape", "ArrowLeft", "Tab"].includes(event.key)) event.stopPropagation();
            }}
          />
        </div>
      ) : null}
      <MenuRadioGroup
        value={props.activeInstanceId === props.entry.instanceId ? props.model : ""}
        onValueChange={(slug) => {
          if (props.getModelDisabledReason?.(props.entry.instanceId, slug)) return;
          const resolved = resolveSelectableModel(props.entry.driverKind, slug, props.models);
          if (resolved) props.onSelect(props.entry.instanceId, resolved);
        }}
      >
        <div className="max-h-[min(320px,55dvh)] overflow-y-auto overscroll-contain">
          {models.map((model) => {
            const reason = props.getModelDisabledReason?.(props.entry.instanceId, model.slug);
            const favorite = favoriteSlugs.has(model.slug);
            const selected =
              props.activeInstanceId === props.entry.instanceId && props.model === model.slug;
            return (
              <MenuRadioItem
                key={model.slug}
                value={model.slug}
                disabled={Boolean(reason)}
                title={reason ?? undefined}
                className="group rounded-[10px] px-2 py-1.5 text-xs font-normal sm:text-xs"
              >
                <span className="flex items-center gap-2">
                  <ProviderInstanceIcon
                    driverKind={props.entry.driverKind}
                    displayName={props.entry.displayName}
                    className="size-3.5"
                    iconClassName="size-3.5"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {getDisplayModelName(model)}
                    {model.isUnavailable ? " (Unavailable)" : ""}
                  </span>
                  {selected ? <CheckIcon className="size-3.5" /> : null}
                  <button
                    type="button"
                    aria-label={`${favorite ? "Unfavorite" : "Favorite"} ${model.name}`}
                    className="rounded p-1 text-muted-foreground opacity-50 hover:text-foreground hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      updateSettings({
                        favorites: favorite
                          ? favorites.filter(
                              (item) =>
                                item.provider !== props.entry.instanceId ||
                                item.model !== model.slug,
                            )
                          : [...favorites, { provider: props.entry.instanceId, model: model.slug }],
                      });
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <StarIcon className="size-3" weight={favorite ? "fill" : "regular"} />
                  </button>
                </span>
              </MenuRadioItem>
            );
          })}
          {models.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">No matching models</div>
          ) : null}
        </div>
      </MenuRadioGroup>
    </div>
  );
}
