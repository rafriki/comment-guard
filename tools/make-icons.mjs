// make-icons.mjs — generates the extension's PNG icons with zero dependencies.
// Draws a "prohibition" sign (white ring + diagonal bar) on a LinkedIn-blue
// rounded square: "block the spam". Run: `node tools/make-icons.mjs`.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "icons");
mkdirSync(OUT, { recursive: true });

const BLUE = [10, 102, 194, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

// Continuous-coordinate color sampler for the icon at logical size S.
function sample(x, y, S) {
  const cr = S * 0.2; // corner radius
  // Rounded-rect mask.
  const dx = Math.max(cr - x, x - (S - cr), 0);
  const dy = Math.max(cr - y, y - (S - cr), 0);
  if (dx > 0 && dy > 0 && dx * dx + dy * dy > cr * cr) return CLEAR;

  const cx = S / 2;
  const cy = S / 2;
  const px = x - cx;
  const py = y - cy;
  const dist = Math.hypot(px, py);

  const ringCenterR = S * 0.3;
  const ringHalf = S * 0.06;
  const barHalf = S * 0.055;

  // White ring.
  if (Math.abs(dist - ringCenterR) <= ringHalf) return WHITE;
  // White diagonal bar (top-left to bottom-right) within the ring.
  const barDist = Math.abs(-px + py) / Math.SQRT2;
  if (barDist <= barHalf && dist <= ringCenterR + ringHalf) return WHITE;

  return BLUE;
}

function render(S, ss = 4) {
  const buf = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss, S);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = ss * ss;
      const i = (y * S + x) * 4;
      buf[i] = Math.round(r / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(b / n);
      buf[i + 3] = Math.round(a / n);
    }
  }
  return buf;
}

// --- minimal PNG encoder ----------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(rgba, S) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // [10..12] compression/filter/interlace = 0
  const stride = S * 4;
  const raw = Buffer.alloc((stride + 1) * S);
  for (let y = 0; y < S; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

for (const S of [16, 48, 128]) {
  const png = encodePNG(render(S), S);
  const file = join(OUT, `icon${S}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
