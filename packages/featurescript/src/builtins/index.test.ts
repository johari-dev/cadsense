import { describe, expect, it } from "vite-plus/test";
import { IMPLEMENTED, UNSUPPORTED } from "./index.ts";
import { STD_BUILTIN_NAMES } from "./stdBuiltinNames.generated.ts";

describe("builtin registry", () => {
  it("never lists a builtin as both implemented and unsupported", () => {
    const unsupported = new Set<string>(UNSUPPORTED);
    expect(IMPLEMENTED.filter((name) => unsupported.has(name))).toEqual([]);
  });
  it("covers every builtin std calls", () => {
    const known = new Set<string>([...IMPLEMENTED, ...UNSUPPORTED]);
    expect(STD_BUILTIN_NAMES.filter((name) => !known.has(name))).toEqual([]);
  });
});
