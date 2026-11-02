import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@cadsense/contracts";

/**
 * The two AI reviewers onboarding can set up, named the way students know
 * them (by account) rather than by CLI. ChatGPT comes first because it works
 * with a free account.
 */
export const REVIEWERS = [
  {
    driver: ProviderDriverKind.make("codex"),
    instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
    account: "ChatGPT",
    tool: "Codex",
    toolBlurb: "Codex is OpenAI's tool that lets Cadsense use your ChatGPT account.",
  },
  {
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent")),
    account: "Claude",
    tool: "Claude Code",
    toolBlurb: "Claude Code is Anthropic's tool that lets Cadsense use your Claude account.",
  },
] as const;

export type Reviewer = (typeof REVIEWERS)[number];

/** Where one reviewer is in setup, read from its live provider snapshot. */
export type ReviewerStage =
  | { readonly kind: "checking" }
  | { readonly kind: "needsInstall" }
  | { readonly kind: "installing" }
  | { readonly kind: "installFailed"; readonly reason: string }
  | { readonly kind: "turnedOff" }
  | { readonly kind: "needsSignIn" }
  | { readonly kind: "signingIn" }
  | { readonly kind: "signInFailed"; readonly reason: string }
  | { readonly kind: "ready" };

export function isReviewerReady(provider: ServerProvider | undefined): boolean {
  return (
    provider !== undefined &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status === "authenticated"
  );
}

/**
 * Maps a snapshot to the onboarding screen. A running install wins, so a
 * reload mid-download lands on the same screen. A signed-in reviewer wins
 * over a sign-in still waiting on the browser and over a stale failure. A
 * failure wins over the plain "not installed" or "signed out" states, so its
 * reason stays on screen until the next attempt.
 */
export function reviewerStage(provider: ServerProvider | undefined): ReviewerStage {
  if (provider === undefined) return { kind: "checking" };
  const setup = provider.setup;
  if (setup?.status === "running" && setup.action === "install") return { kind: "installing" };
  if (isReviewerReady(provider)) return { kind: "ready" };
  if (setup?.status === "running") return { kind: "signingIn" };
  if (setup?.status === "failed") {
    const reason = setup.reason ?? "The command did not finish.";
    return setup.action === "install"
      ? { kind: "installFailed", reason }
      : { kind: "signInFailed", reason };
  }
  if (!provider.installed) return { kind: "needsInstall" };
  if (!provider.enabled) return { kind: "turnedOff" };
  return { kind: "needsSignIn" };
}

/**
 * The reviewer onboarding should show progress for: one with setup running
 * or failed, else one that is installed but not signed in yet (say, after a
 * reload right after its install finished). ChatGPT wins ties.
 */
export function reviewerInSetup(
  providers: ReadonlyArray<ServerProvider>,
): ProviderInstanceId | null {
  const providerFor = (reviewer: Reviewer) =>
    providers.find((provider) => provider.instanceId === reviewer.instanceId);
  const reviewer =
    REVIEWERS.find((candidate) => providerFor(candidate)?.setup !== undefined) ??
    REVIEWERS.find((candidate) => {
      const provider = providerFor(candidate);
      return provider?.installed === true && provider.enabled && !isReviewerReady(provider);
    });
  return reviewer?.instanceId ?? null;
}
