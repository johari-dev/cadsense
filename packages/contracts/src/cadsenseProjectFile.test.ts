import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CadsenseProjectFile } from "./cadsenseProjectFile.ts";

const decode = Schema.decodeUnknownSync(CadsenseProjectFile);

describe("CadsenseProjectFile", () => {
  it("decodes a project file", () => {
    const decoded = decode({
      $schema: "https://cadsense.app/schema/cadsense.json",
      iconPath: "assets/logo.svg",
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
  });

  it("decodes an empty object and ignores unknown fields", () => {
    expect(decode({})).toEqual({});
    expect(decode({ futureField: true })).toEqual({});
  });

  it("trims icon paths", () => {
    const decoded = decode({
      iconPath: " assets/logo.svg ",
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
  });
});
