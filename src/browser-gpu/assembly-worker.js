import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioSampleSource, AudioSample, Input, BlobSource, MP4, CanvasSink, canEncodeAudio } from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';

// One global frame grid avoids accumulating rounding error across narrative shots.
export function shotFrames(startMs, endMs, fps = 24) {
  return { first: Math.ceil(startMs * fps / 1000), end: Math.ceil(endMs * fps / 1000) };
}

export async function assemble({ shots, audio, durationMs, width = 832, height = 480 }, report) {
  if (!(await canEncodeAudio('aac', { sampleRate: audio.sampleRate, numberOfChannels: audio.channels.length, bitrate: 256000 }))) registerAacEncoder();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
  const video = new CanvasSource(canvas, { codec: 'avc', bitrate: 5000000, fullCodecString: 'avc1.42002a' });
  const sound = new AudioSampleSource({ codec: 'aac', bitrate: 256000 });
  output.addVideoTrack(video, { frameRate: 24 }); output.addAudioTrack(sound); await output.start();
  const samples = audio.channels[0].length, audioDuration = samples / audio.sampleRate;
  if (Math.abs(audioDuration - durationMs / 1000) > 0.15) throw new Error('The decoded soundtrack no longer matches this story. Analyze the soundtrack again.');
  // Keep all original decoded samples: never stretch, loop, or replace the song.
  for (let offset = 0; offset < samples; offset += audio.sampleRate) {
    const count = Math.min(audio.sampleRate, samples - offset), pcm = new Float32Array(count * audio.channels.length);
    audio.channels.forEach((channel, c) => pcm.set(channel.subarray(offset, offset + count), c * count));
    const sample = new AudioSample({ data: pcm, format: 'f32-planar', numberOfChannels: audio.channels.length, sampleRate: audio.sampleRate, timestamp: offset / audio.sampleRate });
    try { await sound.add(sample); } finally { sample.close(); }
  }
  sound.close();
  let expected = 0;
  for (const shot of shots) {
    const { first, end } = shotFrames(shot.startMs, shot.endMs);
    if (first !== expected || end <= first) throw new Error('The story has missing or overlapping frames.');
    const input = new Input({ source: new BlobSource(shot.blob), formats: [MP4] });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('A generated shot has no video track.');
      const length = await track.computeDuration(), sink = new CanvasSink(track);
      // Retiming a generated five-second take to the planned shot length is explicit in the UI.
      const times = Array.from({ length: end - first }, (_, i) => i / (end - first) * length);
      let frame = first;
      for await (const picture of sink.canvasesAtTimestamps(times)) {
        if (!picture) throw new Error('A generated shot could not be decoded.');
        ctx.drawImage(picture.canvas, 0, 0, width, height);
        await video.add(frame / 24, 1 / 24); frame++;
      }
      if (frame !== end) throw new Error('A generated shot ended before all planned frames were encoded.');
    } finally { input.dispose(); }
    expected = end; report({ done: expected, total: Math.ceil(durationMs * 24 / 1000) });
  }
  if (expected !== Math.ceil(durationMs * 24 / 1000)) throw new Error('The movie does not cover the complete song.');
  video.close(); await output.finalize();
  return new Uint8Array(output.target.buffer);
}

if (typeof self !== 'undefined' && typeof document === 'undefined') self.onmessage = async ({ data }) => {
  try {
    const bytes = await assemble(data, progress => self.postMessage({ type: 'progress', ...progress }));
    self.postMessage({ type: 'done', bytes }, { transfer: [bytes.buffer] });
  } catch (error) { self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
};
