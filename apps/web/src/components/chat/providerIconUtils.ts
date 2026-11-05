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
 * A readable name for a model id the catalog does not know (for example while a provider's
 * model list is still loading or failed): "gpt-5.6-sol" becomes "GPT-5.6 Sol". Callers fall
 * back to this instead of showing the raw id.
 */
export function formatModelSlug(slug: string): string {
  const [first, ...rest] = slug.split("-").filter(Boolean);
  if (!first) return slug;
  const words = rest.map((part) =>
    /^\d/.test(part) ? part : part[0]!.toUpperCase() + part.slice(1),
  );
  if (first.toLowerCase() === "gpt" && words[0] && /^\d/.test(words[0])) {
    return [`GPT-${words[0]}`, ...words.slice(1)].join(" ");
  }
  return [first[0]!.toUpperCase() + first.slice(1), ...words].join(" ");
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
