import type { Assertion, ExpectPollOptions } from "vite-plus/test";
import type { Locator } from "vite-plus/test/browser";

declare module "vite-plus/test" {
  interface ExpectStatic {
    element: (
      element: HTMLElement | SVGElement | null | Locator,
      options?: ExpectPollOptions,
    ) => Assertion<HTMLElement | SVGElement | null>["resolves"];
  }
}
