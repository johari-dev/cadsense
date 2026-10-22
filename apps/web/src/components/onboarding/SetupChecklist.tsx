import { useAtomValue } from "@effect/atom-react";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerProvider,
} from "@cadsense/contracts";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { readLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ArrowSquareOutIcon, CheckIcon, DownloadIcon, PlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ClaudeAI, type Icon, OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";

/**
 * First-run home screen: a short checklist that gets a non-technical user to
 * a working assistant. It reads the live provider snapshots, installs Codex
 * into the app when it is missing, and starts the browser sign-in for
 * whichever assistant the user picks.
 */

const CLAUDE_SETUP_URL = "https://code.claude.com/docs/en/setup";

const ASSISTANTS = [
  {
    driver: ProviderDriverKind.make("codex"),
    label: "Codex",
    icon: OpenAI,
    blurb: "Works with a free ChatGPT account.",
    signInHost: "openai.com",
    canInstall: true,
  },
  {
    driver: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    icon: ClaudeAI,
    blurb: "Needs a paid Claude plan (Pro or Max).",
    signInHost: "claude.com",
    canInstall: false,
  },
] as const satisfies ReadonlyArray<{
  driver: ProviderDriverKind;
  label: string;
  icon: Icon;
  blurb: string;
  signInHost: string;
  canInstall: boolean;
}>;
type Assistant = (typeof ASSISTANTS)[number];

type AssistantStatus =
  | { readonly kind: "checking" }
  | { readonly kind: "missing" }
  | { readonly kind: "installing"; readonly fraction: number }
  | { readonly kind: "signedOut" }
  | { readonly kind: "ready"; readonly account: string | null }
  | { readonly kind: "problem"; readonly message: string };

/** Reads one snapshot into the step the checklist should show for it. */
function assistantStatus(snapshot: ServerProvider | undefined): AssistantStatus {
  if (snapshot === undefined) return { kind: "checking" };
  const install = snapshot.installState;
  if (install?.status === "running" || install?.status === "queued") {
    const progress = install.progress;
    return {
      kind: "installing",
      fraction:
        progress && progress.totalBytes > 0 ? progress.completedBytes / progress.totalBytes : 0,
    };
  }
  if (!snapshot.enabled) return { kind: "problem", message: "Turned off in settings." };
  if (snapshot.installed && snapshot.status === "ready") {
    return { kind: "ready", account: snapshot.auth.email ?? snapshot.auth.label ?? null };
  }
  if (snapshot.installed && snapshot.auth.status === "unauthenticated")
    return { kind: "signedOut" };
  if (install?.status === "failed") {
    return { kind: "problem", message: install.message ?? "The install did not finish." };
  }
  // A snapshot that has not been probed yet reports a warning, not an error.
  if (!snapshot.installed)
    return snapshot.status === "warning" ? { kind: "checking" } : { kind: "missing" };
  return {
    kind: "problem",
    message: snapshot.message ?? "Something is wrong with this assistant.",
  };
}

interface SignInAttempt {
  readonly assistant: Assistant;
  readonly authUrl: string | null;
}

export function SetupChecklist() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const environmentId = usePrimaryEnvironmentId();
  const installProvider = useAtomCommand(serverEnvironment.installProvider, {
    reportFailure: false,
  });
  const signInProvider = useAtomCommand(serverEnvironment.signInProvider, {
    reportFailure: false,
  });
  const [signIn, setSignIn] = useState<SignInAttempt | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = ASSISTANTS.map((assistant) => {
    const instanceId = defaultInstanceIdForDriver(assistant.driver);
    const snapshot = providers.find((provider) => provider.instanceId === instanceId);
    return { assistant, instanceId, status: assistantStatus(snapshot) };
  });
  const ready = rows.find((row) => row.status.kind === "ready");
  const busy = rows.find((row) => row.status.kind === "installing");

  // A finished sign-in shows up as a ready snapshot; drop the waiting row then.
  const isReady = ready !== undefined;
  useEffect(() => {
    if (isReady) setSignIn(null);
  }, [isReady]);

  const install = useCallback(
    async (row: (typeof rows)[number]) => {
      if (environmentId === null) return;
      setActionError(null);
      const result = await installProvider({
        environmentId,
        input: { provider: row.assistant.driver, instanceId: row.instanceId },
      });
      if (result._tag === "Failure") {
        setActionError(`Could not install ${row.assistant.label}. Try again.`);
      }
    },
    [environmentId, installProvider],
  );

  const startSignIn = useCallback(
    async (row: (typeof rows)[number]) => {
      if (environmentId === null) return;
      setActionError(null);
      const result = await signInProvider({
        environmentId,
        input: { instanceId: row.instanceId },
      });
      if (result._tag === "Failure") {
        setSignIn(null);
        setActionError(`Could not start ${row.assistant.label} sign-in. Try again.`);
        return;
      }
      const { authUrl } = result.value;
      setSignIn({ assistant: row.assistant, authUrl });
      if (authUrl !== null) void readLocalApi()?.shell.openExternal(authUrl);
    },
    [environmentId, signInProvider],
  );

  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  // The user already uses an installed-but-signed-out assistant; otherwise
  // point them at free Codex.
  const recommended =
    rows.find((row) => row.status.kind === "signedOut")?.assistant.driver ?? ASSISTANTS[0].driver;
  const scanning = rows.every((row) => row.status.kind === "checking");

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-8 pt-[18vh] pb-12">
        <div className="w-full max-w-lg">
          <h1 className="font-medium text-lg">Set up Cadsense</h1>
          <p className="mt-1 text-muted-foreground text-sm">
            Cadsense needs an AI assistant on this computer before it can review your models.
          </p>

          <ol className="mt-6 divide-y border-y">
            <ChecklistStep
              index={1}
              status={ready ? "done" : "active"}
              title="Connect an assistant"
              detail={
                ready
                  ? `Using ${ready.assistant.label}${ready.status.kind === "ready" && ready.status.account ? ` with ${ready.status.account}` : ""}.`
                  : scanning
                    ? "Looking for Codex and Claude on this computer…"
                    : "Pick one to continue."
              }
            >
              {ready || scanning ? null : (
                <div className="mt-3 ml-7 flex flex-col gap-1">
                  {signIn !== null ? (
                    <WaitingRow attempt={signIn} onCancel={() => setSignIn(null)} />
                  ) : (
                    [...rows]
                      .sort((a, b) =>
                        a.assistant.driver === recommended
                          ? -1
                          : b.assistant.driver === recommended
                            ? 1
                            : 0,
                      )
                      .map((row) => (
                        <AssistantRow
                          key={row.instanceId}
                          assistant={row.assistant}
                          status={row.status}
                          primary={row.assistant.driver === recommended}
                          disabled={busy !== undefined && busy !== row}
                          onInstall={() => void install(row)}
                          onSignIn={() => void startSignIn(row)}
                        />
                      ))
                  )}
                  {actionError ? (
                    <p className="text-destructive-foreground text-xs">{actionError}</p>
                  ) : null}
                </div>
              )}
            </ChecklistStep>
            <ChecklistStep
              index={2}
              status={ready ? "active" : "locked"}
              title="Add a project"
              detail="An Onshape document or a folder of CAD files"
              action={
                ready ? (
                  <Button size="sm" onClick={openAddProject}>
                    <PlusIcon />
                    Add project
                  </Button>
                ) : null
              }
            />
            <ChecklistStep
              index={3}
              status="locked"
              title="Ask about your model"
              detail="For example, “are any walls on this bracket too thin?”"
            />
          </ol>
        </div>
      </div>
    </SidebarInset>
  );
}

