import { CACHE, FILES, MODEL_BYTES, MODEL_REVISION } from './model.js';
import type { NarrativePlan } from '@/lib/narrative/plan';
export { MODEL_BYTES };
export type Progress = { phase: string; loaded?: number; total?: number; done?: number };
type WorkerResult = { type: string; message?: string; hidden: Uint16Array; latent: Float32Array; bytes: Uint8Array<ArrayBuffer>; loaded?: number; total?: number; done?: number };
type Adapter = { features: { has(name: string): boolean } };
type GPU = { requestAdapter(options: { powerPreference: string }): Promise<Adapter | null> };

export async function capability(): Promise<string | null> {
  if (!globalThis.isSecureContext) return 'Local generation needs the HTTPS version of this app.';
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return 'This browser does not expose WebGPU. Open this same app in an up-to-date Chrome browser on your Mac.';
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter?.features.has('shader-f16') || typeof Float16Array === 'undefined') return 'This browser needs WebGPU with 16-bit floating-point support. Update the browser and enable hardware acceleration.';
  if (!('VideoEncoder' in globalThis) || !('OffscreenCanvas' in globalThis)) return 'This browser lacks the local video encoding APIs. Try current Chrome on this Mac.';
  const supported = await VideoEncoder.isConfigSupported({ codec: 'avc1.42002a', width: 832, height: 480, bitrate: 4000000, framerate: 16 });
  if (!supported.supported) return 'This browser cannot encode the H.264 format needed for your movie.';
  return null;
}

function stage(script: string, data: object, signal: AbortSignal, report: (result: WorkerResult) => void): Promise<WorkerResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(`/browser-gpu/${script}.js`, { type: 'module' });
    const finish = (error?: Error, result?: WorkerResult) => {
      worker.terminate(); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new DOMException('Generation stopped. Completed shots are kept on this device.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data: result }: MessageEvent<WorkerResult>) => {
      if (result.type === 'done') finish(undefined, result);
      else if (result.type === 'error') finish(new Error(result.message)); else report(result);
    };
    worker.onerror = event => finish(new Error(event.message || 'The local GPU worker stopped. Completed shots are kept.'));
    worker.postMessage(data);
  });
}
export async function exclusively<T>(work: () => Promise<T>): Promise<T> {
  return navigator.locks.request('mvw-browser-gpu', { ifAvailable: true }, lock => {
    if (!lock) throw new Error('Local generation is already running in another tab.');
    return work();
  });
}
export async function prepare(signal: AbortSignal, report: (progress: Progress) => void) {
  const error = await capability(); if (error) throw new Error(error);
  const cache = await caches.open(CACHE);
  let missing = 0;
  for (const file of FILES) if (!(await cache.match(`https://huggingface.co/${file[0]}`))) missing += file[2];
  const quota = await navigator.storage.estimate();
  if (quota.quota && missing > quota.quota - (quota.usage ?? 0)) throw new Error('Your browser has insufficient available storage for the model. Free space or clear other site data, then retry.');
  await navigator.storage.persist?.();
  await stage('stage-worker', { type: 'download' }, signal, p => report({ phase: 'Downloading and verifying AI model', loaded: p.loaded, total: p.total }));
}
export async function generate(prompt: string, signal: AbortSignal, report: (progress: Progress) => void): Promise<Blob> {
  report({ phase: 'Reading the shot prompt on this device' });
  let { hidden } = await stage('stage-worker', { type: 'words', prompt }, signal, () => {});
  for (let part = 0; part < 3; part++) {
    report({ phase: `Encoding story prompt (${part + 1}/3)` });
    ({ hidden } = await stage('stage-worker', { type: 'read', part, hidden }, signal, () => {}));
  }
  const embeds = new Uint16Array(512 * 4096); embeds.set(hidden);
  report({ phase: 'Generating motion on this device' });
  const { latent } = await stage('stage-worker', { type: 'denoise', embeds, width: 832, height: 480 }, signal, p => report({ phase: `Generating motion (${p.done}/3)` }));
  report({ phase: 'Decoding and encoding the generated video' });
  const { bytes } = await stage('stage-worker', { type: 'decode', latent, width: 832, height: 480 }, signal, () => {});
  return new Blob([bytes], { type: 'video/mp4' });
}
export async function fingerprint(projectId: string, audioId: string, plan: NarrativePlan) {
  const data = new TextEncoder().encode(JSON.stringify({ projectId, audioId, plan, revision: MODEL_REVISION }));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
}
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('mvw-local-shots', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('clips');
    request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
  });
}
async function clipRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('clips', mode), request = run(transaction.objectStore('clips'));
      transaction.oncomplete = () => resolve(request.result); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error ?? new Error('Local clip storage was interrupted.'));
    });
  } finally { db.close(); }
}
export const readClip = (key: string) => clipRequest<Blob | undefined>('readonly', store => store.get(key));
export const keepClip = (key: string, clip: Blob) => clipRequest('readwrite', store => store.put(clip, key));
export async function clearModel() { await caches.delete(CACHE); }
export async function clearClips(prefix: string) {
  const keys = await clipRequest('readonly', store => store.getAllKeys());
  for (const key of keys) if (typeof key === 'string' && key.startsWith(`${prefix}:`)) await clipRequest('readwrite', store => store.delete(key));
}
export async function assembleMovie(projectId: string, audioId: string, plan: NarrativePlan, clips: Blob[], signal: AbortSignal, report: (progress: Progress) => void) {
  report({ phase: 'Loading the original soundtrack' });
  const response = await fetch(`/api/projects/${projectId}/narrative/audio?version=${encodeURIComponent(audioId)}`, { signal });
  if (!response.ok) throw new Error('The original soundtrack is unavailable or changed. Reload the project.');
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try { decoded = await context.decodeAudioData(await response.arrayBuffer()); } finally { await context.close(); }
  signal.throwIfAborted();
  const audio = { sampleRate: decoded.sampleRate, channels: Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c)) };
  report({ phase: 'Assembling the movie with your original song' });
  const { bytes } = await stage('assembly-worker', { shots: plan.shots.map((shot, i) => ({ startMs: shot.startMs, endMs: shot.endMs, blob: clips[i] })), audio, durationMs: plan.durationMs }, signal,
    p => report({ phase: 'Assembling the movie with your original song', done: p.done, total: p.total }));
  return new Blob([bytes], { type: 'video/mp4' });
}
