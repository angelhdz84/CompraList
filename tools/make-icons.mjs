// Genera los PNG del icono PWA sin dependencias externas (solo node:zlib).
// Traza la misma bolsa de compra que assets/icon.svg.
//
//   node tools/make-icons.mjs
//
// Si cambias el dibujo, sube tambien CACHE_VERSION en sw.js.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');
const SS = 3; // supersampling para el antialiasing

const INDIGO = [0x4f, 0x46, 0xe5];
const WHITE = [0xff, 0xff, 0xff];

// ------------------------------------------------------------------ primitivas

function makeCanvas(size) {
  return { size, data: new Uint8Array(size * size * 4) };
}

function blend(c, x, y, rgb, alpha) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  const a = Math.min(1, alpha);
  const dstA = c.data[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA === 0) return;
  for (let k = 0; k < 3; k++) {
    c.data[i + k] = Math.round((rgb[k] * a + c.data[i + k] * dstA * (1 - a)) / outA);
  }
  c.data[i + 3] = Math.round(outA * 255);
}

/** Rectángulo redondeado con borde suave (cobertura antialiaseada). r=0 -> rectángulo opaco. */
function fillRoundRect(c, x0, y0, w, h, r, rgb) {
  const s = c.size;
  const x1 = x0 + w;
  const y1 = y0 + h;
  // Sin redondeo el nombre de distancia se aplana y daria cov=0.5 en todo el interior.
  if (!(r > 0)) {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        const covX = Math.max(0, Math.min(1, Math.min(x + 1, x1) - Math.max(x, x0)));
        const covY = Math.max(0, Math.min(1, Math.min(y + 1, y1) - Math.max(y, y0)));
        const cov = covX * covY;
        if (cov > 0) blend(c, x, y, rgb, cov);
      }
    }
    return;
  }
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y++) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // distancia con esquinas redondeadas
      const dx = Math.max(x0 + r - px, 0, px - (x1 - r));
      const dy = Math.max(y0 + r - py, 0, py - (y1 - r));
      const d = Math.hypot(dx, dy) - r;
      const cov = Math.max(0, Math.min(1, 0.5 - d));
      if (cov > 0) blend(c, x, y, rgb, cov);
    }
  }
  void s;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Polilínea "trazada": pinta donde la distancia al trazo es menor que halfWidth. */
function strokePolyline(c, pts, halfWidth, rgb) {
  const s = c.size;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const pad = halfWidth + 1.5;
  for (let y = Math.floor(minY - pad); y <= Math.ceil(maxY + pad); y++) {
    for (let x = Math.floor(minX - pad); x <= Math.ceil(maxX + pad); x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let best = Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = distToSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        if (d < best) best = d;
      }
      const cov = Math.max(0, Math.min(1, halfWidth - best + 0.5));
      if (cov > 0) blend(c, x, y, rgb, cov);
    }
  }
  void s;
}

function arcPoints(cx, cy, rx, ry, a0, a1, steps = 48) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

// --------------------------------------------------------------------- dibujo

/**
 * Dibuja la bolsa de compra.
 * @param scale 1 = ocupa todo el lienzo; menor = centrado con margen (maskable).
 */
function drawBag(c, scale) {
  const S = c.size;
  const U = (v) => (0.5 + (v - 0.5) * scale) * S;   // unidad 0..1 -> px
  const L = (v) => v * scale * S;                    // longitud -> px

  // Sombra sutil bajo la bolsa para que no quede plana sobre el fondo.
  // (solo un leve oscurecido, sin librerias)

  const hw = L(0.030);
  const P = (x, y) => [U(x), U(y)];

  // Contorno: (6,2) -> (3,6) -> (3,20) -> fondo redondeado -> (21,20) -> (21,6) -> (18,2)
  const outline = [
    P(6 / 24, 2 / 24), P(3 / 24, 6 / 24), P(3 / 24, 20 / 24),
  ];
  // esquina inferior izquierda
  outline.push(...arcPoints(U(5 / 24), U(20 / 24), L(2 / 24), L(2 / 24), Math.PI, Math.PI / 2, 8)
    .map(([x, y]) => [x, y]));
  outline.push(P(19 / 24, 22 / 24));
  outline.push(...arcPoints(U(19 / 24), U(20 / 24), L(2 / 24), L(2 / 24), -Math.PI / 2, 0, 8)
    .map(([x, y]) => [x, y]));
  outline.push(P(21 / 24, 6 / 24), P(18 / 24, 2 / 24));

  strokePolyline(c, outline, hw, WHITE);

  // Tapa: (3,6) -> (21,6)
  strokePolyline(c, [P(3 / 24, 6 / 24), P(21 / 24, 6 / 24)], hw, WHITE);

  // Asa: semicírculo superior centrada en (12,10) radio 4
  const handle = arcPoints(U(12 / 24), U(10 / 24), L(4 / 24), L(4 / 24), Math.PI, 2 * Math.PI, 40);
  strokePolyline(c, handle, hw * 0.78, WHITE);
}

/** Reduce el canvas supersampleado al tamaño final con promediado de caja. */
function downsample(src, factor) {
  const size = src.size / factor;
  const out = makeCanvas(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * src.size + (x * factor + dx)) * 4;
          const al = src.data[i + 3] / 255;
          r += src.data[i] * al; g += src.data[i + 1] * al; b += src.data[i + 2] * al;
          a += al;
        }
      }
      const n = factor * factor;
      const o = (y * size + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
      }
      out.data[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------- codificacion

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(c) {
  const { size, data } = c;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // filtro por defecto
  ihdr[12] = 0;  // sin entrelazado

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filtro None
    Buffer.from(data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------------- salida

function render(size, { maskable = false } = {}) {
  const hi = makeCanvas(size * SS);
  if (maskable) {
    // Maskable: fondo a sangre (el sistema recorta), logo al 62% (safe zone).
    fillRoundRect(hi, 0, 0, hi.size, hi.size, 0, INDIGO);
    drawBag(hi, 0.62);
  } else {
    fillRoundRect(hi, 0, 0, hi.size, hi.size, hi.size * 0.22, INDIGO);
    drawBag(hi, 0.86);
  }
  return downsample(hi, SS);
}

mkdirSync(OUT, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

for (const t of targets) {
  const png = encodePng(render(t.size, { maskable: t.maskable }));
  writeFileSync(join(OUT, t.file), png);
  console.log(`ok     ${t.file} (${t.size}x${t.size}, ${png.length} bytes)`);
}
