import { EnvironmentId } from "@cadsense/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseSettingsSearch } from "../components/settings/settingsLocation";
import { resolveOnshapeSettingsEnvironment } from "./onshapeSettingsEnvironment";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");

describe("Onshape integration environment routing", () => {
  it("preserves a non-primary project device from route search to selected catalog", () => {
    const search = parseSettingsSearch({ settings: "integrations", onshapeEnvironmentId: remote });
    expect(
      resolveOnshapeSettingsEnvironment(
        [primary, remote],
        search.onshapeEnvironmentId ?? null,
        primary,
      ),
    ).toBe(remote);
  });

  it("does not silently fall back when a targeted device is missing", () => {
    expect(resolveOnshapeSettingsEnvironment([primary], remote, primary)).toBeNull();
    expect(resolveOnshapeSettingsEnvironment([primary, remote], remote, primary)).toBe(remote);
  });

  it("uses the primary or first available device for untargeted settings", () => {
    expect(parseSettingsSearch({ settings: "integrations" })).toEqual({ settings: "integrations" });
    expect(resolveOnshapeSettingsEnvironment([remote, primary], null, primary)).toBe(primary);
    expect(resolveOnshapeSettingsEnvironment([remote], null, primary)).toBe(remote);
    expect(resolveOnshapeSettingsEnvironment([], null, primary)).toBeNull();
  });

  it.each(["", " ", 42, null, [remote]])(
    "opens nothing for invalid environment search %j",
    (onshapeEnvironmentId) => {
      expect(parseSettingsSearch({ settings: "integrations", onshapeEnvironmentId })).toEqual({});
    },
  );
});
