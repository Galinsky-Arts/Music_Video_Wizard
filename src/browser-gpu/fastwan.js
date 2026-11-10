// Adapted from Jean, Copyright (c) 2026 Warehouse SAS, MIT. See THIRD_PARTY_NOTICES.md.
// FastWan 2.2 TI2V-5B on this device (D585): what its graphs are given, worked out here so the stage
// worker only runs them, as FastVideo's DMD sampler drives it. The description is read by umT5-XXL,
// its own tokens only; the film is a latent of 48 channels for every 4 frames and 16 pixels square,
// given to the transformer as tokens of 2 × 2 of its points (patchify), with each token's rotary
// angles, and made from noise in three steps: at each, the clean film is foreseen, then noised again
// to the next step with fresh noise. TAEHV decodes it, a frame first for each glimpse.

/** The description's tokens at most; the film's frames, 5 seconds at 16 a second. */
export const WORDS = 512, FRAMES = 81, FPS = 16
/** FastVideo's steps, as timesteps of its training table: 1000 a step for each of its sigmas, shifted by 8. */
export const STEPS = [1000, 757, 522]

/** Each shape's size in pixels, in 32s, about 8,000 tokens each. */
export const SIZES = { wide: [832, 480], tall: [480, 832], square: [640, 640] }

/** The sigma of a timestep, as FastVideo finds it: the training table's nearest, its 1000 evenly spaced and shifted. @param {number} timestep */
export const sigma = (/** @type {number} */ timestep) => Array.from({ length: 1000 }, (_, i) => (8 * (1000 - i)) / (1000 + 7 * (1000 - i)))
  .reduce((best, s) => (Math.abs(s * 1000 - timestep) < Math.abs(best * 1000 - timestep) ? s : best))
export const SIGMAS = STEPS.map(sigma)

/** The latent's shape for a size: [channels, latent frames, rows, columns]. @param {number} width @param {number} height */
export const shape = (width, height) => [48, (FRAMES - 1) / 4 + 1, height / 16, width / 16]

/**
 * Each token's rotary angles, as Wan's transformer takes them: 44 of its 128 numbers for the frame, 42 each for the row
 * and the column, each axis's frequencies 1 / 10000^(2k / its numbers), each angle's cosine and sine twice in a row; the
 * sines' even numbers negated, as the graph turns each pair by them. @param {number} frames @param {number} rows @param {number} columns in tokens
 */
export function rope(frames, rows, columns) {
  const axes = [44, 42, 42]
  const tokens = frames * rows * columns
  const [cos, sin] = [new Float32Array(tokens * 128), new Float32Array(tokens * 128)]
  for (let token = 0; token < tokens; token++) {
    const at = [Math.floor(token / (rows * columns)), Math.floor(token / columns) % rows, token % columns]
    let i = token * 128
    for (const [axis, size] of axes.entries()) {
      for (let k = 0; k < size / 2; k++, i += 2) {
        const angle = at[axis] / 10000 ** ((2 * k) / size)
        cos[i] = cos[i + 1] = Math.cos(angle)
        sin[i] = -(sin[i + 1] = Math.sin(angle))
      }
    }
  }
  return { cos, sin }
}

/**
 * A latent [channels, frames, height, width] as tokens of 2 × 2 of its points, frame by frame, row by row, each the channels'
 * points in the order the patch embedding reads them (channel, row, column); or, `back`, the transformer's tokens, each in the
 * order it gives them (row, column, channel), as a latent again. @param {Float32Array} values @param {number[]} shape
 */
export function patchify(values, [c, t, h, w], back = false) {
  const out = new Float32Array(values.length)
  let o = 0
  for (let ti = 0; ti < t; ti++) for (let hi = 0; hi < h; hi += 2) for (let wi = 0; wi < w; wi += 2) for (let n = 0; n < 4 * c; n++) {
    const [ci, ph, pw] = back ? [n % c, n >= 2 * c ? 1 : 0, Math.floor(n / c) % 2] : [n >> 2, (n >> 1) & 1, n & 1]
    const at = ((ci * t + ti) * h + hi + ph) * w + wi + pw
    if (back) out[at] = values[o++]
    else out[o++] = values[at]
  }
  return out
}
export const unpatchify = (/** @type {Float32Array} */ tokens, /** @type {number[]} */ shape) => patchify(tokens, shape, true)

/** A latent's frames as TAEHV takes them, [frames, channels, height, width]; or a single frame of it. @param {Float32Array} latent @param {number[]} shape @param {number} [only] */
export function frames(latent, [c, t, h, w], only) {
  const plane = h * w
  const which = only === undefined ? [...Array(t).keys()] : [only]
  const out = new Float32Array(which.length * c * plane)
  for (const [n, ti] of which.entries()) for (let ci = 0; ci < c; ci++) out.set(latent.subarray((ci * t + ti) * plane, (ci * t + ti + 1) * plane), (n * c + ci) * plane)
  return out
}
