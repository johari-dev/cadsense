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

  it("decodes and trims review ignore entries", () => {
    const decoded = decode({
      reviewIgnore: [{ path: " Drivetrain <1>/** " }, { name: "*bolt*", material: "*steel*" }],
    });

    expect(decoded.reviewIgnore).toEqual([
      { path: "Drivetrain <1>/**" },
      { name: "*bolt*", material: "*steel*" },
    ]);
  });

  it.each([
    ["an empty entry", {}],
    ["an unknown field", { pth: "Drivetrain/**" }],
    ["an unknown field beside a valid one", { name: "Bolt", ignore: true }],
    ["an empty glob", { name: " " }],
    ["a non-object entry", "Drivetrain/**"],
  ])("rejects a review ignore entry with %s", (_label, entry) => {
    expect(() => decode({ reviewIgnore: [entry] })).toThrow();
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
