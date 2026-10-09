import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@cadsense/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
} from "@cadsense/shared/model";
import { memo, useCallback, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { LightningIcon as ZapIcon } from "@phosphor-icons/react";
import { buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

const SAVED_OPTION_LABELS: Readonly<Record<string, string>> = {
  agent: "Agent",
  effort: "Effort",
  reasoningEffort: "Reasoning effort",
  variant: "Variant",
};

function savedOptionLabel(id: string): string {
  return (
    SAVED_OPTION_LABELS[id] ??
    id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase())
  );
}

/** Read-only descriptors for saved values whose model metadata is unavailable. */
export function buildUnavailableModelOptionDescriptors(
  selections: ProviderOptions | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return (selections ?? []).map((selection) =>
    typeof selection.value === "boolean"
      ? {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "boolean" as const,
          currentValue: selection.value,
        }
      : {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "select" as const,
          options: [{ id: selection.value, label: selection.value }],
          currentValue: selection.value,
        },
  );
}

type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

function DefaultBadge() {
  return (
    <Badge
      variant="outline"
      className="inline-flex h-4 w-fit min-w-0 items-center justify-center gap-0 border-border/70 bg-muted/60 px-1.5 py-0 font-semibold text-[10px] text-muted-foreground leading-none sm:h-4"
    >
      Default
    </Badge>
  );
}

function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : null;
}

function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const modelIsUnavailable = !models.some(
    (candidate) => candidate.slug === normalizeModelSlug(model, provider),
  );
  const descriptors = modelIsUnavailable
    ? buildUnavailableModelOptionDescriptors(
        modelOptions?.filter((option) => option.id !== "agent" || option.value !== "plan"),
      )
    : getProviderOptionDescriptors({
        caps,
        selections: modelOptions,
      });
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;

  // Prompt-controlled effort (e.g. ultrathink in prompt text)
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  // Check if "ultrathink" appears in the body text (not just our prefix)
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  const effort =
    (ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(primarySelectDescriptor)) ?? null;
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);
  const selectedAgent = getDescriptorStringValue(agentDescriptor);
  const selectedAgentLabel = agentDescriptor
    ? getProviderOptionCurrentLabel(agentDescriptor)
    : null;

  return {
    caps,
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    contextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    selectedAgent,
    selectedAgentLabel,
    modelIsUnavailable,
  };
}

function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.prompt,
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
  );

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null;
  const showContextWindow = selected.contextWindowDescriptor !== null;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls:
      showEffort ||
      showThinking ||
      showFastMode ||
      showContextWindow ||
      showAgent ||
      (selected.modelIsUnavailable && selected.descriptors.length > 0),
  };
}

export function shouldRenderTraitsControls(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}

// Shared state and change handlers for the traits menus: the grouped menu
// (TraitsMenuContent) and the composer model picker's submenu rows (TraitsMenuRows).
function useTraitsMenuState({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      const threadTarget = persistence.threadRef ?? persistence.draftId;
      if (!threadTarget) {
        return;
      }
      setProviderModelOptions(threadTarget, provider, nextOptions, {
        ...(instanceId ? { instanceId } : {}),
        model,
        persistSticky: true,
      });
    },
    [instanceId, model, persistence, provider, setProviderModelOptions],
  );
  const {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    hasAnyControls,
    modelIsUnavailable,
  } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  });
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const handleSelectChange = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    if (!value) return;
    if (descriptor.promptInjectedValues?.includes(value)) {
      const nextPrompt =
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink");
      onPromptChange(nextPrompt);
      return;
    }
    if (ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id) return;
    if (ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id) {
      const stripped = prompt.replace(/^Ultrathink:\s*/i, "");
      onPromptChange(stripped);
    }
    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, value));
  };

  return {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    hasAnyControls,
    modelIsUnavailable,
    handleSelectChange,
    handleBooleanChange: (
      descriptor: Extract<ProviderOptionDescriptor, { type: "boolean" }>,
      enabled: boolean,
    ) => updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, enabled)),
    // The selected value, with prompt-injected effort (Ultrathink) taking precedence.
    selectedValueFor: (descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>) =>
      ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
        ? "ultrathink"
        : (getDescriptorStringValue(descriptor) ?? ""),
    // "ultrathink" typed into the prompt body pins effort until the user removes it.
    isLockedByPromptText: (descriptor: ProviderOptionDescriptor) =>
      ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id,
  };
}

const ULTRATHINK_IN_PROMPT_NOTE =
  'Your prompt contains "ultrathink" in the text. Remove it to change this option.';

