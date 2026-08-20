import sharp from 'sharp';
import { denseUiClip, DENSE_UI_STATES, DENSE_UI_HEADER } from './test/helpers/golden-clips.js';
import { extractDenseFrames } from './src/processors/frame-extractor.js';
import { createTempDir } from './src/utils/temp-files.js';
import { join } from 'node:path';

const clip = await denseUiClip();
const dir = await createTempDir();
const frames = await extractDenseFrames(clip, dir, { maxFrames: 4 });
console.log('frames:', frames.length, (await sharp(frames[0].filePath).metadata()).width + 'px source\n');

const Tesseract = await import('tesseract.js');
const words = [DENSE_UI_HEADER, ...DENSE_UI_STATES].flatMap(s => s.split(/\s+/));

for (const cap of [3000, 2400, 1920, 0]) {
  const out = await createTempDir();
  const t0 = Date.now();
  const worker = await Tesseract.createWorker('eng+por', undefined, { cachePath: join(dir, 'tess') });
  let hits = 0;
  for (const [i, f] of frames.entries()) {
    const p = join(out, `p${i}.png`);
    const meta = await sharp(f.filePath).metadata();
    let pipe = sharp(f.filePath).greyscale();
    if (cap > 0) pipe = pipe.resize({ width: Math.min((meta.width ?? 0) * 2, cap), withoutEnlargement: false });
    await pipe.normalise().sharpen().png().toFile(p);
    const { data } = await worker.recognize(p);
    const text = data.text.toUpperCase();
    hits += words.filter(w => text.includes(w.toUpperCase())).length;
  }
  await worker.terminate();
  console.log(`upscale cap ${String(cap || 'none').padStart(4)}: ${((Date.now()-t0)/1000).toFixed(1)}s  ground-truth words found: ${hits}/${words.length * frames.length}`);
}
