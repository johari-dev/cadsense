import { scopeProjectRef, scopeThreadRef } from "@cadsense/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { squashAtomCommandFailure } from "@cadsense/client-runtime/state/runtime";
import {
  ONSHAPE_PUBLIC_STACK_ORIGIN,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_RUNTIME_MODE,
  onshapeStackOrigin,
  type EnvironmentId,
  type OnshapeConnectionId,
  type OnshapeConnectionSummary,
  type ServerProvider,
} from "@cadsense/contracts";
import { useRef, useState, type ReactNode } from "react";

import { ArrowSquareOutIcon, CheckIcon, EyeIcon, EyeSlashIcon } from "~/lib/icons";
import { openCommandPalette } from "../../commandPaletteBus";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { newProjectId } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { onshapeConnectionEnvironment } from "../../state/onshapeConnections";
import { onshapeProjectEnvironment } from "../../state/onshapeProjects";
import { localCadProjectEnvironment } from "../../state/localCadProjects";
import { threadEnvironment } from "../../state/threads";
import { useRightPanelStore } from "../../rightPanelStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { markPromotedDraftThreadByRef } from "../../composerDraftStore";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { safeOnshapeConnectionErrorMessage } from "../settings/OnshapeConnectionsSettings.logic";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { isReviewerReady, type Reviewer } from "./reviewerSetup.logic";
import { acquireOnshapeBrowserCad, isOnshapeBrowserPrototype } from "./onshapeBrowserPrototype";

const ONSHAPE_API_KEYS_URL = "https://dev-portal.onshape.com/keys";

/**
 * Step 2 of onboarding: add the first robot. In the browser prototype the
 * no-key choice acquires a STEP before creating a normal local CAD project.
 * API access needs a key once per Onshape stack; when this environment has no
 * connection on the link's stack (cad.onshape.com, or an Enterprise domain
 * like 1678.onshape.com), Continue opens the key step, and connecting
 * creates the project in the same click. SolidWorks and STEP files open the
 * existing add-project form.
 */
