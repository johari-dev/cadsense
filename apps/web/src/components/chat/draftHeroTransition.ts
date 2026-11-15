export const DRAFT_HERO_TRANSITION_ANIMATION_ID = "cadsense-draft-hero-transition";
/**
 * How long the new thread view takes to settle into a chat, or back: the composer's move, the
 * backdrop's fade, and the wait before the hero text is unmounted. The easing is the right
 * panel's slide (PreviewPanelShell), so a panel that opens during the settle moves with it.
 * The Tailwind classes in ChatView and DraftHeroBackdrop repeat both values.
 */
export const DRAFT_HERO_TRANSITION_DURATION_MS = 300;
export const DRAFT_HERO_TRANSITION_EASING = "cubic-bezier(0.2, 0, 0, 1)";
