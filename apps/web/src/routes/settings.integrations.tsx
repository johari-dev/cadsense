import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsSettingsPanel } from "../components/settings/IntegrationsSettings";
import { parseOnshapeSettingsSearch } from "../lib/onshapeSettingsEnvironment";

function SettingsIntegrationsRoute() {
  const { environmentId } = Route.useSearch();
  return <IntegrationsSettingsPanel onshapeEnvironmentId={environmentId} />;
}

export const Route = createFileRoute("/settings/integrations")({
  validateSearch: parseOnshapeSettingsSearch,
  component: SettingsIntegrationsRoute,
});
