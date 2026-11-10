// FastWan stages adapted from Jean (MIT), Copyright (c) 2026 Warehouse SAS.
// A fresh worker per stage releases the GPU allocations before loading the next graph.
import { InferenceSession, Tensor, env } from './vendor/ort.webgpu.bundle.min.mjs';
import { Tokenizer } from '@huggingface/tokenizers';
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource } from 'mediabunny';
import { FILM, FILES } from './model.js';
import { weights, downloadModel } from './cache.js';
import * as wan from './fastwan.js';

env.wasm.numThreads = 1;
env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
const halves = values => new Uint16Array(new Float16Array(values).buffer);
const numbers = data => Float32Array.from(data instanceof Uint16Array ? new Float16Array(data.buffer, data.byteOffset, data.length) : data);
async function read(files) { const parts = []; for (const file of files) parts.push(await weights(file)); return parts; }
async function session(files) {
  const [graph, ...data] = await read(files);
  return InferenceSession.create(graph, { executionProviders: ['webgpu'], externalData: data.map((bytes, i) => ({ path: files[i + 1][0].split('/').pop(), data: bytes })) })
    .finally(() => data.forEach(bytes => bytes.buffer.transfer?.(0)));
}
function noise(length) {
  const result = new Float32Array(length);
  for (let i = 0; i < length; i += 2) {
    const radius = Math.sqrt(-2 * Math.log(1 - Math.random())), angle = 2 * Math.PI * Math.random();
    result[i] = radius * Math.cos(angle); if (i + 1 < length) result[i + 1] = radius * Math.sin(angle);
  }
  return result;
}
const stages = {
  async download() { await downloadModel(FILES, progress => self.postMessage({ type: 'progress', ...progress })); return {}; },
  async words({ prompt }) {
    const [json, config] = (await read(FILM.tokenizer)).map(bytes => JSON.parse(new TextDecoder().decode(bytes)));
    // This is the same tokenizer implementation used by Transformers.js T5Tokenizer.
    const ids = new Tokenizer(json, config).encode(prompt).ids.slice(0, wan.WORDS);
    const [rows, scales] = await read(FILM.words);
    const signed = new Int8Array(rows.buffer), scale = new Float16Array(scales.buffer);
    return { hidden: halves(ids.flatMap(id => Array.from(signed.subarray(id * 4096, id * 4096 + 4096), value => value * scale[id]))) };
  },
  async read({ part, hidden }) {
    const { out } = await (await session(FILM.read[part])).run({ hidden: new Tensor('float16', hidden, [1, hidden.length / 4096, 4096]) });
    return { hidden: out.type === 'float16' ? new Uint16Array(out.data.buffer, out.data.byteOffset, out.data.length) : halves(out.data) };
  },
  async denoise({ embeds, width, height }) {
    const transformer = await session(FILM.denoise);
    const shape = wan.shape(width, height), [, t, h, w] = shape, count = t * (h / 2) * (w / 2);
    const { cos, sin } = wan.rope(t, h / 2, w / 2);
    const fixed = { text: new Tensor('float16', embeds, [1, wan.WORDS, 4096]), rope_cos: new Tensor('float32', cos, [1, count, 1, 128]), rope_sin: new Tensor('float32', sin, [1, count, 1, 128]) };
    let latent = noise(48 * t * h * w), clean;
    for (const [step, timestep] of wan.STEPS.entries()) {
      const { out } = await transformer.run({ ...fixed, patches: new Tensor('float16', halves(wan.patchify(latent, shape)), [1, count, 192]), timestep: new Tensor('int64', BigInt64Array.of(BigInt(timestep)), [1]) });
      const velocity = wan.unpatchify(numbers(out.data), shape), [sigma, next] = wan.SIGMAS.slice(step);
      clean = latent.map((v, i) => v - sigma * velocity[i]);
      self.postMessage({ type: 'step', done: step + 1, total: wan.STEPS.length });
      if (next !== undefined) latent = noise(latent.length).map((v, i) => next * v + (1 - next) * clean[i]);
    }
    return { latent: clean };
  },
  async decode({ latent, width, height }) {
    const shape = wan.shape(width, height);
    const { frames } = await (await session(FILM.decode)).run({ latents: new Tensor('float16', halves(wan.frames(latent, shape)), [shape[1], 48, shape[2], shape[3]]) });
    if (frames.dims[0] !== wan.FRAMES) throw new Error('The model returned an unexpected frame count.');
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const video = new CanvasSource(canvas, { codec: 'avc', bitrate: 4000000, fullCodecString: 'avc1.42002a' });
    output.addVideoTrack(video, { frameRate: wan.FPS }); await output.start();
    const pixels = numbers(frames.data), plane = width * height, image = new ImageData(width, height);
    for (let frame = 0; frame < wan.FRAMES; frame++) {
      for (let i = 0; i < plane; i++) for (let c = 0; c < 4; c++) image.data[i * 4 + c] = c === 3 ? 255 : pixels[(frame * 3 + c) * plane + i] * 255;
      ctx.putImageData(image, 0, 0); await video.add(frame / wan.FPS, 1 / wan.FPS);
    }
    await video.close(); await output.finalize();
    return { bytes: new Uint8Array(output.target.buffer) };
  },
};
self.onmessage = async ({ data: { type, ...data } }) => {
  try {
    const result = await stages[type](data);
    self.postMessage({ type: 'done', ...result }, { transfer: Object.values(result).flatMap(value => value.buffer ? [value.buffer] : []) });
  } catch (error) { self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
};
