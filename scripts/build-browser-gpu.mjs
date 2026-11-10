import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';

const destination = 'public/browser-gpu';
await mkdir(`${destination}/vendor`, { recursive: true });
for (const file of ['ort.webgpu.bundle.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  await copyFile(`node_modules/onnxruntime-web/dist/${file}`, `${destination}/vendor/${file}`);
}
for (const worker of ['stage-worker', 'assembly-worker']) {
  await build({ entryPoints: [`src/browser-gpu/${worker}.js`], outfile: `${destination}/${worker}.js`, bundle: true, format: 'esm', platform: 'browser', target: 'es2024', minify: true, external: ['./vendor/ort.webgpu.bundle.min.mjs'], legalComments: 'eof' });
}
let licenses = await readFile('THIRD_PARTY_NOTICES.md', 'utf8');
for (const dependency of ['@huggingface/tokenizers', 'onnxruntime-web', 'mediabunny', '@mediabunny/aac-encoder']) {
  const pkg = JSON.parse(await readFile(`node_modules/${dependency}/package.json`, 'utf8'));
  licenses += `\n\n${dependency} ${pkg.version} — ${pkg.license}\n`;
  licenses += await readFile(dependency === 'onnxruntime-web' ? 'licenses/onnxruntime-MIT.txt' : `node_modules/${dependency}/LICENSE`, 'utf8');
}
await writeFile(`${destination}/LICENSES.txt`, licenses);
