import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    deploymentEnabled: false,
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@cadsense/marketing...'",
  buildCommand: "vp run --filter @cadsense/marketing build",
  outputDirectory: "dist",
};