export const TraitsMenuContent = memo(function TraitsMenuContentImpl(
  props: TraitsMenuContentProps & TraitsPersistence,
) {
  const {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    hasAnyControls,
    modelIsUnavailable,
    handleSelectChange,
    handleBooleanChange,
    selectedValueFor,
    isLockedByPromptText,
  } = useTraitsMenuState(props);

  if (!hasAnyControls) {
    return null;
  }

  if (modelIsUnavailable) {
    return (
      <>
        {descriptors.map((descriptor, index) => {
          const value = getProviderOptionCurrentLabel(descriptor);
          if (!value) return null;
          return (
            <div key={descriptor.id}>
              {index > 0 ? <MenuDivider /> : null}
              <MenuGroup>
                <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                  {descriptor.label}
                </div>
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">{value}</div>
              </MenuGroup>
            </div>
          );
        })}
      </>
    );
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
              {descriptor.label}
            </div>
            <SelectTraitOptions
              descriptor={descriptor}
              value={selectedValueFor(descriptor)}
              locked={isLockedByPromptText(descriptor)}
              onValueChange={(value) => handleSelectChange(descriptor, value)}
            />
          </MenuGroup>
        </div>
      ))}
      {booleanDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              {descriptor.label}
            </div>
            <BooleanTraitOptions
              descriptor={descriptor}
              onValueChange={(enabled) => handleBooleanChange(descriptor, enabled)}
            />
          </MenuGroup>
        </div>
      ))}
    </>
  );
});