function ChecklistStep({
  index,
  status,
  title,
  detail,
  action,
  children,
}: {
  readonly index: number;
  readonly status: "locked" | "active" | "done";
  readonly title: string;
  readonly detail: ReactNode;
  readonly action?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <li className="py-4">
      <div
        className={cn(
          "flex items-start gap-3 transition-opacity duration-300",
          status === "locked" && "opacity-45",
        )}
      >
        <span className="w-4 shrink-0 pt-px text-muted-foreground text-sm tabular-nums">
          {status === "done" ? <CheckIcon className="size-4 text-emerald-400" /> : index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm">{title}</div>
          <div className="text-muted-foreground text-xs">{detail}</div>
        </div>
        {action}
      </div>
      {children}
    </li>
  );
}

function AssistantRow({
  assistant,
  status,
  primary,
  disabled,
  onInstall,
  onSignIn,
}: {
  readonly assistant: Assistant;
  readonly status: AssistantStatus;
  readonly primary: boolean;
  readonly disabled: boolean;
  readonly onInstall: () => void;
  readonly onSignIn: () => void;
}) {
  const variant = primary ? "default" : "outline";
  switch (status.kind) {
    case "installing":
      return (
        <ProviderRow
          assistant={assistant}
          title={`Installing ${assistant.label}`}
          detail={<InstallProgress fraction={status.fraction} />}
        />
      );
    case "signedOut":
      return (
        <ProviderRow
          assistant={assistant}
          detail="Installed. Sign in to use it."
          action={
            <Button size="sm" variant={variant} disabled={disabled} onClick={onSignIn}>
              Sign in
              <ArrowSquareOutIcon />
            </Button>
          }
        />
      );
    case "missing":
      return (
        <ProviderRow
          assistant={assistant}
          detail={assistant.blurb}
          action={
            assistant.canInstall ? (
              <Button size="sm" variant={variant} disabled={disabled} onClick={onInstall}>
                <DownloadIcon />
                Install
              </Button>
            ) : (
              <Button
                size="sm"
                variant={variant}
                disabled={disabled}
                onClick={() => void readLocalApi()?.shell.openExternal(CLAUDE_SETUP_URL)}
              >
                Get Claude Code
                <ArrowSquareOutIcon />
              </Button>
            )
          }
        />
      );
    case "problem":
      return (
        <ProviderRow
          assistant={assistant}
          detail={status.message}
          action={
            assistant.canInstall ? (
              <Button size="sm" variant={variant} disabled={disabled} onClick={onInstall}>
                Try again
              </Button>
            ) : null
          }
        />
      );
    case "checking":
      return <ProviderRow assistant={assistant} detail="Checking…" />;
    case "ready":
      return <ProviderRow assistant={assistant} detail="Ready." />;
  }
}

function WaitingRow({
  attempt,
  onCancel,
}: {
  readonly attempt: SignInAttempt;
  readonly onCancel: () => void;
}) {
  const { assistant, authUrl } = attempt;
  return (
    <ProviderRow
      assistant={assistant}
      title={`Waiting for ${assistant.signInHost}`}
      detail="Finish signing in in your browser, then come back."
      action={
        <div className="flex gap-1">
          {authUrl !== null ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void readLocalApi()?.shell.openExternal(authUrl)}
            >
              Reopen page
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      }
    />
  );
}

function ProviderRow({
  assistant,
  title,
  detail,
  action,
}: {
  readonly assistant: Assistant;
  readonly title?: string;
  readonly detail: ReactNode;
  readonly action?: ReactNode;
}) {
  const ProviderIcon = assistant.icon;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <ProviderIcon className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm">{title ?? assistant.label}</div>
        <div className="text-muted-foreground text-xs">{detail}</div>
      </div>
      {action}
    </div>
  );
}

/** Thin bar that follows the server's download progress. */
function InstallProgress({ fraction }: { readonly fraction: number }) {
  return (
    <span className="mt-1.5 block h-0.5 max-w-60 overflow-hidden bg-input">
      <span
        className="block h-full bg-foreground/70 transition-[width] duration-300 ease-linear"
        style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }}
      />
    </span>
  );
}
