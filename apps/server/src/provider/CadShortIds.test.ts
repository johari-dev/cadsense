import { describe, expect, it } from "vite-plus/test";
import { cadToolDefinitions } from "./CadProviderTools.ts";
import { makeCadShortIds, UNKNOWN_ID_DETAILS } from "./CadShortIds.ts";

const id = (seed: string) => seed.repeat(64).slice(0, 64);
const gear = id("a1b2c3d4e5");
const shaft = id("f6e5d4c3b2");
// Shares gear's first eight characters, so neither can be shown as eight.
const twin = `${gear.slice(0, 8)}${id("9")}`.slice(0, 64);

describe("makeCadShortIds", () => {
  it("shortens full IDs in nested values and object keys, and nothing else", () => {
    const ids = makeCadShortIds();
    const shown = ids.shorten({
      captureId: "5142d113-661c-4211-b22f-38ed16be1989",
      title: "Add a bearing",
      entries: [{ occurrenceId: gear, path: [shaft] }],
      visibility: { [gear]: false },
    });
    expect(shown).toEqual({
      captureId: "5142d113-661c-4211-b22f-38ed16be1989",
      title: "Add a bearing",
      entries: [{ occurrenceId: gear.slice(0, 8), path: [shaft.slice(0, 8)] }],
      visibility: { [gear.slice(0, 8)]: false },
    });
  });

  it("expands shown prefixes anywhere in the input and passes other strings through", () => {
    const ids = makeCadShortIds();
    ids.shorten([gear, shaft]);
    const input = ids.expand({
      expectedRevision: 2,
      operations: [{ type: "isolate", occurrenceIds: [gear.slice(0, 8), shaft.slice(0, 10)] }],
      items: [{ publicationKey: "deadbeef-note", targets: [{ occurrenceId: shaft.slice(0, 8) }] }],
    });
    expect(input).toEqual({
      ok: true,
      value: {
        expectedRevision: 2,
        operations: [{ type: "isolate", occurrenceIds: [gear, shaft] }],
        items: [{ publicationKey: "deadbeef-note", targets: [{ occurrenceId: shaft }] }],
      },
    });
  });

  it("keeps full IDs it never showed, such as one quoted from a discussed comment", () => {
    const ids = makeCadShortIds();
    expect(ids.expand({ occurrenceId: gear })).toEqual({ ok: true, value: { occurrenceId: gear } });
  });

  it("leaves an unknown prefix for the schema to reject", () => {
    const ids = makeCadShortIds();
    ids.shorten(gear);
    expect(ids.expand({ occurrenceId: "0123abcd" })).toEqual({
      ok: true,
      value: { occurrenceId: "0123abcd" },
    });
  });

  it("lengthens prefixes until IDs shown together are distinct", () => {
    const ids = makeCadShortIds();
    const [a = "", b = ""] = ids.shorten([gear, twin]);
    expect(a).not.toBe(b);
    expect(gear.startsWith(a) && twin.startsWith(b)).toBe(true);
    expect(a.length).toBeGreaterThan(8);
  });

  it("refuses a prefix that became ambiguous instead of picking one", () => {
    const ids = makeCadShortIds();
    const shown = ids.shorten(gear);
    ids.shorten(twin);
    const result = ids.expand({ occurrenceId: shown });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.details).toContain(shown);
  });

  it("rewrites the 64-character schema message so models do not invent full IDs", () => {
    const ids = makeCadShortIds();
    const shown = ids.shorten({
      details: 'Expected a string matching the RegExp ^[a-f0-9]{64}$\n  at ["occurrenceId"]',
    });
    expect(shown).toEqual({ details: `${UNKNOWN_ID_DETAILS}\n  at ["occurrenceId"]` });
  });
});

describe("cadToolDefinitions", () => {
  it("advertises short ID prefixes wherever a full ID was required", () => {
    const text = JSON.stringify(cadToolDefinitions);
    expect(text).not.toContain("{64}$");
    expect(text).toContain("^[a-f0-9]{8,64}$");
  });
});
