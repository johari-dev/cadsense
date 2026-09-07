import * as Schema from "effect/Schema";

export const CadAppearance = Schema.Struct({
  background: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffff })),
  dark: Schema.Boolean,
});
export type CadAppearance = typeof CadAppearance.Type;
export const DEFAULT_CAD_APPEARANCE: CadAppearance = { background: 0x141414, dark: true };

/** Resolve CSS colors through the browser so custom palettes and OKLCH work in WebGL too. */
export function readCadAppearance(): CadAppearance {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined")
    return DEFAULT_CAD_APPEARANCE;
  const color = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) return DEFAULT_CAD_APPEARANCE;
  context.fillStyle = "#141414";
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color || "#141414";
  context.fillRect(0, 0, 1, 1);
  const [red = 20, green = 20, blue = 20] = context.getImageData(0, 0, 1, 1).data;
  return {
    background: (red << 16) | (green << 8) | blue,
    dark: red * 0.2126 + green * 0.7152 + blue * 0.0722 < 128,
  };
}

export function observeCadAppearance(onChange: (appearance: CadAppearance) => void): () => void {
  const update = () => onChange(readCadAppearance());
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  update();
  return () => observer.disconnect();
}
