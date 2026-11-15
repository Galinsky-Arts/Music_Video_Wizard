import { existsSync } from "node:fs";

/** Fonts installed by the Dockerfile (fonts-dejavu-core) and common distro fallbacks. */
export const OVERLAY_FONT_CANDIDATES=[
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
] as const;

export function resolveOverlayFont(
  candidates:readonly string[]=OVERLAY_FONT_CANDIDATES,
  exists:(path:string)=>boolean=existsSync
):string|null{
  const configured=process.env.VIDEO_RENDER_FONT_FILE?.trim();
  if(configured&&exists(configured)) return configured;
  return candidates.find(path=>exists(path))??null;
}
