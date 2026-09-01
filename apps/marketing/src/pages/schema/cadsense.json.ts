import type { APIRoute } from "astro";

import { buildCadsenseProjectFileJsonSchema } from "@cadsense/shared/cadsenseProjectFile";

// Rendered at build time; published at https://cadsense.app/schema/cadsense.json so
// cadsense.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildCadsenseProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