function SelectTraitOptions(props: {
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>;
  value: string;
  locked: boolean;
  onValueChange: (value: string) => void;
}) {
  return (
    <>
      {props.locked ? (
        <div className="max-w-64 px-2 pb-1.5 text-muted-foreground/80 text-xs">
          {ULTRATHINK_IN_PROMPT_NOTE}
        </div>
      ) : null}
      <MenuRadioGroup value={props.value} onValueChange={props.onValueChange}>
        {props.descriptor.options.map((option) => (
          <MenuRadioItem
            key={option.id}
            value={option.id}
            hideIndicator
            // Base UI keeps radio menus open by default. Close on pick so
            // the traits menu behaves like the model picker.
            closeOnClick
            disabled={props.locked}
          >
            <span className="flex w-full min-w-0 flex-col">
              <span className="flex w-full min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 truncate">
                  {option.label}
                  {option.isDefault ? (
                    <>
                      {" "}
                      <DefaultBadge />
                    </>
                  ) : null}
                </span>
              </span>
              {option.description ? (
                <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
                  {option.description}
                </span>
              ) : null}
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}

function BooleanTraitOptions(props: {
  descriptor: Extract<ProviderOptionDescriptor, { type: "boolean" }>;
  onValueChange: (enabled: boolean) => void;
}) {
  return (
    <MenuRadioGroup
      value={props.descriptor.currentValue === true ? "on" : "off"}
      onValueChange={(value) => props.onValueChange(value === "on")}
    >
      {(["on", "off"] as const).map((value) => (
        <MenuRadioItem key={value} value={value} hideIndicator closeOnClick>
          <span className="flex w-full min-w-0 items-center justify-between gap-3">
            <span>{value === "on" ? "On" : "Off"}</span>
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/**
 * The selected model's traits as one row each ("Effort · Medium ›") that opens its
 * options in a submenu. Rendered at the bottom of the composer model picker panel.
 */
export const TraitsMenuRows = memo(function TraitsMenuRows(
  props: TraitsMenuContentProps & TraitsPersistence,
) {
  const {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    hasAnyControls,
    modelIsUnavailable,
    handleSelectChange,
    handleBooleanChange,
    selectedValueFor,
    isLockedByPromptText,
  } = useTraitsMenuState(props);

  if (!hasAnyControls) {
    return null;
  }

  // Saved values for a model the provider no longer lists: show them, but read-only.
  if (modelIsUnavailable) {
    return descriptors.map((descriptor) => {
      const value = getProviderOptionCurrentLabel(descriptor);
      if (!value) return null;
      return (
        <MenuItem key={descriptor.id} disabled className="composer-trait-row">
          <TraitRowLabel label={descriptor.label} value={value} />
        </MenuItem>
      );
    });
  }

  return (
    <>
      {selectDescriptors.map((descriptor) => {
        const value = selectedValueFor(descriptor);
        return (
          <MenuSub key={descriptor.id}>
            <MenuSubTrigger className="composer-trait-row">
              <TraitRowLabel
                label={descriptor.label}
                value={descriptor.options.find((option) => option.id === value)?.label ?? ""}
              />
            </MenuSubTrigger>
            <MenuSubPopup sideOffset={6} className="composer-model-menu min-w-40">
              <SelectTraitOptions
                descriptor={descriptor}
                value={value}
                locked={isLockedByPromptText(descriptor)}
                onValueChange={(next) => handleSelectChange(descriptor, next)}
              />
            </MenuSubPopup>
          </MenuSub>
        );
      })}
      {booleanDescriptors.map((descriptor) => (
        <MenuSub key={descriptor.id}>
          <MenuSubTrigger className="composer-trait-row">
            <TraitRowLabel
              label={descriptor.label}
              value={descriptor.currentValue === true ? "On" : "Off"}
            />
          </MenuSubTrigger>
          <MenuSubPopup sideOffset={6} className="composer-model-menu min-w-32">
            <BooleanTraitOptions
              descriptor={descriptor}
              onValueChange={(enabled) => handleBooleanChange(descriptor, enabled)}
            />
          </MenuSubPopup>
        </MenuSub>
      ))}
    </>
  );
});

function TraitRowLabel(props: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
      <span className="truncate">{props.label}</span>
      <span className="truncate text-muted-foreground">{props.value}</span>
    </span>
  );
}

/**
 * The selected model's traits as trigger text ("Medium", plus a fast-mode bolt),
 * or null when the model has no traits to show.
 */
export function getTraitsTriggerDisplay(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}): { label: string; showFastModeIcon: boolean } | null {
  const traits = getTraitsSectionVisibility(input);
  if (!traits.hasAnyControls) return null;
  return buildTraitsTriggerDisplay({
    provider: input.provider,
    descriptors: traits.descriptors,
    primarySelectDescriptorId: traits.primarySelectDescriptor?.id ?? null,
    ultrathinkPromptControlled: traits.ultrathinkPromptControlled,
  });
}

/**
 * Build the traits trigger's text label plus whether the fast-mode bolt should
 * render. Claude and Cursor expose fast mode as a boolean, while Codex exposes
 * it through the Standard/Fast service tiers. In either form, fast mode is a
 * lightning bolt when on and nothing at all when off. The one exception is when
 * fast mode is the only trait, where a bare bolt (or bare chevron) would leave
 * the trigger unreadable.
 */
export function buildTraitsTriggerDisplay(input: {
  provider: ProviderDriverKind;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  primarySelectDescriptorId: string | null;
  ultrathinkPromptControlled: boolean;
}): { label: string; showFastModeIcon: boolean } {
  let fastModeFallbackLabel: string | null = null;
  let fastModeEnabled = false;
  const labels: Array<string> = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      fastModeEnabled = descriptor.currentValue === true;
      fastModeFallbackLabel = fastModeEnabled ? "Fast" : "Normal";
      continue;
    }
    if (
      input.provider === "codex" &&
      descriptor.id === "serviceTier" &&
      descriptor.type === "select"
    ) {
      const currentValue = getProviderOptionCurrentValue(descriptor);
      const fastTier = descriptor.options.find(({ label }) => label === "Fast");
      if (fastTier && (currentValue === "default" || currentValue === fastTier.id)) {
        fastModeEnabled = currentValue === fastTier.id;
        fastModeFallbackLabel =
          descriptor.options.find(({ id }) => id === currentValue)?.label ??
          (fastModeEnabled ? "Fast" : "Normal");
        continue;
      }
    }
    const label =
      input.ultrathinkPromptControlled && descriptor.id === input.primarySelectDescriptorId
        ? "Ultrathink"
        : descriptor.type === "boolean"
          ? `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`
          : getProviderOptionCurrentLabel(descriptor);
    if (typeof label === "string" && label.length > 0) {
      labels.push(label);
    }
  }

  // Only fall back to text when fast mode is genuinely the sole trait. Keying
  // off an empty label list alone would also catch descriptors that resolved to
  // no label at all, printing a bogus "Normal" for a model without fast mode.
  if (labels.length === 0 && fastModeFallbackLabel !== null) {
    return { label: fastModeFallbackLabel, showFastModeIcon: false };
  }
  return { label: labels.join(" · "), showFastModeIcon: fastModeEnabled };
}

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const triggerDisplay = getTraitsTriggerDisplay({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  });
  if (!triggerDisplay) {
    return null;
  }

  const { label: triggerLabel, showFastModeIcon } = triggerDisplay;
  const fastModeIcon = showFastModeIcon ? (
    <>
      <ComposerControlIcon
        icon={ZapIcon}
        weight="fill"
        className={cn(
          "opacity-80",
          provider === "claudeAgent" ? "text-[#d97757]" : "text-foreground",
        )}
      />
      <span className="sr-only">Fast mode on</span>
    </>
  ) : null;

  const isCodexStyle = provider === "codex";

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <ComposerControl
            variant={triggerVariant ?? "ghost"}
            className={cn(
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48"
                : "shrink-0 whitespace-nowrap",
              triggerClassName,
            )}
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-1.5 overflow-hidden">
            {fastModeIcon}
            <span className="min-w-0 truncate">{triggerLabel}</span>
            <ComposerControlChevron />
          </span>
        ) : (
          <>
            {fastModeIcon}
            <span>{triggerLabel}</span>
            <ComposerControlChevron />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          {...(instanceId ? { instanceId } : {})}
          models={models}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
