import { EnvironmentId } from "@cadsense/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parseOnshapeSettingsSearch,
  resolveOnshapeSettingsEnvironment,
} from "./onshapeSettingsEnvironment";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");

describe("Onshape integration environment routing", () => {
  it("preserves a non-primary project device from route search to selected catalog", () => {
    const search = parseOnshapeSettingsSearch({ environmentId: remote });
    expect(
      resolveOnshapeSettingsEnvironment([primary, remote], search.environmentId ?? null, primary),
    ).toBe(remote);
  });

  it("does not silently fall back when a targeted device is missing", () => {
    expect(resolveOnshapeSettingsEnvironment([primary], remote, primary)).toBeNull();
    expect(resolveOnshapeSettingsEnvironment([primary, remote], remote, primary)).toBe(remote);
  });

  it("uses the primary or first available device for untargeted settings", () => {
    expect(parseOnshapeSettingsSearch({})).toEqual({});
    expect(resolveOnshapeSettingsEnvironment([remote, primary], null, primary)).toBe(primary);
    expect(resolveOnshapeSettingsEnvironment([remote], null, primary)).toBe(remote);
    expect(resolveOnshapeSettingsEnvironment([], null, primary)).toBeNull();
  });

  it.each(["", " ", 42, null, [remote]])(
    "rejects invalid environment search %j",
    (environmentId) => {
      expect(() => parseOnshapeSettingsSearch({ environmentId })).toThrow();
    },
  );
});
