import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  // Pushes to main deploy to production. Other branches get a preview deploy
  // only when they change apps/marketing (see the ignore script).
  git: {
    deploymentEnabled: true,
  },
  ignoreCommand: "sh scripts/vercel-ignore-build.sh",
  installCommand: "npm install -g vite-plus && vp install --filter '@cadsense/marketing...'",
  buildCommand: "vp run --filter @cadsense/marketing build",
  outputDirectory: "dist",
};
