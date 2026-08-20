#!/usr/bin/env node
/**
 * Готовит фотографии к публикации: уменьшает и пересохраняет в WebP.
 *
 * Зачем: карточка портфолио показывается на экране максимум 337 px, первый
 * экран — 2001 px. Кадр с телефона приезжает 3024 px и весит 2 МБ. Разница
 * между «положил как есть» и «уменьшил до 800» — это 2 МБ против 80 КБ на
 * каждой карточке при одинаковой картинке на экране.
 *
 * Чем конвертирует: Chromium, который уже стоит в системе вместе с браузерным
 * инструментом gstack. Внутри у него libwebp — тот же кодировщик, что в cwebp.
 * Так скрипту не нужны ни sharp, ни ImageMagick, ни npm install: на машине,
 * где заработал браузерный инструмент, заработает и он.
 *
 * Что делает с метаданными: Chromium рисует картинку на canvas, а canvas несёт
 * только пиксели. EXIF, GPS и XMP не переживают конвертацию — это здесь не
 * побочный эффект, а цель. Цветовой профиль при этом не теряется: Chromium
 * приводит цвета к sRGB на этапе декодирования, то есть картинка остаётся
 * выглядеть так же, а не перекрашивается.
 *
 * Оригиналы не трогаются. Рядом с каждым появляется .webp, старый файл на
 * месте — сравнить и передумать можно в любой момент.
 *
 * Запуск:
 *   node tools/webp.mjs photo/makeup_and_hairstyles
 *   node tools/webp.mjs photo/header --width 2000
 *   node tools/webp.mjs photo/actresses --width 800 --quality 82 --out img/
 *
 * Умолчания — спека карточек портфолио: ширина 800, качество 80.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { extname, join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const SOURCE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function die(...lines) {
  console.error('');
  for (const line of lines) console.error(line);
  console.error('');
  process.exit(1);
}

// ── Аргументы ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { dir: null, width: 800, quality: 80, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--width') opts.width = Number(argv[++i]);
    else if (a === '--quality') opts.quality = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--')) die(red(`Неизвестный ключ: ${a}`));
    else if (opts.dir === null) opts.dir = a;
    else die(red('Папку можно указать только одну.'));
  }
  if (!opts.dir) {
    die(
      red('Не указана папка с фотографиями.'),
      '',
      'Пример:  node tools/webp.mjs photo/makeup_and_hairstyles',
    );
  }
  if (!Number.isFinite(opts.width) || opts.width < 1) die(red('--width должен быть числом больше нуля.'));
  if (!Number.isFinite(opts.quality) || opts.quality < 1 || opts.quality > 100) {
    die(red('--quality должен быть числом от 1 до 100.'));
  }
  return opts;
}

// ── Разбор JPEG: размеры и следы GPS ─────────────────────────────────────────

/** Размеры из маркера SOF. Нужны, чтобы не растянуть мелкий кадр вверх. */
function jpegSize(buf) {
  let o = 2;
  while (o + 9 < buf.length) {
    if (buf[o] !== 0xff) { o++; continue; }
    const marker = buf[o + 1];
    const len = buf.readUInt16BE(o + 2);
    // SOF0…SOF15, кроме DHT (c4), JPGA (c8) и DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
    }
    o += 2 + len;
  }
  return null;
}

/** Есть ли в EXIF блок GPS. Точные координаты не разбираем — важен сам факт. */
function hasGps(buf) {
  const at = buf.indexOf('Exif\0\0', 0, 'binary');
  if (at < 0) return false;
  const tiff = at + 6;
  if (tiff + 8 > buf.length) return false;
  const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > buf.length) return false;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > buf.length) break;
    if (u16(e) === 0x8825) return true; // указатель на GPS IFD
  }
  return false;
}

// ── Chromium ─────────────────────────────────────────────────────────────────

function findBrowse() {
  const candidates = [
    process.env.BROWSE_BIN,
    join(process.cwd(), '.claude/skills/gstack/browse/dist/browse.exe'),
    join(process.cwd(), '.claude/skills/gstack/browse/dist/browse'),
    join(homedir(), '.claude/skills/gstack/browse/dist/browse.exe'),
    join(homedir(), '.claude/skills/gstack/browse/dist/browse'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  die(
    red('Не найден браузерный инструмент gstack — конвертировать нечем.'),
    '',
    'Искал здесь:',
    ...candidates.map((c) => `  ${c}`),
    '',
    'Если он лежит в другом месте, укажите путь: BROWSE_BIN=/путь/к/browse',
  );
}

/**
 * Обязательно асинхронно: пока идёт вызов, наш же HTTP-сервер должен отвечать
 * браузеру. Синхронный execFileSync блокирует событийный цикл Node, сервер
 * молчит, и Chromium отваливается по таймауту на первой же навигации.
 */
function browse(bin, args) {
  return new Promise((done, fail) => {
    execFile(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = (stderr || stdout || err.message).split('\n')[0];
        fail(err);
      } else {
        done(stdout);
      }
    });
  });
}

