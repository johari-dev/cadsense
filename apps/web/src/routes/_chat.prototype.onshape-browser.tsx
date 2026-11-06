// Throwaway entry for inspecting onboarding even after the first robot was added.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@cadsense/contracts";
import { AddRobotStep } from "../components/onboarding/AddRobotStep";
import { REVIEWERS, isReviewerReady } from "../components/onboarding/reviewerSetup.logic";
import { isOnshapeBrowserPrototype } from "../components/onboarding/onshapeBrowserPrototype";
import { SidebarInset } from "../components/ui/sidebar";
import { usePrimaryEnvironmentId } from "../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";

/** The selected CAD setup preview skips AI sign-in, and reports the real provider status. */
function BrowserOnboardingPreview() {
  const environmentId = usePrimaryEnvironmentId();
  if (!isOnshapeBrowserPrototype()) throw notFound();
  return environmentId ? <RobotSetup environmentId={environmentId} /> : null;
}

function RobotSetup({ environmentId }: { environmentId: EnvironmentId }) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const reviewer =
    REVIEWERS.find((reviewer) =>
      isReviewerReady(providers.find((provider) => provider.instanceId === reviewer.instanceId)),
    ) ?? REVIEWERS[0];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 overflow-y-auto">
        <div className="m-auto w-full max-w-[30rem] px-6 py-12">
          <AddRobotStep
            environmentId={environmentId}
            reviewer={reviewer}
            provider={providers.find((provider) => provider.instanceId === reviewer.instanceId)}
            providers={providers}
          />
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/prototype/onshape-browser")({
  component: BrowserOnboardingPreview,
});
