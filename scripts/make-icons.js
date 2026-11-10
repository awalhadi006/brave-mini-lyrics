/**
 * Generator icon ekstensi tanpa dependency.
 * Jalankan: node scripts/make-icons.js
 *
 * Membuat icon rounded-square gelap dengan not balok hijau,
 * lalu menyimpannya sebagai PNG 16/32/48/128 px.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

const BG_TOP = [15, 23, 42];
const BG_BOTTOM = [30, 41, 59];
const ACCENT = [16, 185, 129];
const ACCENT_LIGHT = [52, 211, 153];

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function mix(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t)
    ];
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
    if (x < left || x > right || y < top || y > bottom) return false;
    const cx = clamp(x, left + radius, right - radius);
    const cy = clamp(y, top + radius, bottom - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
}

function insideEllipse(x, y, cx, cy, rx, ry, angle) {
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    const dx = x - cx;
    const dy = y - cy;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    return (localX * localX) / (rx * rx) + (localY * localY) / (ry * ry) <= 1;
}

function insidePolygon(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const xi = points[i][0];
        const yi = points[i][1];
        const xj = points[j][0];
        const yj = points[j][1];
        const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

function render(size) {
    const dimension = size * SUPERSAMPLE;
    const pixels = Buffer.alloc(dimension * dimension * 4);

    const scale = dimension / 128;
    const radius = 26 * scale;

    for (let y = 0; y < dimension; y += 1) {
        for (let x = 0; x < dimension; x += 1) {
            const index = (y * dimension + x) * 4;
            const px = x + 0.5;
            const py = y + 0.5;

            if (!insideRoundedRect(px, py, 0, 0, dimension, dimension, radius)) {
                pixels[index + 3] = 0;
                continue;
            }

            const t = py / dimension;
            const background = mix(BG_TOP, BG_BOTTOM, t);
            let color = background;

            const nx = px / scale;
            const ny = py / scale;

            // Batang not
            if (insideRoundedRect(nx, ny, 55, 28, 64, 90, 4)) {
                color = ACCENT;
            }

            // Bendera not
            if (
                insidePolygon(nx, ny, [
                    [63, 28],
                    [97, 41],
                    [91, 57],
                    [63, 47]
                ])
            ) {
                color = ACCENT;
            }

            // Kepala not
            if (insideEllipse(nx, ny, 43, 88, 18, 12.5, -0.42)) {
                color = ACCENT_LIGHT;
            }

            pixels[index] = color[0];
            pixels[index + 1] = color[1];
            pixels[index + 2] = color[2];
            pixels[index + 3] = 255;
        }
    }

    return downsample(pixels, dimension, SUPERSAMPLE);
}

function downsample(pixels, dimension, factor) {
    const outSize = dimension / factor;
    const out = Buffer.alloc(outSize * outSize * 4);

    for (let y = 0; y < outSize; y += 1) {
        for (let x = 0; x < outSize; x += 1) {
            let sumA = 0;
            let sumR = 0;
            let sumG = 0;
            let sumB = 0;

            for (let sy = 0; sy < factor; sy += 1) {
                for (let sx = 0; sx < factor; sx += 1) {
                    const index = ((y * factor + sy) * dimension + (x * factor + sx)) * 4;
                    const alpha = pixels[index + 3] / 255;
                    sumA += alpha;
                    sumR += pixels[index] * alpha;
                    sumG += pixels[index + 1] * alpha;
                    sumB += pixels[index + 2] * alpha;
                }
            }

            const outIndex = (y * outSize + x) * 4;
            if (sumA === 0) {
                out[outIndex + 3] = 0;
                continue;
            }
            out[outIndex] = Math.round(sumR / sumA);
            out[outIndex + 1] = Math.round(sumG / sumA);
            out[outIndex + 2] = Math.round(sumB / sumA);
            out[outIndex + 3] = Math.round((sumA / (factor * factor)) * 255);
        }
    }

    return out;
}

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let crc = -1;
    for (let i = 0; i < buffer.length; i += 1) {
        crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (stride + 1)] = 0; // filter none
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
    }

    const idat = zlib.deflateSync(raw, { level: 9 });

    return Buffer.concat([
        signature,
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const size of SIZES) {
    const rgba = render(size);
    const png = encodePng(size, size, rgba);
    const file = path.join(OUT_DIR, 'icon' + size + '.png');
    fs.writeFileSync(file, png);
    console.log('created', path.relative(path.join(__dirname, '..'), file), png.length + ' bytes');
}
