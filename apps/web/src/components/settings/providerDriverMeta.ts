import { ProviderDriverKind } from "@cadsense/contracts";
import { ClaudeAI, type Icon, OpenAI } from "../Icons";

/** The two providers cadsense supports, in settings order. */
export interface DriverOption {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
}

export const DRIVER_OPTIONS: readonly DriverOption[] = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", icon: OpenAI },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", icon: ClaudeAI },
];
