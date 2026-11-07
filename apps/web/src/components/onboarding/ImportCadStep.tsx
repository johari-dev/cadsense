import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cadsense/client-runtime/state/runtime";
import {
  CadUserOperationError,
  isSolidWorksFile,
  type CadUserStartInput,
} from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ElapsedClock } from "../../cad/CadOperationComposerBanner";
import { refusedDescription } from "../../cad/CadSyncButton";
import { onshapeProjectEnvironment } from "../../state/onshapeProjects";
import { useAtomCommand } from "../../state/use-atom-command";
import type { Project } from "../../types";
import { Button } from "../ui/button";
import { StepRow, type StepMarkKind } from "./Checklist";
import { firstImportPlan, importCadStage } from "./importCad.logic";

const isCadUserOperationError = Schema.is(CadUserOperationError);

/** The name of the Assembly or Part Studio the import downloads, from the catalog, if known. */
function targetName(project: Project): string | null {
  const plan = firstImportPlan(project);
  const elementId =
    project.cad?.operation?.root?.elementId ?? (plan?.kind === "sync" ? plan.root.elementId : null);
  return project.cad?.catalog?.roots.find((root) => root.elementId === elementId)?.name ?? null;
}

/**
 * Step 3 of onboarding: the project's first import. It moves along by itself. A local file's
 * import starts when the project is created. An Onshape project refreshes its catalog, then syncs
 * the element its link names, the same plan as the CAD panel's Sync button (`firstImportPlan`). When the link names no
 * Assembly or Part Studio, the user picks one from the catalog. A failure shows its reason and a
 * retry. Everything reads from the project's live CAD state, so a reload resumes the same step.
 */
export function ImportCadStep({ project }: { readonly project: Project }) {
  const start = useAtomCommand(onshapeProjectEnvironment.startCadOperation, {
    reportFailure: false,
  });
  const [startError, setStartError] = useState<string | null>(null);
  const stage = importCadStage(project);
  const cad = project.cad;

  const run = async (input: CadUserStartInput, quietIfBusy = false) => {
    setStartError(null);
    const result = await start({ environmentId: project.environmentId, input });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    // Another window, or the server's own import of a new local project, got there first.
    if (quietIfBusy && isCadUserOperationError(cause) && cause.reason === "busy") return;
    setStartError(refusedDescription(cause));
  };
  // With nothing left to plan (an Onshape document with nothing importable), Try again reads the
  // document again, in case the student added an Assembly since.
  const runPlan = (quietIfBusy = false) => {
    const plan =
      firstImportPlan(project) ?? (project.onshapeSource ? { kind: "discover" as const } : null);
    if (!plan) return;
    void run(
      plan.kind === "sync"
        ? { projectId: project.id, kind: "sync", root: plan.root }
        : { projectId: project.id, kind: "discover" },
      quietIfBusy,
    );
  };

  // Each idle state starts at most once, keyed by the outcome that led to it, so a refused start
  // waits for Try again instead of looping.
  const autoStartKey =
    stage.kind === "starting" ? `${project.id}:${cad?.lastOutcome?.operationId ?? "new"}` : null;
  const startedKey = useRef<string | null>(null);
  useEffect(() => {
    if (autoStartKey === null || startedKey.current === autoStartKey) return;
    startedKey.current = autoStartKey;
    runPlan(true);
  }, [autoStartKey]);

  const failedAt = stage.kind === "failed" ? (cad?.lastOutcome?.kind ?? "sync") : null;
  const retry = (
    <Button size="sm" className="mt-3" onClick={() => runPlan()}>
      Try again
    </Button>
  );
  const elapsed =
    stage.kind === "reading" || stage.kind === "importing" ? (
      <p className="mt-1 text-tertiary-foreground text-xs tabular-nums">
        <ElapsedClock startedAt={stage.startedAt} />
      </p>
    ) : null;
  const failure =
    stage.kind === "failed" ? (
      <>
        <p className="mt-1 break-words text-muted-foreground text-xs">{stage.reason}</p>
        {retry}
      </>
    ) : null;

  const local = project.localCadSource;
  if (local) {
    const mark: StepMarkKind =
      stage.kind === "done" ? "done" : stage.kind === "failed" ? "failed" : "waiting";
    return (
      <>
        <div className="rounded-lg border border-border bg-background/40">
          <StepRow mark={mark}>
            <p className="break-all">
              {isSolidWorksFile(local.filePath)
                ? `Convert ${local.filePath} with SolidWorks`
                : `Import ${local.filePath}`}
            </p>
            {elapsed}
            {failure}
          </StepRow>
        </div>
        <StartError message={startError} retry={stage.kind === "starting" ? retry : null} />
      </>
    );
  }

  const name = targetName(project);
  const readMark: StepMarkKind = cad?.catalog
    ? "done"
    : failedAt === "discover"
      ? "failed"
      : "waiting";
  const downloadMark: StepMarkKind =
    stage.kind === "done"
      ? "done"
      : failedAt === "sync"
        ? "failed"
        : stage.kind === "importing" || (stage.kind === "starting" && cad?.catalog)
          ? "waiting"
          : "pending";
  return (
    <>
      <div className="rounded-lg border border-border bg-background/40">
        <StepRow mark={readMark}>
          <p>Read your Onshape document</p>
          {readMark === "waiting" ? elapsed : null}
          {failedAt === "discover" ? failure : null}
        </StepRow>
        <div className="h-px bg-border" />
        <StepRow mark={downloadMark}>
          <p className={downloadMark === "pending" ? "text-tertiary-foreground" : undefined}>
            {name ? (
              <>
                Download <span className="font-medium">{name}</span>
              </>
            ) : (
              "Download your CAD"
            )}
          </p>
          {downloadMark === "waiting" ? (
            <>
              {elapsed}
              <p className="mt-1 text-tertiary-foreground text-xs">
                Big assemblies can take a few minutes.
              </p>
            </>
          ) : null}
          {failedAt === "sync" ? failure : null}
        </StepRow>
      </div>
      {stage.kind === "choose" ? (
        <ChooseRoot
          roots={cad?.catalog?.roots ?? []}
          linkStatus={cad?.catalog?.sourceElement?.status ?? null}
          onChoose={(root) =>
            void run({
              projectId: project.id,
              kind: "sync",
              root: { elementId: root.elementId, kind: root.kind, configuration: "default" },
            })
          }
        />
      ) : null}
      <StartError message={startError} retry={stage.kind === "starting" ? retry : null} />
    </>
  );
}

