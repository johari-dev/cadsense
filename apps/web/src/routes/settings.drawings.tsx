import { createFileRoute } from "@tanstack/react-router";
import { DrawingsSettingsPanel } from "../components/settings/SettingsPanels";
export const Route = createFileRoute("/settings/drawings")({ component: DrawingsSettingsPanel });
