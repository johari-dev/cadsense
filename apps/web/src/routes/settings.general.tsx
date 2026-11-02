import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

function SettingsGeneralRoute() {
  // Restoring defaults remounts the panel so draft inputs drop their local edits.
  const [restoreCount, setRestoreCount] = useState(0);
  return (
    <GeneralSettingsPanel
      key={restoreCount}
      onRestored={() => setRestoreCount((count) => count + 1)}
    />
  );
}

export const Route = createFileRoute("/settings/general")({
  component: SettingsGeneralRoute,
});
