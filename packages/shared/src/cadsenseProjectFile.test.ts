import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCadsenseProjectFileJsonSchema,
  parseCadsenseProjectFile,
  CadsenseProjectFileFromJson,
} from "./cadsenseProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(CadsenseProjectFileFromJson);

describe("buildCadsenseProjectFileJsonSchema", () => {
  it("emits a draft 2020-12 schema with the published $id", () => {
    const schema = buildCadsenseProjectFileJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://cadsense.app/schema/cadsense.json");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("documents every supported field", () => {
    const schema = buildCadsenseProjectFileJsonSchema() as {
      properties: Record<
        string,
        {
          description?: string;
          items?: { properties: Record<string, unknown>; required: ReadonlyArray<string> };
        }
      >;
      required?: ReadonlyArray<string>;
    };

    expect(Object.keys(schema.properties).sort()).toEqual(["$schema", "iconPath"]);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.iconPath?.description).toContain("Workspace-relative path");
  });

  it("stays JSON-serializable", () => {
    const schema = buildCadsenseProjectFileJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

describe("CadsenseProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // project icon
      "iconPath": "assets/logo.svg",
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
  });

  it("fails on malformed JSON", () => {
    expect(() => decodeJson("{ not json")).toThrow();
  });
});

describe("parseCadsenseProjectFile", () => {
  it("returns the decoded file for valid contents", () => {
    expect(parseCadsenseProjectFile('{ "iconPath": "assets/logo.svg" }')).toEqual({
      iconPath: "assets/logo.svg",
    });
  });

  it("returns null for malformed or invalid contents", () => {
    expect(parseCadsenseProjectFile("{ not json")).toBeNull();
    expect(parseCadsenseProjectFile('{ "iconPath": "" }')).toBeNull();
  });
});
