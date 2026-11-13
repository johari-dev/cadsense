import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@cadsense/client-runtime/environment";
import type { EnvironmentId, ServerProvider, ServerProviderSetupAction } from "@cadsense/contracts";
import { useEffect, useState } from "react";

import { ArrowSquareOutIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { singleCadModelName } from "../../cad/cadModelName";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import type { Project } from "../../types";
import { ClaudeAI, OpenAI } from "../Icons";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { describeProjectSource } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { AddCadStep } from "./AddCadStep";
import { ChecklistProgress, ChecklistRow, StepRow, type ChecklistRowStatus } from "./Checklist";
import { importCadStage } from "./importCad.logic";
import { ImportCadStep } from "./ImportCadStep";
import {
  isReviewerReady,
  REVIEWERS,
  reviewerInSetup,
  reviewerStage,
  type Reviewer,
  type ReviewerStage,
} from "./reviewerSetup.logic";
import { TestResults } from "./TestResults";

const CHATGPT = REVIEWERS[0];
const CLAUDE = REVIEWERS[1];

/**
 * First-run screen on the home route: one checklist card that connects an AI reviewer, adds a
 * CAD, and imports it. The open step expands; finished steps fold to a one-line summary.
 * `project` is the CAD project onboarding added, or null before there is one. The home route keeps this
 * screen up through the first import, so the project opens with its model ready. Every step reads
 * from live server state (provider snapshots, the project's CAD state), so a reload or a second
 * window shows the same step.
 */
export function Onboarding({ project }: { readonly project: Project | null }) {
  const environmentId = usePrimaryEnvironmentId();
  const [view, setView] = useState<"setup" | "results">("setup");

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 flex-1 overflow-y-auto">
        <div className="m-auto w-full max-w-[32rem] px-6 py-12">
          {view === "results" ? <TestResults onBack={() => setView("setup")} /> : null}
          {/* Stays mounted under the results page so Back returns to the same step. */}
          {environmentId === null ? null : (
            <div hidden={view === "results"}>
              <SetupChecklist
                environmentId={environmentId}
                project={project}
                onShowResults={() => setView("results")}
              />
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function SetupChecklist({
  environmentId,
  project,
  onShowResults,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: Project | null;
  readonly onShowResults: () => void;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const handleNewThread = useNewThreadHandler();
  const [opening, setOpening] = useState(false);
  const providerFor = (reviewer: Reviewer) =>
    providers.find((provider) => provider.instanceId === reviewer.instanceId);
  const reviewer = REVIEWERS.find((candidate) => isReviewerReady(providerFor(candidate)));
  const reviewerProvider = reviewer && providerFor(reviewer);
  const importStage = project === null ? null : importCadStage(project);
  const done = [reviewer !== undefined, project !== null, importStage?.kind === "done"];
  // The first unfinished step is open; -1 once all three are done.
  const openIndex = done.indexOf(false);
  const status = (index: number): ChecklistRowStatus =>
    done[index] ? "done" : index === openIndex ? "open" : "todo";

  const openProject = () => {
    if (project === null) return;
    setOpening(true);
    void handleNewThread(scopeProjectRef(project.environmentId, project.id)).finally(() =>
      setOpening(false),
    );
  };

  return (
    // On first load the header, progress bar, and card rise in one after another.
    <div className="onboarding-enter">
      <p className="text-center text-tertiary-foreground text-xs">
        <span className="font-medium text-foreground">Set up Cadsense</span>
      </p>
      <ChecklistProgress done={done} />
      <div
        className={cn(
          "mt-3 overflow-hidden rounded-xl border border-border bg-card",
          openIndex === -1 && "onboarding-complete",
        )}
      >
        <ChecklistRow
          title="Connect an AI reviewer"
          status={status(0)}
          summary={
            reviewer ? (
              <>
                {/* The account's name once signed in; the tool's for a reviewer with no account. */}
                <span className="shrink-0">
                  {reviewerProvider?.auth.status === "authenticated"
                    ? reviewer.account
                    : reviewer.tool}
                </span>
                {reviewerProvider?.auth.email ? (
                  <>
                    <span>·</span>
                    <RedactedSensitiveText
                      value={reviewerProvider.auth.email}
                      ariaLabel="Toggle account email visibility"
                      revealTooltip="Click to reveal email"
                      hideTooltip="Click to hide email"
                      className="max-w-40 truncate"
                    />
                  </>
                ) : null}
              </>
            ) : null
          }
        >
          <ReviewerStep
            environmentId={environmentId}
            providers={providers}
            onShowResults={onShowResults}
          />
        </ChecklistRow>
        <ChecklistRow
          title="Add your CAD"
          status={status(1)}
          summary={
            project ? (
              <>
                <span className="min-w-0 truncate">{project.title}</span>
                <span>·</span>
                <span className="min-w-0 truncate">
                  {project.onshapeSource ? "Onshape" : describeProjectSource(project).label}
                </span>
              </>
            ) : null
          }
        >
          <AddCadStep environmentId={environmentId} providers={providers} />
        </ChecklistRow>
        <ChecklistRow
          title="Import CAD"
          status={status(2)}
          summary={
            project ? (
              <span className="min-w-0 truncate">{singleCadModelName(project.cad) ?? ""}</span>
            ) : null
          }
        >
          {project ? <ImportCadStep project={project} /> : null}
        </ChecklistRow>
      </div>
      {openIndex === 2 ? (
        <p
          key="chat-now"
          className="onboarding-fade mt-4 text-center text-tertiary-foreground text-xs"
        >
          <button
            type="button"
            disabled={opening}
            className="underline decoration-foreground/30 underline-offset-2 hover:text-foreground"
            onClick={openProject}
          >
            Start chatting now
          </button>
          .{" "}
          {importStage?.kind === "failed" || importStage?.kind === "choose"
            ? "You can import from the CAD panel later."
            : "The import keeps going."}
        </p>
      ) : openIndex === -1 && project ? (
        <div key="open" className="onboarding-enter mt-5 flex flex-col items-center gap-2">
          <Button size="lg" disabled={opening} onClick={openProject}>
            Open {project.title}
          </Button>
          <p className="text-tertiary-foreground text-xs">
            Your CAD is imported and ready to review.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Step 1: connect an AI reviewer. One button installs Codex and opens the ChatGPT sign-in, and
 * Claude is the quiet alternative. Progress and failures read from the provider snapshots.
 */
function ReviewerStep({
  environmentId,
  providers,
  onShowResults,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onShowResults: () => void;
}) {
  const runProviderSetup = useAtomCommand(serverEnvironment.runProviderSetup, {
    reportFailure: false,
  });
  // The reviewer the student picked on this screen. `"picker"` returns to
  // the first screen even while an earlier attempt's failure is on record.
  const [choice, setChoice] = useState<Reviewer["instanceId"] | "picker" | null>(null);
  // Errors the server could not record on a snapshot, such as a provider
  // that is not running at all.
  const [localError, setLocalError] = useState<string | null>(null);
  // True while this window's install or sign-in request is in flight, so a
  // reviewer that is "not installed" with no request running shows an
  // Install button instead of waiting forever.
  const [requesting, setRequesting] = useState(false);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const providerFor = (reviewer: Reviewer) =>
    providers.find((provider) => provider.instanceId === reviewer.instanceId);
  // A reviewer that just finished signing in stays on screen while the step folds away.
  const activeId =
    choice === "picker"
      ? null
      : (choice ??
        reviewerInSetup(providers) ??
        REVIEWERS.find((reviewer) => isReviewerReady(providerFor(reviewer)))?.instanceId ??
        null);
  const active = REVIEWERS.find((reviewer) => reviewer.instanceId === activeId) ?? null;
  const waitingOnBrowser =
    active !== null && reviewerStage(providerFor(active)).kind === "signingIn";

  // A student who finished signing in comes back to this window. Re-check
  // then instead of waiting for the CLI to exit or the next periodic probe.
  useEffect(() => {
    if (!waitingOnBrowser) return;
    const recheck = () => void refreshProviders({ environmentId, input: {} });
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [waitingOnBrowser, environmentId, refreshProviders]);

  const run = async (reviewer: Reviewer, action: ServerProviderSetupAction) => {
    setRequesting(true);
    const result = await runProviderSetup({
      environmentId,
      input: { instanceId: reviewer.instanceId, action },
    }).finally(() => setRequesting(false));
    if (result._tag === "Success") return result.value.providers;
    // Failures the runner records show up on the snapshot; anything else is
    // shown here.
    if (providerFor(reviewer)?.setup === undefined) {
      setLocalError(`Cadsense could not set up ${reviewer.account}. Try again.`);
    }
    return null;
  };

  /** Installs the reviewer's CLI when missing, then opens its sign-in. */
  const start = async (reviewer: Reviewer) => {
    setChoice(reviewer.instanceId);
    setLocalError(null);
    let provider: ServerProvider | undefined = providerFor(reviewer);
    if (provider?.installed !== true) {
      const providersAfterInstall = await run(reviewer, "install");
      if (providersAfterInstall === null) return;
      provider = providersAfterInstall.find((item) => item.instanceId === reviewer.instanceId);
    }
    if (!isReviewerReady(provider)) await run(reviewer, "signIn");
  };

  return (
    <>
      {/* Keyed so switching between the picker and a reviewer's progress slides in. */}
      <div key={active?.instanceId ?? "picker"} className="onboarding-enter-x">
        {active === null ? (
          <ChooseReviewer
            onStart={(reviewer) => void start(reviewer)}
            onShowResults={onShowResults}
          />
        ) : (
          <ReviewerProgress
            reviewer={active}
            stage={reviewerStage(providerFor(active))}
            requesting={requesting}
            onSignIn={() => {
              setLocalError(null);
              void run(active, "signIn");
            }}
            onRetry={() => void start(active)}
            onBack={() => {
              setLocalError(null);
              setChoice("picker");
            }}
          />
        )}
      </div>
      {localError !== null ? (
        <p
          key={localError}
          role="alert"
          className="onboarding-swap mt-3 text-destructive-foreground text-sm"
        >
          {localError}
        </p>
      ) : null}
    </>
  );
}

/** One free path, the test result once, and Claude as the quiet alternative. */
function ChooseReviewer({
  onStart,
  onShowResults,
}: {
  readonly onStart: (reviewer: Reviewer) => void;
  readonly onShowResults: () => void;
}) {
  return (
    <>
      <p className="text-muted-foreground text-sm">
        Cadsense reviews your CAD using your own AI account. A free ChatGPT account works.
      </p>
      <Button size="lg" className="mt-4 w-full" onClick={() => onStart(CHATGPT)}>
        <OpenAI className="size-4 fill-current dark:fill-current" aria-hidden />
        Start free with ChatGPT
      </Button>
      <p className="mt-2 text-center text-muted-foreground text-xs">
        We install Codex, OpenAI's sign-in tool, then open ChatGPT in your browser. Free, Plus and
        Pro accounts all use this button.
      </p>
      <div className="mt-4 flex items-center gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
        <ClaudeAI className="size-4 shrink-0" aria-hidden />
        <p className="flex-1 text-muted-foreground text-xs">
          Have Claude Pro or Max? Claude's comments were the clearest in our test.
        </p>
        <Button size="sm" variant="outline" onClick={() => onStart(CLAUDE)}>
          Use Claude
        </Button>
      </div>
      <p className="mt-3 text-tertiary-foreground text-xs leading-relaxed">
        Across 3 reviews of one test robot, the free model found all 8 known problems in every run.
        Paid models found about 4 more per review.{" "}
        <button
          type="button"
          className="text-muted-foreground underline decoration-foreground/30 underline-offset-2 hover:text-foreground"
          onClick={onShowResults}
        >
          Compare test results
        </button>
      </p>
    </>
  );
}

/** Install progress, the browser sign-in wait, both failures, and the finished state. */
function ReviewerProgress({
  reviewer,
  stage,
  requesting,
  onSignIn,
  onRetry,
  onBack,
}: {
  readonly reviewer: Reviewer;
  readonly stage: ReviewerStage;
  readonly requesting: boolean;
  readonly onSignIn: () => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
}) {
  const installDone = !["checking", "needsInstall", "installing", "installFailed"].includes(
    stage.kind,
  );
  const signInLabel = `Sign in to ${reviewer.account}`;

  return (
    <>
      <div className="rounded-lg border border-border bg-background/40">
        {installDone ? (
          <StepRow mark="done">{reviewer.tool} installed</StepRow>
        ) : stage.kind === "installFailed" ? (
          <StepRow mark="failed">
            <p>Couldn't install {reviewer.tool}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Check your internet connection, then try again. School networks sometimes block
              downloads, so another network may work.
            </p>
            <FailureDetails reason={stage.reason} />
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={onRetry}>
                Try again
              </Button>
            </div>
          </StepRow>
        ) : stage.kind === "needsInstall" && !requesting ? (
          <StepRow mark="pending">
            <p>Install {reviewer.tool}</p>
            <p className="mt-1 text-muted-foreground text-xs">{reviewer.toolBlurb}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={onRetry}>
                Install {reviewer.tool}
              </Button>
            </div>
          </StepRow>
        ) : (
          <StepRow mark="waiting">
            <p>Installing {reviewer.tool}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              {reviewer.toolBlurb} This takes about a minute.
            </p>
          </StepRow>
        )}
        <div className="h-px bg-border" />
        {!installDone ? (
          <StepRow mark="pending" dim>
            {signInLabel}
          </StepRow>
        ) : stage.kind === "ready" ? (
          <StepRow mark="done">
            {stage.signedIn ? `Signed in to ${reviewer.account}` : `${reviewer.tool} is ready`}
          </StepRow>
        ) : stage.kind === "signingIn" ? (
          <StepRow mark="waiting">
            <p>{signInLabel} in your browser</p>
            <p className="mt-1 text-muted-foreground text-xs">
              We opened {reviewer.account} in a browser tab. Sign in there, then come back. This
              page moves on by itself. We'll wait up to 10 minutes.
            </p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" onClick={onSignIn}>
                <ArrowSquareOutIcon className="size-3.5" aria-hidden />
                Open sign-in again
              </Button>
            </div>
          </StepRow>
        ) : stage.kind === "signInFailed" ? (
          <StepRow mark="failed">
            <p>Sign-in didn't finish</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Trying again opens a fresh sign-in page.
            </p>
            <FailureDetails reason={stage.reason} />
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={onSignIn}>
                Try again
              </Button>
            </div>
          </StepRow>
        ) : stage.kind === "turnedOff" ? (
          <StepRow mark="pending">
            <p>{reviewer.account} is turned off</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Turn it back on in Settings, under Providers.
            </p>
          </StepRow>
        ) : (
          <StepRow mark="pending">
            <p>{signInLabel}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Opens {reviewer.account} in your browser.
            </p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={onSignIn}>
                {signInLabel}
              </Button>
            </div>
          </StepRow>
        )}
      </div>
      <div className="mt-3 space-y-1.5 text-tertiary-foreground text-xs">
        {reviewer.account === "ChatGPT" ? (
          <p>No ChatGPT account? You can make one for free on the sign-in page.</p>
        ) : (
          <p>Claude needs a Claude Pro or Max plan.</p>
        )}
        <p>If your school blocks sign-in to other apps, try a personal account.</p>
        <p>
          <button
            type="button"
            className="underline decoration-foreground/30 underline-offset-2 hover:text-foreground"
            onClick={onBack}
          >
            Choose a different AI
          </button>
        </p>
      </div>
    </>
  );
}

/** The server's raw failure reason, small and last, for anyone helping debug. */
function FailureDetails({ reason }: { readonly reason: string }) {
  return (
    <p className="mt-1.5 break-words font-mono text-[11px] text-tertiary-foreground">
      Details: {reason}
    </p>
  );
}
