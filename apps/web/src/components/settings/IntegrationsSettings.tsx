/**
 * Integrations settings: services Cadsense connects to. Onshape is the only one shown.
 *
 * The agent browser section (agent access, default viewport, zoom, appearance, and the
 * floating preview) is hidden for now. Those settings keep their stored values, which
 * default to agent access on and the preview's standard defaults.
 *
 * @module IntegrationsSettings
 */
import type { EnvironmentId } from "@cadsense/contracts";

import { SettingsPageContainer } from "./settingsLayout";
import { OnshapeConnectionsSettings } from "./OnshapeConnectionsSettings";

export function IntegrationsSettingsPanel({
  onshapeEnvironmentId,
}: {
  onshapeEnvironmentId?: EnvironmentId | undefined;
}) {
  return (
    <SettingsPageContainer>
      <OnshapeConnectionsSettings
        key={JSON.stringify([onshapeEnvironmentId])}
        initialEnvironmentId={onshapeEnvironmentId}
      />
    </SettingsPageContainer>
  );
}
