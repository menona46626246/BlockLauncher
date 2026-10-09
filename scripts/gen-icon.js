/**
 * gen-icon.js - Genera el icono de BlockLauncher (512x512 PNG)
 * Pixel-art de un bloque de hierba estilo Minecraft, esquinas redondeadas.
 * PNG escrito a mano (IHDR + IDAT zlib + IEND), sin dependencias.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 512;          // 512x512
const GRID = 16;           // celda lógica 16x16 → 32px por celda
const CELL = SIZE / GRID;  // 32
const RADIUS = 90;          // esquinas redondeadas (px)

// PRNG determinista para texturas reproducibles
let seed = 20261009;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

// Paleta
const GRASS = [[124, 189, 75], [106, 173, 65], [138, 201, 90], [94, 158, 60]];
const DIRT = [[138, 90, 50], [122, 78, 42], [150, 99, 58], [107, 66, 35]];
const GRASS_DARK = [86, 140, 52];
const DIRT_DARK = [86, 55, 28];

function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

// Color de una celda lógica (gx, gy 0..15)
function cellColor(gx, gy) {
  // Fila de transición jagged entre pasto y tierra (fila 5)
  const jagged = gy === 5 && (gx % 3 === 1);
  const isGrass = gy <= 4 || jagged;

  let rgb = isGrass ? pick(GRASS) : pick(DIRT);

  // Bordes del bloque: sombrear para dar volumen
  const isEdge = gx === 0 || gx === GRID - 1 || gy === 0 || gy === GRID - 1;
  if (isEdge) {
    const dark = isGrass ? GRASS_DARK : DIRT_DARK;
    rgb = [Math.round(rgb[0] * 0.72 + dark[0] * 0.0), Math.max(0, rgb[1] - 30), Math.max(0, rgb[2] - 18)];
    rgb = [Math.round(rgb[0] * 0.9), Math.round(rgb[1] * 0.9), Math.round(rgb[2] * 0.9)];
  }

  // Filas superiores ligeramente más claras (luz)
  if (gy <= 1 && !isEdge) {
    rgb = [Math.min(255, rgb[0] + 12), Math.min(255, rgb[1] + 14), Math.min(255, rgb[2] + 10)];
  }

  return rgb;
}

// Construir RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1)); // +1 filter byte por fila
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const gx = Math.floor(x / CELL);
    const gy = Math.floor(y / CELL);

    // Esquinas redondeadas → transparente
    let inside = true;
    const r = RADIUS;
    if (x < r && y < r && (r - x) * (r - x) + (r - y) * (r - y) > r * r) inside = false;
    if (x >= SIZE - r && y < r && (x - (SIZE - r - 1)) ** 2 + (r - y) ** 2 > r * r) inside = false;
    if (x < r && y >= SIZE - r && (r - x) ** 2 + (y - (SIZE - r - 1)) ** 2 > r * r) inside = false;
    if (x >= SIZE - r && y >= SIZE - r && (x - (SIZE - r - 1)) ** 2 + (y - (SIZE - r - 1)) ** 2 > r * r) inside = false;

    if (inside) {
      const [R, G, B] = cellColor(gx, gy);
      raw[p++] = R; raw[p++] = G; raw[p++] = B; raw[p++] = 255;
    } else {
      raw[p++] = 0; raw[p++] = 0; raw[p++] = 0; raw[p++] = 0;
    }
  }
}

// === Codificador PNG ===
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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type: RGBA
ihdr[10] = 0;  // compression
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // interlace

const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  signature,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
]);

const outDir = process.argv[2] || '.';
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'icon.png');
fs.writeFileSync(outPath, png);
console.log('Icono generado:', outPath, '-', (png.length / 1024).toFixed(1), 'KB');
