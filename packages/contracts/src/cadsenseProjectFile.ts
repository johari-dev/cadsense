import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/** File name of the Cadsense project file resolved at the workspace root. */
export const CADSENSE_PROJECT_FILE_NAME = "cadsense.json";

/** Workspace-relative path of the design brief read on CAD reviews unless `designBrief` overrides it. */
export const CADSENSE_DESIGN_BRIEF_DEFAULT_PATH = "DESIGN.md";

/**
 * Starting contents of a new design brief. The questions sit in one HTML comment, which the brief
 * reader strips, so only the student's own sentences reach agents and an untouched template counts
 * as no brief. See CadDesignBriefSpec.md in apps/server/src/cad.
 */
export const CADSENSE_DESIGN_BRIEF_TEMPLATE = `<!--
Write below this note. Skip any question you cannot answer.

What is this mechanism, what does it do, and what did you base it on?

What moves, what does it ride on, and what is supposed to move with it?

What is missing, or only a stand-in? Name the parts. "Most bolts are not in yet" is enough. "Everything is WIP" is not.
-->

`;

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
  designBrief: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description: `Workspace-relative path to the project design brief, a markdown file agents read at the start of every CAD review as the designer's stated intent and constraints (default "${CADSENSE_DESIGN_BRIEF_DEFAULT_PATH}").`,
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