/**
 * Страница-конвертер. Уменьшает ступенями по половине: за один проход
 * Chromium из 3024 px в 800 px даёт заметно более грязный край, чем в три
 * шага, а стоит это доли секунды.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>webp</title><script>
window.__convert = async function (name, width, quality) {
  const img = new Image();
  img.src = '/src/' + encodeURIComponent(name);
  await img.decode();

  const targetW = Math.min(width, img.naturalWidth);
  const targetH = Math.round(img.naturalHeight * targetW / img.naturalWidth);

  let source = img, curW = img.naturalWidth, curH = img.naturalHeight;
  while (curW / 2 > targetW) {
    curW = Math.round(curW / 2);
    curH = Math.round(curH / 2);
    const step = document.createElement('canvas');
    step.width = curW; step.height = curH;
    const sctx = step.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(source, 0, 0, curW, curH);
    source = step;
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetW; canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, targetW, targetH);

  window.__last = targetW + 'x' + targetH;
  return canvas.toDataURL('image/webp', quality);
};
</script>Конвертер работает. Страницу можно закрыть.`;

// ── Основной проход ──────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
const srcDir = resolve(opts.dir);
if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
  die(red(`Папка не найдена: ${opts.dir}`));
}

const outDir = opts.out ? resolve(opts.out) : srcDir;
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const files = readdirSync(srcDir)
  .filter((f) => SOURCE_TYPES[extname(f).toLowerCase()] && extname(f).toLowerCase() !== '.webp')
  .sort();

if (files.length === 0) {
  die(yellow(`В ${opts.dir} нет файлов jpg/jpeg/png — конвертировать нечего.`));
}

const bin = findBrowse();

const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (url.startsWith('/src/')) {
    const name = basename(url.slice(5));
    const path = join(srcDir, name);
    if (existsSync(path)) {
      res.writeHead(200, { 'content-type': SOURCE_TYPES[extname(name).toLowerCase()] || 'application/octet-stream' });
      res.end(readFileSync(path));
      return;
    }
  }
  res.writeHead(404);
  res.end();
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;

console.log('');
console.log(dim(`Конвертирую ${files.length} шт. — ширина ${opts.width} px, качество ${opts.quality}, WebP с потерями.`));
console.log('');

let ok = 0;
let srcTotal = 0;
let outTotal = 0;
const gpsDropped = [];
const failed = [];

try {
  await browse(bin, ['goto', `http://127.0.0.1:${port}/`]);

  for (const name of files) {
    const srcPath = join(srcDir, name);
    const buf = readFileSync(srcPath);
    const size = jpegSize(buf);
    const outName = basename(name, extname(name)) + '.webp';
    const outPath = join(outDir, outName);

    if (hasGps(buf)) gpsDropped.push(name);

    try {
      await browse(bin, [
        'js',
        `window.__convert(${JSON.stringify(name)}, ${opts.width}, ${opts.quality / 100})`,
        '--out',
        outPath,
      ]);
    } catch (e) {
      failed.push(`${name}: ${String(e.message).split('\n')[0]}`);
      continue;
    }

    if (!existsSync(outPath) || statSync(outPath).size === 0) {
      failed.push(`${name}: на выходе пустой файл`);
      continue;
    }

    const outSize = statSync(outPath).size;
    const dims = (await browse(bin, ['js', 'window.__last'])).trim();
    srcTotal += buf.length;
    outTotal += outSize;
    ok++;

    const was = size ? `${size.width}x${size.height}` : '?';
    const kb = (n) => String(Math.round(n / 1024)).padStart(5);
    const cut = Math.round((1 - outSize / buf.length) * 100);
    console.log(
      `  ${name.padEnd(12)} ${was.padStart(10)} ${kb(buf.length)} КБ` +
        dim('  →  ') +
        `${outName.padEnd(12)} ${dims.padStart(9)} ${kb(outSize)} КБ  ${green(`−${cut}%`)}`,
    );
  }
} finally {
  server.close();
}

console.log('');
if (ok > 0) {
  const cut = Math.round((1 - outTotal / srcTotal) * 100);
  console.log(
    green(`✓ Готово: ${ok} шт.  ${Math.round(srcTotal / 1024)} КБ → ${Math.round(outTotal / 1024)} КБ  (−${cut}%)`),
  );
}
if (gpsDropped.length) {
  console.log('');
  console.log(yellow(`  Координаты съёмки убраны из ${gpsDropped.length} шт.: ${gpsDropped.join(', ')}`));
  console.log(dim('  В оригиналах они остались — на сайт уезжают только .webp.'));
}
if (failed.length) {
  console.log('');
  console.log(red(`✗ Не получилось: ${failed.length} шт.`));
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
console.log('');
