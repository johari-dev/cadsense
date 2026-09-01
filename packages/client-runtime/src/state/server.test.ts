import {
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
} from "@cadsense/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  applyServerConfigProjection,
  projectServerWelcome,
  resolveServerConfigValue,
} from "./server.ts";

const CONFIG = {
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: {},
  environment: { capabilities: {}, serverVersion: "1.0.0" },
} as unknown as ServerConfig;

const snapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

describe("server state projection", () => {
  it("applies incremental settings updates after the initial snapshot", () => {
    const snapshot = applyServerConfigProjection(Option.none(), snapshotEvent(CONFIG));
    const settings = { provider: "codex" } as unknown as ServerConfig["settings"];
    const projected = applyServerConfigProjection(snapshot, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings },
    });

    const result = Option.getOrThrow(projected);
    expect(result.config.settings).toBe(settings);
    expect(result.latestEvent.type).toBe("settingsUpdated");
  });

  it("retains welcome when a ready event follows in the same stream chunk", () => {
    const welcome = {
      environment: {} as ServerLifecycleWelcomePayload["environment"],
      cwd: "/repo",
      projectName: "repo",
    } as ServerLifecycleWelcomePayload;
    const [afterWelcome] = projectServerWelcome(Option.none(), {
      type: "welcome",
      payload: welcome,
    });
    const [afterReady, emitted] = projectServerWelcome(afterWelcome, {
      type: "ready",
      payload: {},
    });

    expect(Option.getOrThrow(afterReady)).toBe(welcome);
    expect(emitted).toEqual([]);
  });

  it("prefers the active session config until a matching live snapshot arrives", () => {
    const config = (source: string, serverVersion: string) =>
      ({
        ...CONFIG,
        environment: { capabilities: {}, serverVersion },
        settings: { source },
      }) as unknown as ServerConfig;
    const cached = config("cache", "0.9.0");
    const staleLive = config("stale-live", "0.9.0");
    const initial = config("session", "1.0.0");
    const live = config("live", "1.0.0");

    expect(
      resolveServerConfigValue(
        { config: cached, latestEvent: snapshotEvent(cached), source: "cache" },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        { config: staleLive, latestEvent: snapshotEvent(staleLive), source: "live" },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        { config: live, latestEvent: snapshotEvent(live), source: "live" },
        initial,
      ),
    ).toBe(live);
  });
});
