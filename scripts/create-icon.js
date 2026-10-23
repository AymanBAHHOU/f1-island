// Reproducible PNG app icon using only Node built-ins (no image-tool install).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function roundedRect(x, y, left, top, width, height, radius) {
  const dx = Math.max(left + radius - x, 0, x - (left + width - radius));
  const dy = Math.max(top + radius - y, 0, y - (top + height - radius));
  return x >= left && x <= left + width && y >= top && y <= top + height && dx * dx + dy * dy <= radius * radius;
}

// Rounded graphite tile, red island, white checkered flag. Draw at 1024px
// with 2x supersampling for smooth edges in Finder and the DMG installer.
function pixel(x, y) {
  if (!roundedRect(x, y, 80, 80, 864, 864, 194)) return [0, 0, 0, 0];
  const shade = Math.round(38 - y / 90);
  let color = [shade, shade, shade + 3, 255];
  if (roundedRect(x, y, 144, 300, 736, 424, 180)) color = [225, 6, 0, 255];
  if (roundedRect(x, y, 170, 326, 684, 372, 158)) color = [5, 5, 7, 255];
  if (x >= 364 && x < 388 && y >= 408 && y < 622) color = [245, 245, 247, 255];
  if (x >= 388 && x < 652 && y >= 408 && y < 552) {
    if ((Math.floor((x - 388) / 48) + Math.floor((y - 408) / 48)) % 2 === 0) color = [245, 245, 247, 255];
  }
  return color;
}

const size = 1024;
const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const samples = [pixel(x + 0.25, y + 0.25), pixel(x + 0.75, y + 0.25), pixel(x + 0.25, y + 0.75), pixel(x + 0.75, y + 0.75)];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    const alpha = samples.reduce((sum, p) => sum + p[3], 0);
    for (let c = 0; c < 3; c++) {
      raw[offset + c] = alpha ? Math.round(samples.reduce((sum, p) => sum + p[c] * p[3], 0) / alpha) : 0;
    }
    raw[offset + 3] = Math.round(alpha / 4);
  }
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const output = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, png);
console.log(`Created ${output}`);
