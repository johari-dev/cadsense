import { describe, expect, it } from "vite-plus/test";

import { buildFileManagerLaunch } from "./externalLauncher.ts";

describe("buildFileManagerLaunch", () => {
  it("opens folders in Windows Explorer", () => {
    expect(
      buildFileManagerLaunch({ cwd: String.raw`C:\work\project` }, "win32", {
        SYSTEMROOT: String.raw`C:\Windows`,
      }),
    ).toEqual({
      target: String.raw`C:\work\project`,
      command: String.raw`C:\Windows\explorer.exe`,
      args: [String.raw`C:\work\project`],
    });
  });

  it("uses Explorer's select action when revealing on Windows", () => {
    expect(
      buildFileManagerLaunch({ cwd: String.raw`C:\work\project`, reveal: true }, "win32", {
        SYSTEMROOT: String.raw`C:\Windows`,
      }).args,
    ).toEqual(["/select,", String.raw`C:\work\project`]);
  });

  it("bridges WSL paths into Windows Explorer", () => {
    expect(
      buildFileManagerLaunch({ cwd: "/home/dev/project" }, "linux", {
        WSL_DISTRO_NAME: "Ubuntu",
      }),
    ).toEqual({
      target: String.raw`\\wsl.localhost\Ubuntu\home\dev\project`,
      command: "explorer.exe",
      args: [String.raw`\\wsl.localhost\Ubuntu\home\dev\project`],
    });
  });

  it("uses the native macOS file-manager reveal action", () => {
    expect(buildFileManagerLaunch({ cwd: "/work/project", reveal: true }, "darwin")).toEqual({
      target: "/work/project",
      command: "open",
      args: ["-R", "/work/project"],
    });
  });
});