export function AddRobotStep({
  environmentId,
  reviewer,
  provider,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly reviewer: Reviewer;
  readonly provider: ServerProvider | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const connectionsQuery = useEnvironmentQuery(
    onshapeConnectionEnvironment.list({ environmentId, input: {} }),
  );
  const createConnection = useAtomCommand(onshapeConnectionEnvironment.create, {
    reportFailure: false,
  });
  const createProject = useAtomCommand(onshapeProjectEnvironment.create, {
    reportFailure: false,
  });
  const createLocalProject = useAtomCommand(localCadProjectEnvironment.create, {
    reportFailure: false,
  });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [step, setStep] = useState<"link" | "key">("link");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const browserPrototype = isOnshapeBrowserPrototype();
  const [accessMethod, setAccessMethod] = useState<"key" | "browser">("key");
  const [browserProgress, setBrowserProgress] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  // A connection made on the key step, kept so a failed project create can
  // be retried from the link step before the list refreshes, without
  // creating a second connection.
  const [createdConnection, setCreatedConnection] = useState<OnshapeConnectionSummary | null>(null);
  const connections = connectionsQuery.data?.connections ?? [];
  const knownConnections =
    createdConnection === null ? connections : [createdConnection, ...connections];
  // The stack the pasted link is on, or null until the link is an Onshape URL.
  const linkStack = URL.canParse(url.trim()) ? onshapeStackOrigin(new URL(url.trim())) : null;
  const linkConnection =
    linkStack === null ? undefined : knownConnections.find((entry) => entry.host === linkStack);
  const needsKey =
    linkStack === null ? knownConnections.length === 0 : linkConnection === undefined;
  const linkHostname = linkStack === null ? null : new URL(linkStack).hostname;

  /** Creates the Onshape project and opens its first chat. Returns an error, or null. */
  const addOnshapeRobot = async (connectionId: OnshapeConnectionId): Promise<string | null> => {
    const result = await createProject({
      environmentId,
      input: {
        projectId: newProjectId(),
        title: title.trim(),
        url: url.trim(),
        connectionId,
        defaultModelSelection: resolveDefaultProviderModelSelection(providers, null),
      },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      return failure instanceof Error ? failure.message : "Cadsense could not add this robot.";
    }
    await handleNewThread(scopeProjectRef(environmentId, result.value.projectId));
    return null;
  };

  const submitLink = async () => {
    if (submitting.current) return;
    if (!url.trim()) return setLinkError("Paste the link to your Onshape document.");
    if (!title.trim()) return setLinkError("Give your robot a name.");
    if (linkStack === null) {
      return setLinkError("Paste the full Onshape link from your browser, starting with https://.");
    }
    setLinkError(null);
    if (browserPrototype && accessMethod === "browser") {
      submitting.current = true;
      setPending(true);
      setBrowserProgress("Opening your Onshape document…");
      try {
        const download = await acquireOnshapeBrowserCad(
          { url: url.trim(), title: title.trim() },
          setBrowserProgress,
        );
        const created = await createLocalProject({
          environmentId,
          input: { ...download, projectId: newProjectId(), title: title.trim() },
        });
        if (created._tag === "Failure") {
          const failure = squashAtomCommandFailure(created);
          throw failure instanceof Error
            ? failure
            : new Error("Cadsense could not import this robot.");
        }
        // CAD needs a server thread. Create it without sending an AI message,
        // just as opening CAD from a draft does.
        const draft = await handleNewThread(
          scopeProjectRef(environmentId, created.value.projectId),
        );
        if (!draft) throw new Error("Cadsense could not open this robot.");
        const threadId = draft.threadId;
        const thread = await createThread({
          environmentId,
          input: {
            threadId,
            projectId: created.value.projectId,
            title: "New thread",
            modelSelection: resolveDefaultProviderModelSelection(providers, null) ?? {
              instanceId: reviewer.instanceId,
              model: DEFAULT_MODEL_BY_PROVIDER[reviewer.driver] ?? DEFAULT_MODEL,
            },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          },
        });
        if (thread._tag === "Failure") {
          const failure = squashAtomCommandFailure(thread);
          throw failure instanceof Error
            ? failure
            : new Error("Cadsense could not open this robot.");
        }
        const threadRef = scopeThreadRef(environmentId, threadId);
        markPromotedDraftThreadByRef(threadRef);
        useRightPanelStore.getState().open(threadRef, "cad");
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      } catch (error) {
        setLinkError(
          error instanceof Error ? error.message : "The browser import failed. Try again.",
        );
      } finally {
        submitting.current = false;
        setPending(false);
        setBrowserProgress(null);
      }
      return;
    }
    if (linkConnection === undefined) return setStep("key");
    setPending(true);
    setLinkError(await addOnshapeRobot(linkConnection.connectionId));
    setPending(false);
  };

  const submitKey = async () => {
    if (linkStack === null) return setStep("link");
    if (!accessKeyId.trim() || !secretKey.trim()) {
      return setKeyError("Paste both codes from Onshape.");
    }
    setPending(true);
    setKeyError(null);
    const created = await createConnection({
      environmentId,
      input: {
        name: linkStack === ONSHAPE_PUBLIC_STACK_ORIGIN ? "Onshape" : `Onshape (${linkHostname})`,
        host: linkStack,
        accessKeyId: accessKeyId.trim(),
        secretKey: secretKey.trim(),
      },
    });
    if (created._tag === "Failure") {
      setKeyError(safeOnshapeConnectionErrorMessage(squashAtomCommandFailure(created)));
      setPending(false);
      return;
    }
    setCreatedConnection(created.value);
    connectionsQuery.refresh();
    // The key worked. A project error is about the link, so show it there.
    const projectError = await addOnshapeRobot(created.value.connectionId);
    if (projectError !== null) {
      setLinkError(projectError);
      setStep("link");
    }
    setPending(false);
  };

  const openLocalFile = () => openCommandPalette({ open: "add-project", kind: "local-cad" });

  if (step === "key") {
    return (
      <div>
        <p className="text-tertiary-foreground text-xs">
          <button
            type="button"
            className="text-muted-foreground underline decoration-foreground/30 underline-offset-2 hover:text-foreground"
            onClick={() => setStep("link")}
          >
            Back
          </button>
          <span> · </span>
          <span className="font-medium text-foreground">Step 2 of 2</span>
          <span> · Onshape</span>
        </p>
        <h1 className="mt-2 font-semibold text-[22px] tracking-tight">
          Let Cadsense read your Onshape documents
        </h1>
        <p className="mt-2 text-muted-foreground text-sm">
          Cadsense needs an Onshape API key, a pair of codes that lets it read documents your
          Onshape account can open. You make it once.
        </p>
        {linkStack !== null && linkStack !== ONSHAPE_PUBLIC_STACK_ORIGIN ? (
          <p className="mt-2 text-muted-foreground text-sm">
            This link is on <b className="font-medium">{linkHostname}</b>. Make the key with the
            Onshape account you use there.
          </p>
        ) : null}
        <ol className="mt-5 space-y-3 text-sm">
          <KeyStep n={1}>
            <span className="flex-1">Open Onshape's API keys page and sign in.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void readLocalApi()?.shell.openExternal(ONSHAPE_API_KEYS_URL)}
            >
              <ArrowSquareOutIcon className="size-3.5" aria-hidden />
              Open Onshape
            </Button>
          </KeyStep>
          <KeyStep n={2}>
            <span className="flex-1">
              Click <b className="font-medium">Create new API key</b>. Tick only{" "}
              <b className="font-medium">Application can read your documents</b>, then click{" "}
              <b className="font-medium">Create</b>.
            </span>
          </KeyStep>
          <KeyStep n={3}>
            <span className="flex-1">
              Copy both codes below. Onshape shows the secret key only once.
            </span>
          </KeyStep>
        </ol>
        <form
          className="mt-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitKey();
          }}
        >
          <div className="grid grid-cols-2 gap-2.5">
            <label className="text-muted-foreground text-xs">
              Access key
              <Input
                className="mt-1.5 font-mono"
                autoComplete="off"
                spellCheck={false}
                value={accessKeyId}
                aria-invalid={keyError !== null}
                onChange={(event) => setAccessKeyId(event.target.value)}
              />
            </label>
            <label className="text-muted-foreground text-xs">
              Secret key
              <div className="relative mt-1.5">
                <Input
                  className="pr-9 font-mono"
                  type={showSecret ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  value={secretKey}
                  aria-invalid={keyError !== null}
                  onChange={(event) => setSecretKey(event.target.value)}
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
                  aria-label={showSecret ? "Hide secret key" : "Show secret key"}
                  onClick={() => setShowSecret((shown) => !shown)}
                >
                  {showSecret ? (
                    <EyeSlashIcon className="size-4" />
                  ) : (
                    <EyeIcon className="size-4" />
                  )}
                </button>
              </div>
            </label>
          </div>
          {keyError !== null ? (
            <p role="alert" className="mt-2 text-destructive-foreground text-xs">
              {keyError}
            </p>
          ) : null}
          <div className="mt-4 flex items-center gap-3">
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Connecting…" : "Connect and open robot"}
            </Button>
            <p className="text-tertiary-foreground text-xs">
              Stuck?{" "}
              <button
                type="button"
                className="underline decoration-foreground/30 underline-offset-2 hover:text-foreground"
                onClick={openLocalFile}
              >
                Open a STEP file
              </button>{" "}
              instead.
            </p>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm">
        {isReviewerReady(provider) ? (
          <CheckIcon className="size-3.5 text-success" aria-hidden />
        ) : null}
        <span>
          {isReviewerReady(provider)
            ? `${reviewer.account} connected`
            : "AI reviewer not connected"}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 text-tertiary-foreground text-xs">
          {provider?.auth.email ? (
            <RedactedSensitiveText
              value={provider.auth.email}
              ariaLabel="Toggle account email visibility"
              revealTooltip="Click to reveal email"
              hideTooltip="Click to hide email"
              className="max-w-40 truncate"
            />
          ) : null}
          {provider?.auth.email && provider.auth.label ? <span>·</span> : null}
          {provider?.auth.label ? <span className="truncate">{provider.auth.label}</span> : null}
        </span>
      </div>
      <p className="mt-8 text-tertiary-foreground text-xs">
        <span className="font-medium text-foreground">Step 2 of 2</span>
      </p>
      <h1 className="mt-2 font-semibold text-[22px] tracking-tight">Add your robot</h1>
      <p className="mt-2 text-muted-foreground text-sm">
        Paste an Onshape link, or open a SolidWorks or STEP file.
      </p>
      <form
        className="mt-5 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submitLink();
        }}
      >
        <label className="block text-muted-foreground text-xs">
          Onshape link
          <Input
            className="mt-1.5"
            disabled={pending}
            placeholder="https://cad.onshape.com/documents/…"
            aria-label="Onshape link"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label className="block text-muted-foreground text-xs">
          Robot name
          <Input
            className="mt-1.5"
            disabled={pending}
            placeholder="Name, like 2026 robot"
            aria-label="Robot name"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {browserPrototype ? (
          <fieldset disabled={pending} className="space-y-2 pt-3">
            <legend className="mb-2 text-muted-foreground text-xs">
              How do you want to connect?
            </legend>
            {(
              [
                {
                  value: "key",
                  title: "I have an API key",
                  detail: "Connect with read access to your documents.",
                },
                {
                  value: "browser",
                  title: "I can't make an API key",
                  detail: "Use the Onshape browser to import and sync.",
                },
              ] as const
            ).map((method) => (
              <label
                key={method.value}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${accessMethod === method.value ? "border-foreground/70 bg-card" : "border-input"}`}
              >
                <input
                  className="mt-1 accent-foreground"
                  type="radio"
                  name="onshape-access-method"
                  value={method.value}
                  checked={accessMethod === method.value}
                  onChange={() => setAccessMethod(method.value)}
                />
                <span>
                  <span className="font-medium">{method.title}</span>
                  <span className="mt-1 block text-muted-foreground text-xs">{method.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {browserPrototype && accessMethod === "browser" ? (
          <p className="pt-1 text-muted-foreground text-sm">
            Cadsense opens the document and exports the first CAD model for you. Use a public
            Onshape document that allows STEP export.
          </p>
        ) : null}
        <div className="pt-2">
          <Button type="submit" disabled={pending}>
            {pending
              ? "Adding…"
              : browserPrototype && accessMethod === "browser"
                ? "Open browser and sync"
                : "Continue"}
          </Button>
        </div>
        {browserProgress ? (
          <p role="status" className="text-muted-foreground text-xs">
            {browserProgress}
          </p>
        ) : null}
        {linkError !== null ? (
          <p role="alert" className="text-destructive-foreground text-xs">
            {linkError}
          </p>
        ) : browserPrototype && accessMethod === "browser" ? (
          <p className="text-tertiary-foreground text-xs">
            Later Syncs use the same browser connection.
          </p>
        ) : needsKey ? (
          <p className="text-tertiary-foreground text-xs">
            The first Onshape link needs a read-only key from Onshape. We walk you through it next.
          </p>
        ) : null}
      </form>
      <div className="mt-4">
        <Button variant="outline" size="sm" onClick={openLocalFile}>
          Open a SolidWorks or STEP file
        </Button>
      </div>
    </div>
  );
}

function KeyStep({ n, children }: { readonly n: number; readonly children: ReactNode }) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-input text-muted-foreground text-xs">
        {n}
      </span>
      {children}
    </li>
  );
}
