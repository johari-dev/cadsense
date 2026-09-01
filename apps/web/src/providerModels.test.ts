import { ProviderDriverKind, type ServerProviderModel } from "@cadsense/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderModelCapabilities } from "./providerModels";

describe("getProviderModelCapabilities", () => {
  it("removes provider-reported plan agent options", () => {
    const model: ServerProviderModel = {
      slug: "model",
      name: "Model",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "agent",
            label: "Agent",
            type: "select",
            options: [
              { id: "build", label: "Build", isDefault: true },
              { id: "plan", label: "Plan" },
            ],
            currentValue: "plan",
          },
        ],
      },
    };

    expect(
      getProviderModelCapabilities([model], model.slug, ProviderDriverKind.make("codex"))
        .optionDescriptors,
    ).toEqual([
      {
        id: "agent",
        label: "Agent",
        type: "select",
        options: [{ id: "build", label: "Build", isDefault: true }],
        currentValue: "build",
      },
    ]);
  });
});
