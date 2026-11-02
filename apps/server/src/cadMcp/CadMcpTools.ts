import {
  LOCAL_CAD_FILE_EXTENSIONS,
  MAX_LOCAL_CAD_PATH_LENGTH,
  MAX_ONSHAPE_PROJECT_URL_LENGTH,
  TrimmedNonEmptyString,
} from "@cadsense/contracts";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { CAD_PANEL_TOOLS, mcpCadToolDefinitions } from "../provider/CadProviderTools.ts";
import type { CadMcpToolDefinition } from "./CadMcpStdio.ts";

// What `cadsense mcp` advertises before its backend has loaded. Keep this module's imports light:
// `initialize` and `tools/list` are answered from it while the server is still starting.

export interface OnshapeApiKey {
  readonly accessKeyId: string;
  readonly secretKey: Redacted.Redacted<string>;
}

const LocalPath = TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_LOCAL_CAD_PATH_LENGTH));

/** Exactly one of `url` and `file`; `folder` only with `file`. cad_open checks that after decoding. */
export const CadOpenInput = Schema.Struct({
  url: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_ONSHAPE_PROJECT_URL_LENGTH)),
  ),
  file: Schema.optionalKey(LocalPath),
  folder: Schema.optionalKey(LocalPath),
  title: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
const openSchema = Schema.toJsonSchemaDocument(CadOpenInput);
const localExtensions = LOCAL_CAD_FILE_EXTENSIONS.join(", ");

export const CAD_MCP_INSTRUCTIONS = [
  `Cadsense reviews CAD from Onshape or from a CAD file on this machine (${localExtensions}). When the user shares a cad.onshape.com link, names a local CAD file, or asks for feedback on a CAD design, call cad_open with {url} for the Onshape link or {file} for the file's path. Onshape links need this server's API key, so fetching them over HTTP only reaches a sign-in page. Local files need no key. cad_open downloads or imports the model, opens a review, and returns the review guidance to follow.`,
  "Then inspect the model with cad_context, cad_hierarchy, cad_checks, cad_diff, cad_measure, cad_find_parts, cad_drive_options, cad_update_view, and cad_capture, and leave findings on the model with cad_comments_list, cad_comment_locate, cad_comment_inspect, and cad_comments_publish.",
  "Published comments and an HTML report stay on disk after the session. cad_open returns the report path.",
].join(" ");

export const cadMcpToolDefinitions: ReadonlyArray<CadMcpToolDefinition> = [
  {
    name: "cad_open",
    description: `Open CAD for review, from Onshape or from a CAD file on this machine. Call this whenever the user shares a cad.onshape.com link, names a local CAD file (${localExtensions}), or asks for feedback on a CAD design: Onshape links need this server's API key and cannot be fetched directly. Pass exactly one of {url}, the URL of the Onshape tab (https://cad.onshape.com/documents/<id>/w/<id>/e/<elementId>), or {file}, the path of a local CAD file, absolute or relative to your working directory. Local files need no Onshape key; for other formats, export a STEP file and pass that. With {file}, an optional {folder} is the project folder, which must contain the file and defaults to the file's own folder; pass it when an assembly's files sit in sibling folders. An optional {title} names the review. Downloads or imports the CAD, or reuses the last one when nothing changed, then returns the CAD context, the review guidance, and the report path. Large models take minutes: when status is "importing", call cad_open again with the same input. The other CAD tools act on the most recently opened review.`,
    inputSchema: { ...openSchema.schema, type: "object", $defs: openSchema.definitions },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  // Panel tools need the app beside the chat. FeatureScript previews read scripts from the project
  // workspace, and a review's workspace is managed by Cadsense, so an outside agent has no way to
  // put a script there.
  ...mcpCadToolDefinitions.filter(
    (tool) => !CAD_PANEL_TOOLS.has(tool.name) && tool.name !== "cad_featurescript_preview",
  ),
];
