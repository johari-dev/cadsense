import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@cadsense/contracts";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "../../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";
import { getLocalEnvironmentBootstraps, getWindowFullscreenState, pickFolder } from "./window.ts";

const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "bootstrap-token",
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
};

const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("wsl:default"),
  label: Effect.succeed("WSL (default distro)"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeed(Option.some(readyWslConfig)),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("publishes the concrete running distro without replacing the stable instance id", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "bootstrap-token",
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([defaultWslInstance]))),
  );

  it.effect("publishes a pending bootstrap only while a transient retry is scheduled", () => {
    const retryingConfig: DesktopBackendManager.DesktopBackendStartConfig = {
      ...readyWslConfig,
      preflightFailure: Option.some({
        reason: "WSL probe timed out",
        fatal: false,
        retryLimit: 12,
      }),
    };
    const retryingInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(Option.some(retryingConfig)),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 2,
        restartScheduled: true,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (default distro)",
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([retryingInstance])));
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(
        Option.some({
          ...readyWslConfig,
          preflightFailure: Option.some({
            reason: "WSL probe timed out",
            fatal: false,
            retryLimit: 12,
          }),
        }),
      ),
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 12,
        restartScheduled: false,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([stoppedInstance])));
  });
});

describe("getWindowFullscreenState", () => {
  it.effect("reads the current native window state", () => {
    const window = { isFullScreen: () => true } as Electron.BrowserWindow;

    return Effect.gen(function* () {
      assert.isTrue(yield* getWindowFullscreenState.handler());
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeed(Option.some(window)),
        }),
      ),
    );
  });
});

// Runs the folder picker with the dialog answering `picked`. `primaryRunsInWsl` is the backend
// configuration's decision about where the primary backend runs (tested in its own suite).
const runPickFolder = (input: {
  readonly primaryRunsInWsl: boolean;
  readonly picked: string | null;
  readonly options?: Parameters<typeof pickFolder.handler>[0];
}) => {
  const dialogCalls: ElectronDialog.ElectronDialogPickFolderInput[] = [];
  return Effect.gen(function* () {
    const result = yield* pickFolder.handler(input.options);
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return {
      result,
      defaultPath: dialogCalls[0]?.defaultPath,
      // Where the dialog opens for a backend on this machine.
      localDefaultPath: environment.resolvePickFolderDefaultPath(input.options),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ElectronDialog.ElectronDialog)({
          pickFolder: (call) => {
            dialogCalls.push(call);
            return Effect.succeed(Option.fromNullishOr(input.picked));
          },
        }),
        Layer.mock(ElectronWindow.ElectronWindow)({
          focusedMainOrFirst: Effect.succeed(Option.none()),
        }),
        DesktopEnvironment.layer({
          dirname: "C:\\cadsense\\apps\\desktop\\src",
          homeDirectory: "C:\\Users\\aadi",
          platform: "win32",
          processArch: "x64",
          appVersion: "1.2.3",
          appPath: "C:\\cadsense",
          isPackaged: true,
          resourcesPath: "C:\\cadsense\\resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              DesktopConfig.layerTest({ CADSENSE_HOME: "C:\\Users\\aadi\\.cadsense" }),
            ),
          ),
        ),
        Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration)({
          primaryRunsInWsl: Effect.succeed(input.primaryRunsInWsl),
        }),
        DesktopAppSettings.layerTest({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          wslBackendEnabled: true,
          wslOnly: input.primaryRunsInWsl,
          wslDistro: "Ubuntu",
        }),
        DesktopWslEnvironment.layerTest({
          isAvailable: true,
          distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
          getUserHome: () => Option.some("/home/aadi"),
          windowsToWslPath: (_distro, windowsPath) =>
            windowsPath === "D:\\cad" ? Option.some("/mnt/d/cad") : Option.none(),
        }),
      ),
    ),
  );
};

describe("pickFolder", () => {
  it.effect("returns the Linux path when the primary backend runs in WSL", () =>
    Effect.gen(function* () {
      const { result, defaultPath } = yield* runPickFolder({
        primaryRunsInWsl: true,
        picked: "\\\\wsl.localhost\\Ubuntu\\tmp\\cad",
        options: { initialPath: "~/" },
      });
      assert.equal(result, "/tmp/cad");
      // The dialog opens in the distro, where the primary backend's files are.
      assert.deepEqual(defaultPath, Option.some("\\\\wsl.localhost\\Ubuntu\\home\\aadi\\"));
    }),
  );

  it.effect("treats the primary environment id like no target", () =>
    Effect.gen(function* () {
      const { result } = yield* runPickFolder({
        primaryRunsInWsl: true,
        picked: "\\\\wsl.localhost\\Ubuntu\\tmp\\cad",
        options: { targetEnvironmentId: PRIMARY_LOCAL_ENVIRONMENT_ID },
      });
      assert.equal(result, "/tmp/cad");
    }),
  );

  it.effect("maps a Windows folder into the distro when the primary backend runs in WSL", () =>
    Effect.gen(function* () {
      const { result } = yield* runPickFolder({ primaryRunsInWsl: true, picked: "D:\\cad" });
      assert.equal(result, "/mnt/d/cad");
    }),
  );

  it.effect("returns the Windows path when the primary backend runs on Windows", () =>
    Effect.gen(function* () {
      const { result, defaultPath, localDefaultPath } = yield* runPickFolder({
        primaryRunsInWsl: false,
        picked: "\\\\wsl.localhost\\Ubuntu\\tmp\\cad",
        options: { initialPath: "~/" },
      });
      assert.equal(result, "\\\\wsl.localhost\\Ubuntu\\tmp\\cad");
      assert.isTrue(Option.isSome(localDefaultPath));
      assert.deepEqual(defaultPath, localDefaultPath);
    }),
  );

  it.effect("still maps paths for an explicit WSL target beside a Windows primary", () =>
    Effect.gen(function* () {
      const { result } = yield* runPickFolder({
        primaryRunsInWsl: false,
        picked: "\\\\wsl.localhost\\Ubuntu\\tmp\\cad",
        options: { targetEnvironmentId: "wsl:Ubuntu" },
      });
      assert.equal(result, "/tmp/cad");
    }),
  );

  it.effect("returns null when the dialog is canceled", () =>
    Effect.gen(function* () {
      const { result } = yield* runPickFolder({ primaryRunsInWsl: true, picked: null });
      assert.isNull(result);
    }),
  );
});
