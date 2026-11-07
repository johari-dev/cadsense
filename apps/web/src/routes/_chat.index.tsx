import { scopeProjectRef } from "@cadsense/client-runtime/environment";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowCounterClockwiseIcon as RotateCcwIcon } from "~/lib/icons";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { needsOnboarding } from "../components/onboarding/importCad.logic";
import { Onboarding } from "../components/onboarding/Onboarding";
import { SidebarInset } from "../components/ui/sidebar";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";

function ChatIndexRouteView() {
  return <IndexDraftLanding />;
}

/**
 * Landing on the index route drops straight into a draft thread for the most
 * recently active project, so the first screen is a prompt instead of a dead
 * end. Shows onboarding (connect an AI reviewer, add CAD, import it)
 * when no project exists yet, or when the only one is still in its first
 * import (`needsOnboarding`). The choice is made once the shells load and then
 * kept, so onboarding stays up after its project exists until the user opens it.
 */
function IndexDraftLanding() {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });
  const [landing, setLanding] = useState<"onboarding" | "draft" | null>(null);
  // Losing every project (say, removing the last one) returns to onboarding too.
  if (bootstrapped && (landing === null || (projects.length === 0 && landing === "draft"))) {
    setLanding(needsOnboarding(projects, threads) ? "onboarding" : "draft");
  }

  const mostRecentProject = useMemo(() => {
    if (!bootstrapped) return null;
    const latestActivity = new Map<string, number>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.projectId}`;
      const timestamp = Date.parse(thread.updatedAt ?? thread.createdAt);
      latestActivity.set(key, Math.max(latestActivity.get(key) ?? 0, timestamp));
    }
    return (
      [...projects].sort((left, right) => {
        const rightTimestamp =
          latestActivity.get(`${right.environmentId}:${right.id}`) ?? Date.parse(right.updatedAt);
        const leftTimestamp =
          latestActivity.get(`${left.environmentId}:${left.id}`) ?? Date.parse(left.updatedAt);
        return rightTimestamp - leftTimestamp;
      })[0] ?? null
    );
  }, [bootstrapped, projects, threads]);

  useEffect(() => {
    if (landing !== "draft" || mostRecentProject === null || startingRef.current) {
      return;
    }
    startingRef.current = true;
    // The landing only forwards, so settings opened at `/` stays open over the draft.
    void handleNewThread(scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id), {
      replace: true,
      keepSearch: true,
    }).catch(() => {
      startingRef.current = false;
      setStartState((state) => ({ ...state, failed: true }));
    });
  }, [handleNewThread, landing, mostRecentProject, startState.retryRequest]);

  if (landing === null) {
    return null;
  }
  if (landing === "onboarding") {
    return <Onboarding project={mostRecentProject} />;
  }
  if (mostRecentProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  return null;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground">
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RotateCcwIcon className="size-4" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
