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

const CAD_REVIEW_SCOPE_GLOB_MAX_LENGTH = 256;
const CAD_REVIEW_SCOPE_INSTRUCTIONS_MAX_LENGTH = 2000;
const CAD_REVIEW_SCOPES_MAX_COUNT = 100;

const reviewScopeGlob = (description: string) =>
  trimmedNonEmpty(
    {
      description: `${description} Case-insensitive glob: "*" matches within one path segment, "**" spans segments, "?" matches one character.`,
    },
    CAD_REVIEW_SCOPE_GLOB_MAX_LENGTH,
  );

/** Which CAD occurrences a review scope applies to. Every listed field must match. */
export const CadReviewScopeMatch = Schema.Struct({
  path: Schema.optionalKey(
    reviewScopeGlob(
      'Matches the occurrence path: ancestor instance names from the top level down to the component, joined with "/" (e.g. "Drivetrain <1>/Gearbox <1>/**").',
    ),
  ),
  name: Schema.optionalKey(
    reviewScopeGlob('Matches the instance name of an assembly or part (e.g. "*bearing*").'),
  ),
  material: Schema.optionalKey(
    reviewScopeGlob(
      'Matches the display name of the part\'s material in Onshape (e.g. "*steel*"). Parts without a material never match.',
    ),
  ),
})
  .annotate({
    description: "Which components the scope applies to. Every listed field must match.",
  })
  .check(
    Schema.makeFilter(
      (match) =>
        match.path !== undefined || match.name !== undefined || match.material !== undefined,
      {
        title: "reviewScopeMatchNonEmpty",
        message: "A review scope match needs at least one of path, name, or material.",
        // The parser reads parse options from the last check, so unknown keys fail here
        // instead of being silently stripped into a match-everything scope.
        parseOptions: { onExcessProperty: "error" },
      },
    ),
  );
export type CadReviewScopeMatch = typeof CadReviewScopeMatch.Type;

/** A cadsense.json rule that excludes matching components from CAD review or adds review instructions for them. */
export const CadReviewScope = Schema.Struct({
  match: CadReviewScopeMatch,
  ignore: Schema.optionalKey(
    Schema.Literal(true).annotate({
      description:
        "Exclude matching components (and everything inside a matching assembly) from review. Agents are told not to inspect them and cannot publish comments on them.",
    }),
  ),
  instructions: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Review guidance for matching components, given to the agent verbatim (e.g. "The gearbox ratio is fixed by the team; do not question it.").',
      },
      CAD_REVIEW_SCOPE_INSTRUCTIONS_MAX_LENGTH,
    ),
  ),
})
  .annotate({
    description:
      "A review scope: components to ignore, or components with specific review instructions.",
  })
  .check(
    Schema.makeFilter((scope) => (scope.ignore === true) !== (scope.instructions !== undefined), {
      title: "reviewScopeAction",
      message: "A review scope needs exactly one of ignore: true or instructions.",
      parseOptions: { onExcessProperty: "error" },
    }),
  );
export type CadReviewScope = typeof CadReviewScope.Type;

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
  reviewScopes: Schema.optionalKey(
    Schema.Array(CadReviewScope).check(Schema.isMaxLength(CAD_REVIEW_SCOPES_MAX_COUNT)).annotate({
      description:
        "CAD review scopes, checked in order. Ignore scopes exclude components from review; instruction scopes give the agent guidance for matching components.",
    }),
  ),
}).annotate({
  title: "Cadsense project file",
  description:
    "Project configuration for Cadsense (cadsense.json at the workspace root). See https://cadsense.app for documentation.",
});
export type CadsenseProjectFile = typeof CadsenseProjectFile.Type;
