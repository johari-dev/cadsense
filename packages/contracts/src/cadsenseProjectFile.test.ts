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

  it("decodes review scopes", () => {
    const decoded = decode({
      reviewScopes: [
        { match: { path: "Drivetrain <1>/**" }, instructions: " Gearbox ratio is fixed. " },
        { match: { name: "*bolt*", material: "*steel*" }, ignore: true },
      ],
    });

    expect(decoded.reviewScopes).toEqual([
      { match: { path: "Drivetrain <1>/**" }, instructions: "Gearbox ratio is fixed." },
      { match: { name: "*bolt*", material: "*steel*" }, ignore: true },
    ]);
  });

  it.each([
    [
      "ignore and instructions together",
      { match: { name: "Bolt" }, ignore: true, instructions: "x" },
    ],
    ["neither ignore nor instructions", { match: { name: "Bolt" } }],
    ["ignore: false", { match: { name: "Bolt" }, ignore: false }],
    ["an empty match", { match: {}, ignore: true }],
    ["an unknown match field", { match: { pth: "Drivetrain/**" }, ignore: true }],
    ["an unknown scope field", { match: { name: "Bolt" }, ignore: true, note: "x" }],
    ["an empty instruction", { match: { name: "Bolt" }, instructions: " " }],
  ])("rejects a review scope with %s", (_label, scope) => {
    expect(() => decode({ reviewScopes: [scope] })).toThrow();
  });

  it("trims icon paths", () => {
    const decoded = decode({
      iconPath: " assets/logo.svg ",
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
  });

  it("decodes and trims the design brief path", () => {
    expect(decode({ designBrief: " docs/brief.md " }).designBrief).toBe("docs/brief.md");
    expect(() => decode({ designBrief: "" })).toThrow();
  });
});
