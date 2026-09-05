import { OnshapeElementId, OnshapeProjectSource } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { onshapeProjectUrl } from "./onshapeProjects";

const source = Schema.decodeUnknownSync(OnshapeProjectSource)({
  connectionId: "00000000-0000-4000-8000-000000000001",
  host: "https://cad.onshape.com",
  documentId: "05760c4d8b40fba37db8fa48",
  workspaceType: "w",
  workspaceId: "f31b499c519e8471cced93dc",
  configuration: "",
});

describe("Onshape source presentation", () => {
  it("preserves document and revision identity without inventing an element", () => {
    expect(onshapeProjectUrl(source)).toBe(
      "https://cad.onshape.com/documents/05760c4d8b40fba37db8fa48/w/f31b499c519e8471cced93dc",
    );
  });

  it.each(["w", "v", "m"] as const)(
    "preserves %s context, enterprise host, element and opaque configuration",
    (workspaceType) => {
      const configuration = "Length=25 mm;Label=A+B & C/#?%";
      const url = new URL(
        onshapeProjectUrl({
          ...source,
          host: "https://team.onshape.com",
          workspaceType,
          elementId: OnshapeElementId.make("b53dde24ab8b46d679af9944"),
          configuration,
        }),
      );
      expect(url.origin).toBe("https://team.onshape.com");
      expect(url.pathname).toBe(
        `/documents/${source.documentId}/${workspaceType}/${source.workspaceId}/e/b53dde24ab8b46d679af9944`,
      );
      expect(url.searchParams.get("configuration")).toBe(configuration);
      expect(url.hash).toBe("");
    },
  );
});
