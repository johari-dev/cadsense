import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopAppSettings from "./DesktopAppSettings.ts";

describe("DesktopAppSettings", () => {
  it("keeps only desktop-local window, updater, and WSL preferences", () => {
    assert.deepEqual(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, {
      linuxPasswordStore: "auto",
      mainWindowBounds: null,
      mainWindowMaximized: false,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      wslBackendEnabled: false,
      wslDistro: null,
      wslOnly: false,
    });
  });

  it("rejects window bounds that are too small", () => {
    assert.isNull(
      DesktopAppSettings.normalizeMainWindowBounds({ x: 0, y: 0, width: 839, height: 620 }),
    );
    assert.deepEqual(
      DesktopAppSettings.normalizeMainWindowBounds({ x: 4, y: 8, width: 840, height: 620 }),
      { x: 4, y: 8, width: 840, height: 620 },
    );
  });

  it.effect("updates WSL preferences in memory", () =>
    Effect.gen(function* () {
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      const enabled = yield* settings.setWslBackendEnabled(true);
      const distro = yield* settings.setWslDistro("Ubuntu");
      const wslOnly = yield* settings.setWslOnly(true);

      assert.isTrue(enabled.changed);
      assert.isTrue(distro.changed);
      assert.isTrue(wslOnly.changed);
      assert.deepEqual(yield* settings.get, {
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        wslBackendEnabled: true,
        wslDistro: "Ubuntu",
        wslOnly: true,
      });
    }).pipe(Effect.provide(DesktopAppSettings.layerTest())),
  );

  it.effect("marks a manually selected updater channel", () =>
    Effect.gen(function* () {
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      const changed = yield* settings.setUpdateChannel("nightly");

      assert.isTrue(changed.changed);
      assert.equal(changed.settings.updateChannel, "nightly");
      assert.isTrue(changed.settings.updateChannelConfiguredByUser);
    }).pipe(Effect.provide(DesktopAppSettings.layerTest())),
  );
});
