import { createFileRoute } from "@tanstack/react-router";

import { ProjectSettingsPage } from "../components/settings/ProjectSettingsPanel";

export const Route = createFileRoute("/projects/$projectKey")({
  component: () => <ProjectSettingsPage projectKey={Route.useParams().projectKey} />,
});
