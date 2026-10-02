import { MAX_ONSHAPE_PROJECT_URL_LENGTH, TrimmedNonEmptyString } from "@cadsense/contracts";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { mcpCadToolDefinitions } from "../provider/CadProviderTools.ts";
import type { CadMcpToolDefinition } from "./CadMcpStdio.ts";

// What `cadsense mcp` advertises before its backend has loaded. Keep this module's imports light:
// `initialize` and `tools/list` are answered from it while the server is still starting.

export interface OnshapeApiKey {
  readonly accessKeyId: string;
  readonly secretKey: Redacted.Redacted<string>;
}

export const CadOpenInput = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_ONSHAPE_PROJECT_URL_LENGTH)),
  title: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
const openSchema = Schema.toJsonSchemaDocument(CadOpenInput);

export const CAD_MCP_INSTRUCTIONS = [
  "Cadsense reviews Onshape CAD. When the user shares a cad.onshape.com link or asks for feedback on a CAD design, call cad_open with that URL. Onshape links need this server's API key, so fetching them over HTTP only reaches a sign-in page. cad_open downloads the model, opens a review, and returns the review guidance to follow.",
  "Then inspect the model with cad_context, cad_hierarchy, cad_checks, cad_diff, cad_measure, cad_find_parts, cad_update_view, and cad_capture, and leave findings on the model with cad_comments_list, cad_comment_locate, cad_comment_inspect, and cad_comments_publish.",
  "Published comments and an HTML report stay on disk after the session. cad_open returns the report path.",
].join(" ");

export const cadMcpToolDefinitions: ReadonlyArray<CadMcpToolDefinition> = [
  {
    name: "cad_open",
    description:
      'Open Onshape CAD for review. Call this whenever the user shares a cad.onshape.com link or asks for feedback on a CAD design: Onshape links need this server\'s API key and cannot be fetched directly. Input: {url}, the URL of the Onshape tab (https://cad.onshape.com/documents/<id>/w/<id>/e/<elementId>), and an optional title. Downloads the CAD, or reuses the last download when Onshape reports no change, then returns the CAD context, the review guidance, and the report path. Large models take minutes: when status is "importing", call cad_open again with the same url. The other CAD tools act on the most recently opened review.',
    inputSchema: { ...openSchema.schema, type: "object", $defs: openSchema.definitions },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  // FeatureScript previews read scripts from the project workspace. A review's workspace is managed by
  // Cadsense, so an outside agent has no way to put a script there.
  ...mcpCadToolDefinitions.filter((tool) => tool.name !== "cad_featurescript_preview"),
];
