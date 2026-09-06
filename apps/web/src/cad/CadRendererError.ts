/** Transport and scheduling failures must not eagerly load the graphics engine. */
export class CadRendererError extends Error {
  readonly _tag = "CadRendererError";
  constructor(
    readonly reason:
      | "renderer-unavailable"
      | "invalid-view"
      | "invalid-snapshot"
      | "superseded"
      | "renderer-busy"
      | "capture-failed",
  ) {
    super(`CAD ${reason}`);
  }
}
