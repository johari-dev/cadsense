import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { CadsenseProjectFile, CADSENSE_PROJECT_FILE_SCHEMA_URL } from "@cadsense/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `cadsense.json` file contents (lenient JSONC string) and the
 * decoded {@link CadsenseProjectFile}.
 */
export const CadsenseProjectFileFromJson = fromLenientJson(CadsenseProjectFile);

const decodeCadsenseProjectFile = Schema.decodeExit(CadsenseProjectFileFromJson);

/**
 * Decode raw `cadsense.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseCadsenseProjectFile(contents: string): CadsenseProjectFile | null {
  const decoded = decodeCadsenseProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `cadsense.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link CADSENSE_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildCadsenseProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(CadsenseProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: CADSENSE_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