/**
 * Why the server refused to start the import. `retry` shows when nothing else on screen can start
 * it again: an automatic start that was refused leaves the step idle, and it starts only once.
 */
function StartError({
  message,
  retry,
}: {
  readonly message: string | null;
  readonly retry: ReactNode;
}) {
  return message === null ? null : (
    <div key={message} className="onboarding-swap">
      <p role="alert" className="mt-2 text-destructive-foreground text-xs">
        {message}
      </p>
      {retry}
    </div>
  );
}

type Catalog = NonNullable<NonNullable<Project["cad"]>["catalog"]>;
type CatalogRoot = Catalog["roots"][number];
type LinkStatus = NonNullable<Catalog["sourceElement"]>["status"];

/** Why the link gave nothing to import, by what the catalog says about the tab it names. */
const CHOOSE_REASON: Record<LinkStatus | "none", string> = {
  none: "Your link opens the whole document.",
  missing: "The tab your link points to is no longer in the document.",
  unsupported: "Your link points to a tab Cadsense can't import, like a Drawing.",
  available: "Your link points to a tab Cadsense can't import.",
};

/**
 * The catalog's Assemblies, then Part Studios, for a link that names neither. `linkStatus` is the
 * catalog's status for the tab the link names, or null when it names none.
 */
function ChooseRoot({
  roots,
  linkStatus,
  onChoose,
}: {
  readonly roots: ReadonlyArray<CatalogRoot>;
  readonly linkStatus: LinkStatus | null;
  readonly onChoose: (root: CatalogRoot) => void;
}) {
  const ordered = roots.toSorted(
    (left, right) => Number(right.kind === "assembly") - Number(left.kind === "assembly"),
  );
  return (
    <div className="onboarding-swap mt-3">
      <p className="text-muted-foreground text-xs">
        {CHOOSE_REASON[linkStatus ?? "none"]} Pick what Cadsense should review.
      </p>
      <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-border">
        {ordered.map((root) => (
          <button
            key={root.elementId}
            type="button"
            className="flex w-full items-center gap-3 border-border border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
            onClick={() => onChoose(root)}
          >
            <span className="min-w-0 flex-1 truncate">{root.name}</span>
            <span className="shrink-0 text-tertiary-foreground text-xs">
              {root.kind === "assembly" ? "Assembly" : "Part Studio"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
