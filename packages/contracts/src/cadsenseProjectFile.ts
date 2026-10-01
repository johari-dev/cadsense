import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/** File name of the Cadsense project file resolved at the workspace root. */
export const CADSENSE_PROJECT_FILE_NAME = "cadsense.json";

/** Workspace-relative path of the design brief read on CAD reviews unless `designBrief` overrides it. */
export const CADSENSE_DESIGN_BRIEF_DEFAULT_PATH = "DESIGN.md";

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

const CAD_REVIEW_IGNORE_GLOB_MAX_LENGTH = 256;
const CAD_REVIEW_IGNORE_MAX_COUNT = 100;

const reviewIgnoreGlob = (description: string) =>
  trimmedNonEmpty(
    {
      description: `${description} Case-insensitive glob: "*" matches within one path segment, "**" spans segments, "?" matches one character.`,
    },
    CAD_REVIEW_IGNORE_GLOB_MAX_LENGTH,
  );

/**
 * One `reviewIgnore` entry: which CAD occurrences to exclude from review. Every listed field
 * must match, and a matching assembly excludes everything inside it.
 */
export const CadReviewIgnoreMatch = Schema.Struct({
  path: Schema.optionalKey(
    reviewIgnoreGlob(
      'Matches the occurrence path: ancestor instance names from the top level down to the component, joined with "/" (e.g. "Drivetrain <1>/Gearbox <1>/**").',
    ),
  ),
  name: Schema.optionalKey(
    reviewIgnoreGlob('Matches the instance name of an assembly or part (e.g. "*bearing*").'),
  ),
  material: Schema.optionalKey(
    reviewIgnoreGlob(
      'Matches the display name of the part\'s material in Onshape (e.g. "*steel*"). Parts without a material never match.',
    ),
  ),
})
  .annotate({
    description:
      "List at least one of path, name, or material. Every listed field must match; a matching assembly excludes everything inside it.",
  })
  .check(
    Schema.makeFilter(
      (match) =>
        match.path !== undefined || match.name !== undefined || match.material !== undefined,
      {
        title: "reviewIgnoreMatchNonEmpty",
        message: "A reviewIgnore entry needs at least one of path, name, or material.",
        // The parser reads parse options from the last check, so unknown keys fail here
        // instead of being silently stripped into a match-everything entry.
        parseOptions: { onExcessProperty: "error" },
      },
    ),
  );
export type CadReviewIgnoreMatch = typeof CadReviewIgnoreMatch.Type;

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
  reviewIgnore: Schema.optionalKey(
    Schema.Array(CadReviewIgnoreMatch)
      .check(Schema.isMaxLength(CAD_REVIEW_IGNORE_MAX_COUNT))
      .annotate({
        description:
          "Components to exclude from CAD review. Agents are told to skip them, cad_hierarchy marks them ignored, and comments cannot target them. Ignored geometry stays visible as context.",
      }),
  ),
}).annotate({
  title: "Cadsense project file",
  description:
    "Project configuration for Cadsense (cadsense.json at the workspace root). See https://cadsense.app for documentation.",
});
export type CadsenseProjectFile = typeof CadsenseProjectFile.Type;
