import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@cadsense/client-runtime/environment";
import type { ScopedThreadRef } from "@cadsense/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useLayoutEffect } from "react";
import { cadPanelEnvironment } from "../state/cadPanel";
import { useRightPanelStore } from "../rightPanelStore";
import type { Project } from "../types";
import { CadPanel } from "./CadPanel";
import { CadFloatingPreview } from "./CadFloatingPreview";
import { useCadFloatingStore } from "./cadFloatingStore";

/** Watch metadata even when CAD is closed; only mount the renderer when it is shown. */
export function CadAutoPreview({
  project,
  threadRef,
  runId,
  inPanel,
  panelPresent,
  bottomInset,
}: {
  project: Project;
  threadRef: ScopedThreadRef;
  runId: string | null;
  inPanel: boolean;
  panelPresent: boolean;
  bottomInset: number;
}) {
  const state = useAtomValue(
    cadPanelEnvironment.watch({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const data = AsyncResult.isSuccess(state) ? state.value : null;
  const visible = useCadFloatingStore(
    (store) => store.byThread[scopedThreadKey(threadRef)]?.visible ?? false,
  );
  const activityTurn = data?.agentActivityTurnId ?? null;
  const noticeRun = runId ?? activityTurn;
  useLayoutEffect(() => {
    if (noticeRun && activityTurn && (data?.agentControlling || activityTurn === runId))
      useCadFloatingStore.getState().observe(threadRef, noticeRun, inPanel);
  }, [activityTurn, noticeRun, runId, data?.agentControlling, inPanel, threadRef]);
  const close = () => useCadFloatingStore.getState().dismiss(threadRef, noticeRun);
  if (!visible || panelPresent || inPanel) return null;
  return (
    <CadFloatingPreview
      bottomInset={bottomInset}
      onClose={close}
      onDock={() => {
        close();
        useRightPanelStore.getState().open(threadRef, "cad");
      }}
    >
      <CadPanel compact project={project} threadRef={threadRef} />
    </CadFloatingPreview>
  );
}
