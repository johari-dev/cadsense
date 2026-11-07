import { squashAtomCommandFailure } from "@cadsense/client-runtime/state/runtime";
import {
  ONSHAPE_PUBLIC_STACK_ORIGIN,
  onshapeStackOrigin,
  type EnvironmentId,
  type OnshapeConnectionId,
  type OnshapeConnectionSummary,
  type ServerProvider,
} from "@cadsense/contracts";
import { useState, type ReactNode } from "react";

import { ArrowSquareOutIcon, EyeIcon, EyeSlashIcon, FileIcon } from "~/lib/icons";
import { newProjectId } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { localCadProjectEnvironment } from "../../state/localCadProjects";
import { onshapeConnectionEnvironment } from "../../state/onshapeConnections";
import { onshapeProjectEnvironment } from "../../state/onshapeProjects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { nativeCadFilePicker } from "../AddProjectDialog";
import { LocalCadProjectCreateForm } from "../LocalCadProjectCreateForm";
import { safeOnshapeConnectionErrorMessage } from "../settings/OnshapeConnectionsSettings.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

// Onshape's API keys page, relative to a stack origin (cad.onshape.com or an
// Enterprise domain).
const ONSHAPE_API_KEYS_PATH = "/user/developer/apiKeys";

/** The message for a failed create, from its settled result. */
const createFailure = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : "Cadsense could not add this CAD.";
};

/**
 * Step 2 of onboarding: add the first CAD, from an Onshape link or a CAD file on this computer.
 * An Onshape link needs an API key once per Onshape stack; when this environment has no
 * connection on the link's stack (cad.onshape.com, or an Enterprise domain like
 * 1678.onshape.com), Continue opens the key step, and connecting creates the project in the same
 * click. A created project ends the step: onboarding moves on to its import, so the form stays
 * busy instead of resetting.
 */
export function AddCadStep({
  environmentId,
  providers,
}: {
  readonly environmentId: EnvironmentId;
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
  const [source, setSource] = useState<"onshape" | "file">("onshape");
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
  const linkHostname = linkStack === null ? null : new URL(linkStack).hostname;

  /** Creates the Onshape project. Returns an error, or null once the project exists. */
  const addOnshapeProject = async (connectionId: OnshapeConnectionId): Promise<string | null> => {
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
    return result._tag === "Failure" ? createFailure(result) : null;
  };

  const submitLink = async () => {
    if (!url.trim()) return setLinkError("Paste the link to your Onshape document.");
    if (!title.trim()) return setLinkError("Give your CAD a name.");
    if (linkStack === null) {
      return setLinkError("Paste the full Onshape link from your browser, starting with https://.");
    }
    setLinkError(null);
    if (linkConnection === undefined) return setStep("key");
    setPending(true);
    const error = await addOnshapeProject(linkConnection.connectionId);
    if (error === null) return;
    setLinkError(error);
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
    const projectError = await addOnshapeProject(created.value.connectionId);
    if (projectError === null) return;
    setLinkError(projectError);
    setStep("link");
    setPending(false);
  };

  if (step === "key") {
    return (
      <div key="key" className="onboarding-enter-x">
        <button
          type="button"
          className="text-muted-foreground text-xs underline decoration-foreground/30 underline-offset-2 hover:text-foreground"
          onClick={() => setStep("link")}
        >
          Back
        </button>
        <p className="mt-1.5 font-medium text-sm">Let Cadsense read your Onshape documents</p>
        {/* A key only works on the Onshape stack it was made on. */}
        {linkStack !== null && linkStack !== ONSHAPE_PUBLIC_STACK_ORIGIN ? (
          <p className="mt-1 text-muted-foreground text-xs">
            This link is on <b className="font-medium">{linkHostname}</b>, so make the key with the
            Onshape account you use there.
          </p>
        ) : null}
        <ol className="mt-3 space-y-2.5 text-sm">
          <KeyStep n={1}>
            <span className="flex-1">Open Onshape's API keys page and sign in.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void readLocalApi()?.shell.openExternal(
                  `${linkStack ?? ONSHAPE_PUBLIC_STACK_ORIGIN}${ONSHAPE_API_KEYS_PATH}`,
                )
              }
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
          className="mt-4"
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
            <p
              key={keyError}
              role="alert"
              className="onboarding-swap mt-2 text-destructive-foreground text-xs"
            >
              {keyError}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Connecting…" : "Connect and add CAD"}
            </Button>
            <p className="text-tertiary-foreground text-xs">
              Stuck?{" "}
              <button
                type="button"
                className="underline decoration-foreground/30 underline-offset-2 hover:text-foreground"
                onClick={() => {
                  setStep("link");
                  setSource("file");
                }}
              >
                Use a file on this computer
              </button>{" "}
              instead.
            </p>
          </div>
        </form>
      </div>
    );
  }

  return (
    <>
      <ToggleGroup
        variant="segmented"
        value={[source]}
        disabled={pending}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "onshape" || next === "file") setSource(next);
        }}
        aria-label="Where your CAD is"
      >
        <Toggle value="onshape">
          <img src="/onshape.svg" alt="" className="size-3.5" />
          Onshape link
        </Toggle>
        <Toggle value="file">
          <FileIcon className="size-3.5" />
          File on this computer
        </Toggle>
      </ToggleGroup>
      {source === "onshape" ? (
        <form
          key="onshape"
          className="onboarding-enter-x mt-3 space-y-2"
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
              placeholder="Name, like 2026 drivetrain"
              aria-label="CAD name"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Continue"}
            </Button>
          </div>
          {linkError !== null ? (
            <p
              key={linkError}
              role="alert"
              className="onboarding-swap text-destructive-foreground text-xs"
            >
              {linkError}
            </p>
          ) : null}
        </form>
      ) : (
        <div key="file" className="onboarding-enter-x mt-3">
          <LocalFileForm environmentId={environmentId} providers={providers} />
        </div>
      )}
    </>
  );
}

/**
 * The file tab: the add-project dialog's local CAD form, inline. The desktop app opens its file
 * dialog as soon as the tab opens; a browser types a folder path and picks from its CAD files.
 */
function LocalFileForm({
  environmentId,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const { environments } = useEnvironments();
  const environment = environments.find((item) => item.environmentId === environmentId);
  const createProject = useAtomCommand(localCadProjectEnvironment.create, {
    reportFailure: false,
  });
  if (!environment) return null;
  return (
    <LocalCadProjectCreateForm
      inline
      environmentId={environmentId}
      environmentLabel={environment.label}
      connected={environment.connection.phase === "connected"}
      pickFile={nativeCadFilePicker(environment)}
      onCreate={async (input) => {
        const result = await createProject({
          environmentId,
          input: {
            ...input,
            projectId: newProjectId(),
            defaultModelSelection: resolveDefaultProviderModelSelection(providers, null),
          },
        });
        return result._tag === "Failure" ? createFailure(result) : null;
      }}
    />
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
