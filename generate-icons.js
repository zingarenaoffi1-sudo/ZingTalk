const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (-(crc & 1) & 0xEDB88320);
    }
  }
  return (crc ^ -1) >>> 0;
}

function makePng(width, height, pixelFn) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0; // Filter None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const pxOffset = rowOffset + 1 + x * 4;
      raw[pxOffset] = r;
      raw[pxOffset + 1] = g;
      raw[pxOffset + 2] = b;
      raw[pxOffset + 3] = a;
    }
  }

  const deflated = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const toCrc = Buffer.concat([typeBuf, data]);
    const crcVal = crc32(toCrc);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal, 0);
    return Buffer.concat([lenBuf, toCrc, crcBuf]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', deflated);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

// Draw modern ZingTalk Logo: Electric 'Z' + Speech bubble
function renderZingTalkIcon(x, y, width, height, isRound = false) {
  const nx = x / width;
  const ny = y / height;
  const cx = 0.5;
  const cy = 0.5;
  const dx = nx - cx;
  const dy = ny - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Background clipping (squircle vs round)
  let inBg = false;
  if (isRound) {
    inBg = dist <= 0.48;
  } else {
    // Smooth rounded rect (squircle)
    const p = 4;
    const squircle = Math.pow(Math.abs(dx) / 0.44, p) + Math.pow(Math.abs(dy) / 0.44, p);
    inBg = squircle <= 1.0;
  }

  if (!inBg) {
    return [0, 0, 0, 0]; // Transparent
  }

  // Background gradient: Emerald Green (#00A884) to Electric Teal/Cyan (#0284C7)
  const gradT = (nx + ny) * 0.5;
  let bgR = Math.round(0 * (1 - gradT) + 6 * gradT);
  let bgG = Math.round(168 * (1 - gradT) + 182 * gradT);
  let bgB = Math.round(132 * (1 - gradT) + 212 * gradT);

  // Subtle circular inner glow
  const innerGlow = Math.max(0, 1 - dist / 0.5);
  bgR = Math.min(255, bgR + Math.round(innerGlow * 15));
  bgG = Math.min(255, bgG + Math.round(innerGlow * 20));
  bgB = Math.min(255, bgB + Math.round(innerGlow * 25));

  // Speech bubble body centered at (0.5, 0.48), radius ~ 0.32
  const bubbleDist = Math.sqrt((nx - 0.5) ** 2 + (ny - 0.47) ** 2);
  const inBubble = bubbleDist <= 0.30;
  
  // Speech bubble pointer tail at bottom-left (nx ~ 0.28, ny ~ 0.72)
  const inTail = (nx >= 0.22 && nx <= 0.38 && ny >= 0.60 && ny <= 0.76 && (nx - 0.22) * 1.4 >= (ny - 0.60));

  // Distinct Electric 'Z' Glyph Coordinates
  // Z top bar: y from 0.32 to 0.40, x from 0.34 to 0.66
  // Z diagonal: from (0.64, 0.40) to (0.36, 0.58), thickness ~ 0.08
  // Z bottom bar: y from 0.58 to 0.66, x from 0.34 to 0.66
  const inZTop = (ny >= 0.33 && ny <= 0.40 && nx >= 0.33 && nx <= 0.67);
  const inZBottom = (ny >= 0.57 && ny <= 0.64 && nx >= 0.33 && nx <= 0.67);

  // Diagonal calculation: distance to line from (0.65, 0.38) to (0.35, 0.59)
  const x1 = 0.65, y1 = 0.38, x2 = 0.35, y2 = 0.59;
  const lineLen = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  const proj = ((nx - x1) * (x2 - x1) + (ny - y1) * (y2 - y1)) / (lineLen ** 2);
  let distToDiag = 999;
  if (proj >= -0.05 && proj <= 1.05) {
    const px = x1 + proj * (x2 - x1);
    const py = y1 + proj * (y2 - y1);
    distToDiag = Math.sqrt((nx - px) ** 2 + (ny - py) ** 2);
  }
  const inZDiag = (distToDiag <= 0.052 && ny >= 0.37 && ny <= 0.60);

  // Electric spark dot / accent at top right of Z
  const sparkDist = Math.sqrt((nx - 0.66) ** 2 + (ny - 0.32) ** 2);
  const inSpark = sparkDist <= 0.045;

  const inZ = inZTop || inZBottom || inZDiag || inSpark;

  if (inZ) {
    // Pure bright white electric glyph with slight gold/cyan edge
    return [255, 255, 255, 255];
  }

  // Inside bubble background (darker semi-translucent teal for depth)
  if (inBubble || inTail) {
    const tintR = Math.round(bgR * 0.72);
    const tintG = Math.round(bgG * 0.75);
    const tintB = Math.round(bgB * 0.85);
    return [tintR, tintG, tintB, 255];
  }

  return [bgR, bgG, bgB, 255];
}

// Ensure directories
const assetsDir = path.join(__dirname, 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

const distAssetsDir = path.join(__dirname, 'dist', 'assets');
if (!fs.existsSync(distAssetsDir)) fs.mkdirSync(distAssetsDir, { recursive: true });

console.log('[generate-icons] Generating master icons...');

// Master App Icons
const master512 = makePng(512, 512, (x, y, w, h) => renderZingTalkIcon(x, y, w, h, false));
fs.writeFileSync(path.join(assetsDir, 'icon.png'), master512);
fs.writeFileSync(path.join(distAssetsDir, 'icon.png'), master512);

const round512 = makePng(512, 512, (x, y, w, h) => renderZingTalkIcon(x, y, w, h, true));
fs.writeFileSync(path.join(assetsDir, 'icon-round.png'), round512);
fs.writeFileSync(path.join(distAssetsDir, 'icon-round.png'), round512);

const favicon64 = makePng(64, 64, (x, y, w, h) => renderZingTalkIcon(x, y, w, h, false));
fs.writeFileSync(path.join(assetsDir, 'favicon.png'), favicon64);
fs.writeFileSync(path.join(distAssetsDir, 'favicon.png'), favicon64);

// Android Launcher Mipmap sets
const densities = [
  { name: 'mipmap-mdpi', size: 48 },
  { name: 'mipmap-hdpi', size: 72 },
  { name: 'mipmap-xhdpi', size: 96 },
  { name: 'mipmap-xxhdpi', size: 144 },
  { name: 'mipmap-xxxhdpi', size: 192 }
];

densities.forEach(d => {
  const dir = path.join(assetsDir, d.name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const squareIcon = makePng(d.size, d.size, (x, y, w, h) => renderZingTalkIcon(x, y, w, h, false));
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), squareIcon);
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), squareIcon);

  const roundIcon = makePng(d.size, d.size, (x, y, w, h) => renderZingTalkIcon(x, y, w, h, true));
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), roundIcon);

  console.log(`[generate-icons] Generated ${d.name} (${d.size}x${d.size})`);
});

console.log('[generate-icons] All ZingTalk icons generated successfully!');
