import { extractDenseFrames } from './src/processors/frame-extractor.js';
import { optimizeFrames } from './src/processors/image-optimizer.js';
import { createTempDir } from './src/utils/temp-files.js';
import { stat } from 'node:fs/promises';
import sharp from 'sharp';

const clip = process.argv[2];
const dir = await createTempDir();
const frames = await extractDenseFrames(clip, dir, { maxFrames: 45 });
const src = frames.map(f => f.filePath);
const meta = await sharp(src[0]).metadata();
const rawBytes = (await Promise.all(src.map(async p => (await stat(p)).size))).reduce((a,b)=>a+b,0);
console.log(`source frames: ${src.length} at ${meta.width}x${meta.height}, ${(rawBytes/1e6).toFixed(1)} MB total\n`);

for (const [label, opts] of [
  ['800px  q70  (current default)', { maxWidth: 800, quality: 70 }],
  ['1280px q80', { maxWidth: 1280, quality: 80 }],
  ['1600px q85', { maxWidth: 1600, quality: 85 }],
  ['source q90', { maxWidth: 0, quality: 90 }],
  ['source q95', { maxWidth: 0, quality: 95 }],
] as const) {
  const out = await createTempDir();
  const t = Date.now();
  const paths = await optimizeFrames(src, out, opts as Record<string, number>);
  const ms = Date.now() - t;
  const bytes = (await Promise.all(paths.map(async p => (await stat(p)).size))).reduce((a,b)=>a+b,0);
  const m = await sharp(paths[0]).metadata();
  console.log(`${label.padEnd(30)} ${(ms/1000).toFixed(1)}s   ${String(m.width).padStart(4)}px   ${(bytes/1e6).toFixed(1)} MB zip`);
}
