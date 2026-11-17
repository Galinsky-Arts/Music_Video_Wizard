import type { RenderManifest } from "@/lib/finish-export/manifest";

/** Alternate compositions rendered from the same locked timeline (plan PR 26). */
export const DELIVERY_PRESETS = {
  "vertical-1080": { label: "Vertical 9:16 (Reels, TikTok, Shorts) 1080×1920", width: 1080, height: 1920, aspectRatio: "9:16", crf: 20 },
  "square-1080": { label: "Square 1:1 (feed) 1080×1080", width: 1080, height: 1080, aspectRatio: "1:1", crf: 20 },
  "portrait-1080": { label: "Portrait 4:5 (feed) 1080×1350", width: 1080, height: 1350, aspectRatio: "4:5", crf: 20 },
  "landscape-1080": { label: "Landscape 16:9 1920×1080 (high quality)", width: 1920, height: 1080, aspectRatio: "16:9", crf: 17 },
  "landscape-720-web": { label: "Landscape 16:9 1280×720 (small web file)", width: 1280, height: 720, aspectRatio: "16:9", crf: 24 },
} as const;

export type DeliveryPresetKey = keyof typeof DELIVERY_PRESETS;

export function isDeliveryPresetKey(value: string): value is DeliveryPresetKey {
  return Object.prototype.hasOwnProperty.call(DELIVERY_PRESETS, value);
}

export interface FocusOverride { focusX?: number; focusY?: number; zoom?: number }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Derive a variant manifest: same edit, audio and overlays; new output size.
 * "fill" reframes each shot with its existing crop/reframe focus (or a
 * per-shot override), "fit" letterboxes the whole frame.
 */
export function deriveVariantManifest(
  base: RenderManifest,
  input: { presetKey: DeliveryPresetKey; framingMode: "fill" | "fit"; focusOverrides?: Record<string, FocusOverride> }
): RenderManifest {
  const preset = DELIVERY_PRESETS[input.presetKey];
  return {
    ...base,
    output: { ...base.output, width: preset.width, height: preset.height, aspectRatio: preset.aspectRatio, crf: preset.crf },
    items: base.items.map((item) => {
      if (input.framingMode === "fit") {
        const rest = { ...item };
        delete rest.framing;
        return rest;
      }
      const override = input.focusOverrides?.[String(item.position)] ?? {};
      const current = item.framing;
      return {
        ...item,
        framing: {
          mode: "fill" as const,
          zoom: clamp(Number(override.zoom ?? current?.zoom ?? 1), 1, 4),
          focusX: clamp(Number(override.focusX ?? current?.focusX ?? 0.5), 0, 1),
          focusY: clamp(Number(override.focusY ?? current?.focusY ?? 0.5), 0, 1),
        },
      };
    }),
  };
}
