export type MediaDimensions = { width: number; height: number };

/** Display-only width for small images; source metadata is never rewritten. */
export const IMAGE_DISPLAY_WIDTH = 720;
export const IMAGE_DISPLAY_WIDTH_CSS = "clamp(320px, 50vw, 720px)";
export const VIDEO_DISPLAY_WIDTH_CSS = "clamp(320px, 40vw, 800px)";

export function imageDisplaySize({ width, height }: MediaDimensions): MediaDimensions {
  if (!(width > 0 && height > 0)) return { width, height };
  const scale = Math.max(1, IMAGE_DISPLAY_WIDTH / width);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
