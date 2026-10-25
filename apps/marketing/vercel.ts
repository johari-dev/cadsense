import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  // Pushes to main deploy to production; pull requests get preview deploys.
  git: {
    deploymentEnabled: true,
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@cadsense/marketing...'",
  buildCommand: "vp run --filter @cadsense/marketing build",
  outputDirectory: "dist",
};
