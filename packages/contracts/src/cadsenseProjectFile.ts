import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/** File name of the Cadsense project file resolved at the workspace root. */
export const CADSENSE_PROJECT_FILE_NAME = "cadsense.json";

/** Public URL of the published JSON Schema for {@link CadsenseProjectFile}. */
export const CADSENSE_PROJECT_FILE_SCHEMA_URL = "https://cadsense.app/schema/cadsense.json";

const CADSENSE_PROJECT_FILE_PATH_MAX_LENGTH = 512;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const CadsenseProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${CADSENSE_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before Cadsense\'s built-in icon locations.',
      },
      CADSENSE_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
}).annotate({
  title: "Cadsense project file",
  description:
    "Project configuration for Cadsense (cadsense.json at the workspace root). See https://cadsense.app for documentation.",
});
export type CadsenseProjectFile = typeof CadsenseProjectFile.Type;
