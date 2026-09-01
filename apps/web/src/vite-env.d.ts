/// <reference types="vite-plus/client" />

import type { DesktopBridge } from "@cadsense/contracts";

interface ImportMetaEnv {
  readonly VITE_DEV_SERVER_URL?: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}
