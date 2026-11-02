import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider, ServerProviderSetupAction } from "@cadsense/contracts";
import { useEffect, useState, type ReactNode } from "react";

import { ArrowSquareOutIcon, CheckIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeAI, OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { AddRobotStep } from "./AddRobotStep";
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
 * First-run screen on the home route, shown until the first project exists.
 * Step 1 connects an AI reviewer: one button installs Codex and opens the
 * ChatGPT sign-in, and Claude is the quiet alternative. Step 2 adds a robot.
 * Every state comes from the primary environment's provider snapshots, so a
 * reload or a second window shows the same step.
 */
export function Onboarding() {
  const environmentId = usePrimaryEnvironmentId();
  const [view, setView] = useState<"setup" | "results">("setup");

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 flex-1 overflow-y-auto">
        <div className="m-auto w-full max-w-[30rem] px-6 py-12">
          {view === "results" ? <TestResults onBack={() => setView("setup")} /> : null}
          {/* Stays mounted under the results page so Back returns to the same step. */}
          {environmentId === null ? null : (
            <div hidden={view === "results"}>
              <SetupSteps environmentId={environmentId} onShowResults={() => setView("results")} />
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function SetupSteps({
  environmentId,
  onShowResults,
}: {
  readonly environmentId: EnvironmentId;
  readonly onShowResults: () => void;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
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
  const readyReviewer = REVIEWERS.find((reviewer) => isReviewerReady(providerFor(reviewer)));
  const activeId = choice === "picker" ? null : (choice ?? reviewerInSetup(providers));
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

  if (readyReviewer !== undefined) {
    return (
      <AddRobotStep
        environmentId={environmentId}
        reviewer={readyReviewer}
        provider={providerFor(readyReviewer)}
        providers={providers}
      />
    );
  }

  return (
    <div>
      <Stepper current="Step 1 of 2" detail="then add your robot" />
      <h1 className="mt-2 font-semibold text-[22px] tracking-tight">Connect an AI reviewer</h1>
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
      {localError !== null ? (
        <p role="alert" className="mt-3 text-destructive-foreground text-sm">
          {localError}
        </p>
      ) : null}
    </div>
  );
}

function Stepper({ current, detail }: { readonly current: string; readonly detail?: string }) {
  return (
    <p className="text-tertiary-foreground text-xs">
      <span className="font-medium text-foreground">{current}</span>
      {detail ? <span> · {detail}</span> : null}
    </p>
  );
}

/** A1: one free path, the test result once, and Claude as the quiet alternative. */
function ChooseReviewer({
  onStart,
  onShowResults,
}: {
  readonly onStart: (reviewer: Reviewer) => void;
  readonly onShowResults: () => void;
}) {
  return (
    <>
      <p className="mt-2 text-muted-foreground text-sm">
        Cadsense reviews your CAD using your own AI account. A free ChatGPT account works.
      </p>
      <Button size="lg" className="mt-6 w-full" onClick={() => onStart(CHATGPT)}>
        <OpenAI className="size-4 fill-current dark:fill-current" aria-hidden />
        Start free with ChatGPT
      </Button>
      <p className="mt-2.5 text-center text-muted-foreground text-xs">
        We install Codex, OpenAI's sign-in tool, then open ChatGPT in your browser. Free, Plus and
        Pro accounts all use this button.
      </p>
      <div className="my-6 h-px bg-border" />
      <p className="text-muted-foreground text-xs leading-relaxed">
        Across 3 reviews of one test robot, the free model found all 8 known problems in every run.
        Paid models found about 4 more per review.{" "}
        <button
          type="button"
          className="text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
          onClick={onShowResults}
        >
          Compare test results
        </button>
      </p>
      <div className="mt-4 flex items-center gap-3">
        <ClaudeAI className="size-4 shrink-0" aria-hidden />
        <p className="flex-1 text-muted-foreground text-sm">
          Have Claude Pro or Max? Claude's comments were the clearest in our test.
        </p>
        <Button size="sm" variant="outline" onClick={() => onStart(CLAUDE)}>
          Use Claude
        </Button>
      </div>
    </>
  );
}

/** A2 to A5: install progress, the browser sign-in wait, and both failures. */
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
      <div className="mt-6 rounded-lg border border-border bg-card">
        {installDone ? (
          <Row mark="done">{reviewer.tool} installed</Row>
        ) : stage.kind === "installFailed" ? (
          <Row mark="failed">
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
          </Row>
        ) : stage.kind === "needsInstall" && !requesting ? (
          <Row mark="pending">
            <p>Install {reviewer.tool}</p>
            <p className="mt-1 text-muted-foreground text-xs">{reviewer.toolBlurb}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={onRetry}>
                Install {reviewer.tool}
              </Button>
            </div>
          </Row>
        ) : (
          <Row mark="waiting">
            <p>Installing {reviewer.tool}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              {reviewer.toolBlurb} This takes about a minute.
            </p>
          </Row>
        )}
        <div className="h-px bg-border" />
        {!installDone ? (
          <Row mark="pending" dim>
            {signInLabel}
          </Row>
        ) : stage.kind === "signingIn" ? (
          <Row mark="waiting">
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
          </Row>
        ) : stage.kind === "signInFailed" ? (
          <Row mark="failed">
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
          </Row>
        ) : stage.kind === "turnedOff" ? (
          <Row mark="pending">
            <p>{reviewer.account} is turned off</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Turn it back on in Settings, under Providers.
            </p>
          </Row>
        ) : (
          <Row mark="pending">
            <p>{signInLabel}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Opens {reviewer.account} in your browser.
            </p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={onSignIn}>
                {signInLabel}
              </Button>
            </div>
          </Row>
        )}
      </div>
      <div className="mt-4 space-y-1.5 text-tertiary-foreground text-xs">
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

/**
 * One line of the setup card. The marks are static: a check, a cross, a ring
 * with a dot for "waiting on this", and an empty ring for "not yet".
 */
function Row({
  mark,
  dim = false,
  children,
}: {
  readonly mark: "done" | "failed" | "waiting" | "pending";
  readonly dim?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-3 px-4 py-3.5 text-sm", dim && "opacity-45")}>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {mark === "done" ? (
          <CheckIcon className="size-3.5 text-success" aria-label="Done" />
        ) : mark === "failed" ? (
          <XIcon className="size-3.5 text-destructive-foreground" aria-label="Failed" />
        ) : mark === "waiting" ? (
          <span
            className="flex size-3.5 items-center justify-center rounded-full border-[1.5px] border-foreground"
            aria-label="In progress"
          >
            <span className="size-1.5 rounded-full bg-foreground" />
          </span>
        ) : (
          <span className="size-3.5 rounded-full border-[1.5px] border-input" aria-hidden />
        )}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
