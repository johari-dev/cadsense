import { createFileRoute } from "@tanstack/react-router";
import { CadStorageSettings } from "../cad/CadStorageSettings";
export const Route = createFileRoute("/settings/cad-storage")({ component: CadStorageSettings });
