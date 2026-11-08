import { ProviderDriverKind } from "@cadsense/contracts";
import { ClaudeAI, Icon, OpenAI } from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

/**
 * Model families the provider icon already names. Labels drawn beside that icon drop the
 * prefix, so "Claude Opus 5.5" reads "Opus 5.5" and "GPT-6.1 Sol" reads "6.1 Sol".
 */
const ICON_NAMED_FAMILY_PREFIX = /^(?:claude|gpt)(?:\s+|-)(?=\S)/iu;

/** The compact name for a picker trigger, which always renders the provider icon beside it. */
export function getTriggerDisplayModelName(model: ModelEsque): string {
  const name = getDisplayModelName(model, { preferShortName: true });
  return name.replace(ICON_NAMED_FAMILY_PREFIX, "") || name;
}

/** The full name for a trigger's tooltip, where the provider icon is not repeated. */
export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getDisplayModelName(model);
}
