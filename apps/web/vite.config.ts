import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import pkg from "./package.json" with { type: "json" };

import { DEV_PROXIED_PATH_PREFIXES } from "@cadsense/shared/devProxy";

import { loadRepoEnv } from "../../scripts/lib/repo-env";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const port = Number(process.env.PORT ?? 5733);
const explicitHost = process.env.HOST?.trim();
const host = explicitHost || "localhost";
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
const sourcemapEnv = process.env.CADSENSE_WEB_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap: boolean | "hidden" =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    include: ["src/**/*.test.{ts,tsx}"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
} satisfies TestProjectInlineConfiguration;

function resolveDevProxyTarget(backendPort: string | undefined): string | undefined {
  const backendPortNumber = Number(backendPort?.trim());
  if (Number.isInteger(backendPortNumber) && backendPortNumber > 0) {
    return `http://localhost:${backendPortNumber}/`;
  }
  return undefined;
}

const devProxyTarget = resolveDevProxyTarget(process.env.CADSENSE_PORT);

export default defineConfig(({ command }) => ({
  assetsInclude: ["**/*.wasm"],
  plugins: [
    tanstackRouter(),
    react(),
    ...(command === "build"
      ? [
          babel({
            parserOpts: { plugins: ["typescript", "jsx"] },
            presets: [reactCompilerPreset()],
          }),
        ]
      : []),
    tailwindcss(),
  ],
  optimizeDeps: {
    include: ["effect/Array", "effect/Order", "react-dom/client"],
  },
  define: {
    "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
  },
  resolve: {
    tsconfigPaths: true,
    dedupe: ["react", "react-dom"],
  },
  server: {
    host,
    port,
    strictPort: true,
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
    ...(devProxyTarget
      ? {
          proxy: Object.fromEntries(
            DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
              prefix,
              {
                target: devProxyTarget,
                changeOrigin: true,
                ...(prefix === "/ws" ? { ws: true } : {}),
              },
            ]),
          ),
        }
      : {}),
    ...(explicitHost
      ? {
          hmr: {
            protocol: "ws",
            host: explicitHost,
            clientPort: port,
          },
        }
      : {}),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
  },
  test: {
    projects: [defineProject(unitTestProject)],
  },
}));
