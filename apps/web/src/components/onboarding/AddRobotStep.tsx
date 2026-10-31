import { scopeProjectRef } from "@cadsense/client-runtime/environment";
import { squashAtomCommandFailure } from "@cadsense/client-runtime/state/runtime";
import type { EnvironmentId, OnshapeConnectionId, ServerProvider } from "@cadsense/contracts";
import { useState, type ReactNode } from "react";

import { ArrowSquareOutIcon, CheckIcon, EyeIcon, EyeSlashIcon } from "~/lib/icons";
import { openCommandPalette } from "../../commandPaletteBus";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { newProjectId } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { onshapeConnectionEnvironment } from "../../state/onshapeConnections";
import { onshapeProjectEnvironment } from "../../state/onshapeProjects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  DEFAULT_ONSHAPE_HOST,
  safeOnshapeConnectionErrorMessage,
} from "../settings/OnshapeConnectionsSettings.logic";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { Reviewer } from "./reviewerSetup.logic";

const ONSHAPE_API_KEYS_URL = "https://dev-portal.onshape.com/keys";

/**
 * Step 2 of onboarding (A6 and A7): add the first robot. An Onshape link
 * needs an API key once; when this environment has no Onshape connection
 * yet, Continue opens the key step, and connecting creates the project in
 * the same click. SolidWorks and STEP files open the existing add-project
 * form.
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
  const handleNewThread = useNewThreadHandler();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [step, setStep] = useState<"link" | "key">("link");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [pending, setPending] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  // A connection made on the key step, kept so a failed project create can
  // be retried from the link step without creating a second connection.
  const [createdConnectionId, setCreatedConnectionId] = useState<OnshapeConnectionId | null>(null);
  const connectionId =
    createdConnectionId ?? connectionsQuery.data?.connections[0]?.connectionId ?? null;

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
    if (!url.trim()) return setLinkError("Paste the link to your Onshape document.");
    if (!title.trim()) return setLinkError("Give your robot a name.");
    setLinkError(null);
    if (connectionId === null) return setStep("key");
    setPending(true);
    setLinkError(await addOnshapeRobot(connectionId));
    setPending(false);
  };

  const submitKey = async () => {
    if (!accessKeyId.trim() || !secretKey.trim()) {
      return setKeyError("Paste both codes from Onshape.");
    }
    setPending(true);
    setKeyError(null);
    const created = await createConnection({
      environmentId,
      input: {
        name: "Onshape",
        host: DEFAULT_ONSHAPE_HOST,
        accessKeyId: accessKeyId.trim(),
        secretKey: secretKey.trim(),
      },
    });
    if (created._tag === "Failure") {
      setKeyError(safeOnshapeConnectionErrorMessage(squashAtomCommandFailure(created)));
      setPending(false);
      return;
    }
    setCreatedConnectionId(created.value.connectionId);
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
        <CheckIcon className="size-3.5 text-success" aria-hidden />
        <span>{reviewer.account} connected</span>
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
        <Input
          placeholder="https://cad.onshape.com/documents/…"
          aria-label="Onshape link"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <div className="flex gap-2">
          <Input
            placeholder="Name, like 2026 robot"
            aria-label="Robot name"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Continue"}
          </Button>
        </div>
        {linkError !== null ? (
          <p role="alert" className="text-destructive-foreground text-xs">
            {linkError}
          </p>
        ) : connectionId === null ? (
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
