import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
  staged: {
    // Format, then lint the formatted files. One list so the two run in that
    // order. No typecheck on commit.
    "*": ["vp fmt --no-error-on-unmatched-pattern", "vp lint"],
  },
  fmt: {
    ignorePatterns: [
      ".reference",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/web/src/lib/vendor/qrcodegen.ts",
      "*.icon/**",
      // Generated per-frame data for the landing page's camera tour.
      "apps/marketing/public/landing/tour-track.json",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-cadsense/index.ts"],
    // Every enabled rule is "error" so a finding fails `vp check` in CI. Turn a
    // rule "off" with a reason instead of downgrading it to "warn".
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      // Flags `[...x]` snapshots taken before a loop mutates x, where dropping the copy is a bug.
      "unicorn/no-useless-spread": "off",
      // Every site is a positional list with no stable id (drawing lines, table cells).
      "react/no-array-index-key": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "typescript/no-explicit-any": "error",
      "eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@cadsense/client-runtime",
              message:
                "Import from an explicit @cadsense/client-runtime/* subpath. The package has no root export.",
            },
          ],
        },
      ],
      "cadsense/no-global-process-runtime": "error",
      "cadsense/no-inline-schema-compile": "error",
      "cadsense/no-manual-effect-runtime-in-tests": "error",
      "cadsense/no-native-title-tooltip": "error",
      "cadsense/namespace-node-imports": "error",
      "cadsense/no-slice-truncation": "error",
    },
    options: {
      // Revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics.
      typeAware: false,
      typeCheck: false,
      // A rule someone adds at "warn" later still fails the run.
      denyWarnings: true,
      // A disable comment that no longer suppresses anything is a finding too.
      reportUnusedDisableDirectives: "error",
    },
  },
});
