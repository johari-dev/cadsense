import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ServerProviderModel } from "@cadsense/contracts";
import { BUNDLED_MODEL_MANIFEST, classifyModels, isLegacyModel } from "./ModelManifest.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");

describe("isLegacyModel (bundled manifest)", () => {
  it("keeps current Codex models out of legacy models", () => {
    assert.deepStrictEqual(
      [
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
        "gpt-daybreak-blue-latest",
        "gpt-daybreak-red-latest",
        "gpt-5.4",
      ].map((model) => [model, isLegacyModel(BUNDLED_MODEL_MANIFEST, CODEX, model)]),
      [
        ["gpt-5.6-luna", false],
        ["gpt-5.6-terra", false],
        ["gpt-5.6-sol", false],
        ["gpt-daybreak-blue-latest", false],
        ["gpt-daybreak-red-latest", false],
        ["gpt-5.4", true],
      ],
    );
  });

  it("keeps only the Claude 5 family out of legacy models", () => {
    assert.deepStrictEqual(
      ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"].map((model) => [
        model,
        isLegacyModel(BUNDLED_MODEL_MANIFEST, CLAUDE, model),
      ]),
      [
        ["claude-fable-5", false],
        ["claude-opus-5", false],
        ["claude-sonnet-5", false],
        ["claude-opus-4-8", true],
      ],
    );
  });

  it("leaves driver kinds without a manifest entry unflagged", () => {
    assert.isFalse(isLegacyModel(BUNDLED_MODEL_MANIFEST, CURSOR, "composer-1.5"));
  });
});

const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "gpt-test",
  name: "GPT Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

describe("classifyModels", () => {
  it("flags non-current models, clears stale flags, and skips custom models", () => {
    const models = [
      model({ slug: "gpt-5.6-sol" }),
      // Stale flag from a previous classification pass must be cleared.
      model({ slug: "gpt-5.6-luna", isLegacy: true }),
      model({ slug: "gpt-5.4" }),
      // Custom models are user-defined and never reclassified.
      model({ slug: "my-own-model", isCustom: true }),
    ];
    assert.deepStrictEqual(
      classifyModels(models, BUNDLED_MODEL_MANIFEST, CODEX).map((entry) => [
        entry.slug,
        entry.isLegacy ?? false,
      ]),
      [
        ["gpt-5.6-sol", false],
        ["gpt-5.6-luna", false],
        ["gpt-5.4", true],
        ["my-own-model", false],
      ],
    );
  });
});
