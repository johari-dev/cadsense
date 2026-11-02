// Messages CadSceneRenderer.focusComment returns about how it framed a comment's location.
// The comments card turns them into an icon on the location chip, so both sides share them.

/** The point is shown from the camera the agent captured it with. */
export const COMMENT_FOCUS_AGENT_VIEW = "Showing the agent's view";
/** The target part or point is missing from the loaded model. */
export const COMMENT_FOCUS_UNAVAILABLE = "Location unavailable";
/** Section planes hide the target. */
export const COMMENT_FOCUS_CLIPPED =
  "Location clipped by section planes; reset inspection to review";

/** Focus results that mean the location could not be shown. */
export const COMMENT_FOCUS_FAILURES: ReadonlySet<string> = new Set([
  COMMENT_FOCUS_UNAVAILABLE,
  COMMENT_FOCUS_CLIPPED,
]);
