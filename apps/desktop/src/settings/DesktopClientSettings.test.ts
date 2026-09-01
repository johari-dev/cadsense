import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClientSettingsSchema, type ClientSettings } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

const clientSettings: ClientSettings = {
  browserDefaultViewport: { _tag: "preset", width: 1024, height: 600, presetId: "nest-hub" },
  browserDefaultZoomFactor: 1.25,
  browserDefaultAppearance: "dark",
  browserAutoShowFloatingPreview: false,
  confirmQuit: true,
  confirmThreadArchive: true,
  confirmThreadDelete: false,
  confirmThreadUnpin: false,
  dismissedProviderUpdateNotificationKeys: [],
  environmentIdentificationMode: "artwork",
  favorites: [],
  fontFamilyCode: "",
  fontFamilyComposer: "",
  fontFamilySans: "",
  fontSizeCode: 13,
  fontSizeInterface: 16,
  fontSizePrompt: 14,
  fontSmoothing: true,
  sidebarProjectSortOrder: "updated_at",
  sidebarThreadPreviewCount: 5,
  sidebarThreadSortOrder: "updated_at",
  providerModelPreferences: {},
  wordWrap: true,
};

const decodeClientSettingsJson = Schema.decodeEffect(Schema.fromJsonString(ClientSettingsSchema));
const decodeRecordJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
function makeLayer(baseDir: string) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ CADSENSE_HOME: baseDir })),
    ),
  );

  return DesktopClientSettings.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withClientSettings = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopClientSettings.DesktopClientSettings>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "cadsense-desktop-client-settings-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopClientSettings", () => {
  it.effect("returns none when no client settings file exists", () =>
    withClientSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        assert.isTrue(Option.isNone(yield* settings.get));
      }),
    ),
  );

  it.effect("persists and reloads client settings", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* settings.set(clientSettings);

        assert.deepEqual(yield* settings.get, Option.some(clientSettings));
        assert.deepEqual(
          yield* decodeClientSettingsJson(
            yield* fileSystem.readFileString(environment.clientSettingsPath),
          ),
          clientSettings,
        );
        assert.isFalse(
          Object.hasOwn(
            yield* decodeRecordJson(
              yield* fileSystem.readFileString(environment.clientSettingsPath),
            ),
            "settings",
          ),
        );
      }),
    ),
  );

  it.effect("reports the failed client settings write operation and path", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.clientSettingsPath, { recursive: true });

        const error = yield* settings.set(clientSettings).pipe(Effect.flip);
        assert.instanceOf(error, DesktopClientSettings.DesktopClientSettingsWriteError);
        assert.equal(error.operation, "replace-settings-file");
        assert.equal(error.path, environment.clientSettingsPath);
        assert.instanceOf(error.cause, PlatformError.PlatformError);
        assert.isString(error.cause.stack);
        assert.equal(
          error.message,
          `Desktop client settings write failed during replace-settings-file at ${environment.clientSettingsPath}.`,
        );
        assert.notInclude(error.message, error.cause.message);
      }),
    ),
  );

  it.effect("loads lenient direct client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.clientSettingsPath,
          `{
            // Matches server settings parsing.
            "wordWrap": false,
          }\n`,
        );

        const persisted = yield* settings.get;
        assert.isTrue(Option.isSome(persisted));
        if (Option.isSome(persisted)) {
          assert.isFalse(persisted.value.wordWrap);
        }
      }),
    ),
  );

  it.effect("loads legacy wrapped client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.clientSettingsPath,
          `{
            "settings": {
              "wordWrap": false
            }
          }\n`,
        );

        const persisted = yield* settings.get;
        assert.isTrue(Option.isSome(persisted));
        if (Option.isSome(persisted)) {
          assert.isFalse(persisted.value.wordWrap);
        }
      }),
    ),
  );

  it.effect("loads defaults from empty client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.clientSettingsPath, "{}\n");

        assert.deepEqual(yield* settings.get, Option.some(yield* decodeClientSettingsJson("{}")));
      }),
    ),
  );

  it.effect("treats malformed client settings documents as absent", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.clientSettingsPath, "{not-json");

        assert.isTrue(Option.isNone(yield* settings.get));
      }),
    ),
  );
});
