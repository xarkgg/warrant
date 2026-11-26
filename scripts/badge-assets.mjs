#!/usr/bin/env node
/**
 * Turn the badge artwork into the icons the app ships.
 *
 * The originals are flat raster with a soft graphic ground — a bloom around the
 * mark and, for the six rank badges, a dark navy plate. Neither keys cleanly by
 * luminance: the ground carries colour, and a chroma key punches holes through
 * the mark's own specular highlights. So this grows a region inward from the
 * frame edge through pixels that are near-identical to the neighbour they came
 * from, and only then applies two corrections:
 *
 *   - a halo scrub, because the bloom's inner edge is more saturated than the
 *     ground test allows and would otherwise ship as a purple collar;
 *   - keep-the-largest-component, because pastel corners of the ground can be
 *     too saturated to fail a lightness test and survive as detached shards.
 *
 * The mark is a raster, not a traced vector, on purpose: its character is the
 * gloss and the inner ring, and a 24px path of it reads as a purple blob.
 *
 *   node scripts/badge-assets.mjs --mark ~/art/badge.png --ranks ~/art/ranks.png
 *
 * The originals live outside the repo (they are the author's working art), so
 * this script is the record of how the committed PNGs were made. `--out` is
 * where the rank tiles land; they are not shipped today.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const puppeteer = (() => {
  try {
    return require('puppeteer');
  } catch {
    return require('/data/data/com.termux/files/usr/lib/node_modules/puppeteer/lib/puppeteer/puppeteer.js');
  }
})();

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

// ------------------------------------------------------------------- cli

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const MARK = arg('mark', '/data/data/com.termux/files/home/storage/pictures/file_0000000020c881f4a95a5f8ee369ad45.png');
const RANKS = arg('ranks', '/data/data/com.termux/files/home/storage/pictures/file_00000000771c821096927ccf59d5135e.png');
const OUT = arg('out', path.join(process.env.OPENCODE_TMP_DIR || '/tmp', 'warrant-badge'));

for (const [name, file] of [['--mark', MARK], ['--ranks', RANKS]]) {
  if (!fs.existsSync(file)) {
    console.error(`missing ${name}: ${file}`);
    process.exit(1);
  }
}

const b64 = (p) => fs.readFileSync(p).toString('base64');

// ---------------------------------------------------------------- in-page

const PAGE = `
  async function decode(src) {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + src;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { canvas: c, w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height) };
  }

  function keyGround(im, mode, opts) {
    opts = opts || {};
    const { w, h, d } = im;
    const px = d.data;
    const seen = new Uint8Array(w * h);
    const q = new Int32Array(w * h);
    let qh = 0, qt = 0;
    const push = (i) => { if (!seen[i]) { seen[i] = 1; q[qt++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }

    const sat = (i) => {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      return mx === 0 ? 0 : (mx - mn) / mx;
    };
    const lum = (i) => (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
    const delta = (a, b) => Math.max(
      Math.abs(px[a * 4] - px[b * 4]),
      Math.abs(px[a * 4 + 1] - px[b * 4 + 1]),
      Math.abs(px[a * 4 + 2] - px[b * 4 + 2]),
    );

    // The light ground is a lavender-to-white gradient, so "light" is the test —
    // not "unsaturated", which its bloom is not. The dark ground is a saturated
    // navy, so there the test is "dark" only; saturation would reject the ground
    // itself and clear nothing.
    const groundish = mode === 'light'
      ? (i) => (lum(i) > 0.78 && sat(i) < 0.34) || lum(i) > 0.935
      : (i) => lum(i) < 0.42;
    const STEP = mode === 'light' ? 14 : 10;

    const clear = new Uint8Array(w * h);
    while (qh < qt) {
      const i = q[qh++];
      clear[i] = 1;
      const x = i % w;
      const nb = [
        x > 0 ? i - 1 : -1,
        x < w - 1 ? i + 1 : -1,
        i - w,
        i + w,
      ];
      for (const n of nb) {
        if (n < 0 || n >= w * h || seen[n]) continue;
        if (!groundish(n)) continue;
        if (delta(i, n) > STEP) continue;
        push(n);
      }
    }

    const haloish = mode === 'light'
      ? (i) => lum(i) > 0.72 && sat(i) < 0.42
      : (i) => lum(i) < 0.30;
    for (let pass = 0; pass < 14; pass++) {
      const stamp = [];
      for (let i = 0; i < w * h; i++) {
        if (clear[i] || !haloish(i)) continue;
        const x = i % w;
        if ((x > 0 && clear[i - 1]) || (x < w - 1 && clear[i + 1]) || clear[i - w] || clear[i + w]) {
          stamp.push(i);
        }
      }
      if (!stamp.length) break;
      for (const i of stamp) clear[i] = 1;
    }

    if (opts.keepLargest) {
      const label = new Int32Array(w * h).fill(-1);
      let best = -1, bestArea = 0;
      for (let start = 0; start < w * h; start++) {
        if (clear[start] || label[start] >= 0) continue;
        const stack = [start];
        label[start] = start;
        let area = 0;
        while (stack.length) {
          const i = stack.pop();
          area++;
          const x = i % w;
          const nb = [
            x > 0 ? i - 1 : -1,
            x < w - 1 ? i + 1 : -1,
            i - w,
            i + w,
          ];
          for (const n of nb) {
            if (n < 0 || n >= w * h || clear[n] || label[n] >= 0) continue;
            label[n] = start;
            stack.push(n);
          }
        }
        if (area > bestArea) { bestArea = area; best = start; }
      }
      for (let i = 0; i < w * h; i++) if (label[i] !== best) clear[i] = 1;

      // A sliver of ground can stay attached to the silhouette. It is light and
      // unsaturated like the mark's own highlight ring; thickness is what
      // separates them, so drop pixels with too few opaque neighbours.
      for (let pass = 0; pass < 3; pass++) {
        const drop = [];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (clear[i] || lum(i) < 0.72 || sat(i) > 0.30) continue;
            let opaque = 0;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const xx = x + dx, yy = y + dy;
                if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
                if (!clear[yy * w + xx]) opaque++;
              }
            }
            if (opaque < 5) drop.push(i);
          }
        }
        if (!drop.length) break;
        for (const i of drop) clear[i] = 1;
      }
    }

    // One-pixel feather: the region boundary stair-steps on the bloom's curve.
    const a = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = clear[i] ? 0 : 1;
    const soft = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!a[i]) { soft[i] = 0; continue; }
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            sum += a[yy * w + xx]; n++;
          }
        }
        soft[i] = Math.max(a[i] * 0.55, sum / n);
      }
    }
    let kept = 0;
    for (let i = 0; i < w * h; i++) {
      px[i * 4 + 3] = Math.round(Math.min(1, soft[i]) * 255);
      if (px[i * 4 + 3] > 24) kept++;
    }
    return { d, kept: kept / (w * h) };
  }

  function bbox(d, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d.data[(y * w + x) * 4 + 3] > 24) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return { x0, y0, x1, y1 };
  }

  // Square around the content, then emit each size from the full-resolution
  // source so a 32px icon is a downscale of the art, not of a 256px thumbnail.
  function square(source, d, w, h, margin, sizes) {
    const bb = bbox(d, w, h);
    const side = Math.max(bb.x1 - bb.x0 + 1, bb.y1 - bb.y0 + 1);
    const box = side + Math.round(side * margin) * 2;
    const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
    const src = document.createElement('canvas');
    src.width = w; src.height = h;
    src.getContext('2d').putImageData(d, 0, 0);
    return sizes.map((s) => {
      const c = document.createElement('canvas');
      c.width = s; c.height = s;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      const k = s / box;
      g.drawImage(src, cx - box / 2, cy - box / 2, box, box, 0, 0, s, s);
      return { size: s, data: c.toDataURL('image/png').split(',')[1] };
    });
  }
`;

// ------------------------------------------------------------------- run

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.evaluate(
  new Function(
    'return (async () => {' + PAGE + '\n; Object.assign(window, { decode, keyGround, square }); })()',
  ),
);

const mark = await page.evaluate(
  async (src, sizes) => {
    const im = await decode(src);
    const keyed = keyGround(im, 'light', { keepLargest: true });
    return { tiles: square(im.canvas, keyed.d, im.w, im.h, 0.04, sizes), kept: keyed.kept };
  },
  b64(MARK),
  [512, 256, 180, 128, 96, 64, 32],
);

const bySize = new Map(mark.tiles.map((t) => [t.size, t.data]));
const write = (rel, data) => {
  const target = path.join(repo, rel);
  fs.writeFileSync(target, Buffer.from(data, 'base64'));
  console.log(`${rel}  ${Math.round(fs.statSync(target).size / 1024)}KB`);
};

// Jira draws the module icon in the app strip and the panel header; 128 covers
// that on a retina display without being a megabyte.
write('static/icons/warrant.png', bySize.get(128));
// The masthead draws it at 28px, so 96 is a clean 3x.
write('static/ui/mark.png', bySize.get(96));

// Rank tiles are not shipped yet. They land in --out so a design decision can
// look at them at their real size first.
const ranks = await page.evaluate(async (src) => {
  const im = await decode(src);
  const { w, h } = im;
  const out = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const x = Math.round((c * w) / 3), y = Math.round((r * h) / 2);
      const cw = Math.round(((c + 1) * w) / 3) - x;
      const ch = Math.round(((r + 1) * h) / 2) - y;
      const cc = document.createElement('canvas');
      cc.width = cw; cc.height = ch;
      const g = cc.getContext('2d', { willReadFrequently: true });
      g.drawImage(im.canvas, x, y, cw, ch, 0, 0, cw, ch);
      const keyed = keyGround({ w: cw, h: ch, d: g.getImageData(0, 0, cw, ch) }, 'dark', {});
      out.push({ index: r * 3 + c + 1, data: square(cc, keyed.d, cw, ch, 0.06, [256])[0].data });
    }
  }
  return out;
}, b64(RANKS));

for (const tile of ranks) {
  const file = path.join(OUT, `rank-${tile.index}-256.png`);
  fs.writeFileSync(file, Buffer.from(tile.data, 'base64'));
}
console.log(`rank tiles 1-${ranks.length} → ${OUT}`);
console.log(`mark kept ${(mark.kept * 100).toFixed(1)}% of the frame`);

await browser.close();
