import { CACHE } from './model.js';

// Only fixed, revision-pinned entries from model.js reach this function.
export async function weights(file, progress = () => {}) {
  const [path, hash, size] = file;
  const url = `https://huggingface.co/${path}`;
  const cache = await caches.open(CACHE);
  const saved = await cache.match(url);
  if (saved) return new Uint8Array(await saved.arrayBuffer());
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok || !response.body) throw new Error(`Model download failed (HTTP ${response.status}). Retry to resume completed files.`);
  let loaded = 0, last = 0;
  const counted = new TransformStream({ transform(chunk, controller) {
    loaded += chunk.length;
    if (loaded > size) throw new Error('Model file exceeds its pinned size.');
    if (performance.now() - last > 150) { progress(loaded); last = performance.now(); }
    controller.enqueue(chunk);
  } });
  const bytes = await new Response(response.body.pipeThrough(counted)).arrayBuffer();
  if (bytes.byteLength !== size) throw new Error('Incomplete model download. Retry to resume completed files.');
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
  if (actual !== hash) throw new Error('Model checksum mismatch. No unverified weights were cached.');
  await cache.put(url, new Response(bytes));
  progress(size);
  return new Uint8Array(bytes);
}

export async function downloadModel(files, report) {
  const cache = await caches.open(CACHE);
  const total = files.reduce((sum, file) => sum + file[2], 0);
  let before = 0;
  for (const file of files) {
    if (!(await cache.match(`https://huggingface.co/${file[0]}`))) {
      await weights(file, loaded => report({ loaded: before + loaded, total }));
    }
    before += file[2]; report({ loaded: before, total });
  }
}
