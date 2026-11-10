import { describe, expect, it, vi, afterEach } from 'vitest';
import { frames, patchify, unpatchify, rope, shape, SIGMAS } from './fastwan.js';
import { CACHE, FILES, MODEL_BYTES } from './model.js';
import { weights } from './cache.js';
import { shotFrames } from './assembly-worker.js';

afterEach(() => vi.unstubAllGlobals());
describe('browser FastWan model contract', () => {
  it('keeps every shot on one global frame grid through the complete original song', () => {
    const boundaries = [0, 35968, 81000, 122044, 154947, 166951, 208515, 230023];
    let previous = 0;
    for (let i = 1; i < boundaries.length; i++) {
      const { first, end } = shotFrames(boundaries[i - 1], boundaries[i]);
      expect(first).toBe(previous); previous = end;
    }
    expect(previous).toBe(5521);
  });
  it('declares its real download size and immutable model revision for every file', () => {
    expect(MODEL_BYTES / 1e9).toBeGreaterThan(11);
    expect(MODEL_BYTES / 1e9).toBeLessThan(12);
    expect(new Set(FILES.map(file => file[0])).size).toBe(FILES.length);
    for (const [path, hash, size] of FILES) {
      expect(path).toContain('/resolve/be5c3e118918b31a600c2e055f33050f904689b1/');
      expect(hash).toMatch(/^[a-f0-9]{64}$/); expect(size).toBeGreaterThan(0);
    }
    expect(shape(832, 480)).toEqual([48, 21, 30, 52]);
    expect(SIGMAS[0]).toBe(1); expect(SIGMAS[1]).toBeCloseTo(0.756757, 5); expect(SIGMAS[2]).toBeCloseTo(0.521739, 5);
  });
  it('respects the different channel order of transformer input and output', () => {
    const dims = [2, 1, 2, 2];
    const latent = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...patchify(latent, dims)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...unpatchify(Float32Array.from([0, 4, 1, 5, 2, 6, 3, 7]), dims)]).toEqual([...latent]);
    expect([...frames(Float32Array.from([1, 2, 3, 4]), [2, 2, 1, 1])]).toEqual([1, 3, 2, 4]);
  });
  it('uses opposite sine signs in each rotary pair', () => {
    const { cos, sin } = rope(2, 1, 1);
    expect(cos[0]).toBe(1); expect(sin[0]).toBe(-0);
    expect(cos[128]).toBeCloseTo(Math.cos(1));
    expect(sin[128]).toBeCloseTo(-Math.sin(1)); expect(sin[129]).toBeCloseTo(Math.sin(1));
  });
});
describe('download integrity before caching', () => {
  it('does not cache corrupted or oversized weights', async () => {
    const put = vi.fn();
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({ match: vi.fn(), put }) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('wrong')));
    await expect(weights(['model', '0'.repeat(64), 5])).rejects.toThrow('checksum mismatch');
    expect(put).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('too large')));
    await expect(weights(['model', '0'.repeat(64), 5])).rejects.toThrow('exceeds');
    expect(put).not.toHaveBeenCalled();
  });
  it('reuses its own model cache without fetching or reading another app cache', async () => {
    const open = vi.fn().mockResolvedValue({ match: vi.fn().mockResolvedValue(new Response('kept')) }), fetch = vi.fn();
    vi.stubGlobal('caches', { open }); vi.stubGlobal('fetch', fetch);
    expect(new TextDecoder().decode(await weights(['model', '0'.repeat(64), 4]))).toBe('kept');
    expect(open).toHaveBeenCalledWith(CACHE); expect(fetch).not.toHaveBeenCalled();
  });
});
