import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("cadsense/no-slice-truncation");

describe("cadsense/no-slice-truncation", () => {
  rule.valid(
    "allows clip beside an ellipsis",
    `
      import { clip } from "@cadsense/shared/String";
      export const label = (name: string) =>
        name.length > 42 ? \`\${clip(name, 39)}...\` : name;
      export const tail = (output: string) => \`\u{2026}\${clip(output, 500, "end")}\`;
    `,
  );

  rule.valid(
    "allows array slices, which no rule without types can tell from text",
    `
      export const page = (items: readonly string[]) => items.slice(0, 20);
      export const shown = (labels: readonly string[]) =>
        \`Conflicts with \${labels.slice(0, 3).join(", ")}\${labels.length > 3 ? ", and more" : ""}.\`;
      export const recent = (entries: readonly string[]) => entries.slice(-100);
    `,
  );

  rule.valid(
    "allows a slice that is not beside an ellipsis",
    `
      export const key = (kind: string, digest: string) => \`check-\${kind}-\${digest.slice(0, 6)}\`;
      export const insert = (prompt: string, cursor: number, text: string) =>
        \`\${prompt.slice(0, cursor)}\${text}\${prompt.slice(cursor)}\`;
      export const capitalize = (key: string) => key.slice(0, 1).toUpperCase() + key.slice(1);
      export const rest = (text: string, start: number) => \`...\${text.slice(start)}\`;
    `,
  );

  rule.invalid(
    "reports a slice before a one character ellipsis",
    `
      export const bounded = (value: string, limit: number) =>
        value.length <= limit ? value : \`\${value.slice(0, limit - 1)}\u{2026}\`;
    `,
    (output) => {
      assert.match(output, /clip from @cadsense\/shared\/String/);
    },
  );

  rule.invalid(
    "reports a slice before three dots",
    `
      export const label = (name: string) =>
        name.length > 42 ? \`\${name.slice(0, 39)}...\` : name;
    `,
  );

  rule.invalid(
    "reports a slice that is trimmed before the ellipsis",
    `
      export const preview = (value: string, max: number) =>
        \`\${value.slice(0, max - 1).trimEnd()}\u{2026}\`;
    `,
  );

  rule.invalid(
    "reports a tail slice after an ellipsis",
    `
      export const tail = (output: string, max: number) => \`\u{2026}\${output.slice(-max)}\`;
    `,
  );

  rule.invalid(
    "reports substring and string concatenation",
    `
      export const short = (text: string) => text.substring(0, 80) + "...";
    `,
  );

  rule.invalid(
    "reports the cut inside a nested template",
    `
      export const reason = (detail: string, room: number, suffix: string) =>
        \`\${detail.length > room ? \`\${detail.slice(0, room - 1)}\u{2026}\` : detail}\${suffix}\`;
    `,
  );
});
