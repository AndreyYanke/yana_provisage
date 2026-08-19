#!/usr/bin/env node
/**
 * Проверяет, что версия styles.css не разъехалась.
 *
 * Зачем: styles.css отдаётся с max-age=31536000, immutable, поэтому
 * вернувшийся посетитель не перезапросит его, пока не сменится адрес.
 * Ссылка в index.html несёт номер: href="styles.css?v=N". Поменять стили и
 * забыть поднять номер — значит показать людям новую разметку со старым CSS.
 *
 * Автоматической защиты нет и не будет, пока нет шага сборки: без него хэш
 * содержимого в имя файла не подставить. Этот скрипт защиту не заменяет —
 * он превращает молчаливую ошибку в громкую.
 *
 * Две проверки:
 *   1. Номер в index.html совпадает с номером в шапке styles.css. Всегда.
 *   2. Если styles.css менялся с базовой ревизии — номер обязан вырасти.
 *
 * Запуск локально:   node tools/check-css-version.mjs
 * С другой базой:    node tools/check-css-version.mjs origin/main
 * В CI база передаётся первым аргументом.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CSS = 'styles.css';
const HTML = 'index.html';

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/** Номер из ссылки: <link rel="stylesheet" href="styles.css?v=2"> */
function versionInHtml(text) {
  const m = text.match(/styles\.css\?v=(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Номер из шапки styles.css: «ВЕРСИЯ: 2» */
function versionInCss(text) {
  const m = text.match(/ВЕРСИЯ:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** Содержимое файла на указанной ревизии, либо null если файла там нет */
function fileAt(rev, path) {
  try {
    return git(['show', `${rev}:${path}`]);
  } catch {
    return null;
  }
}

function fail(lines) {
  console.error('');
  console.error(red('✗ Версия styles.css разъехалась'));
  console.error('');
  for (const l of lines) console.error('  ' + l);
  console.error('');
  console.error(dim('  Подробности: README, раздел «Кэширование».'));
  process.exit(1);
}

// ── 1. Согласованность между файлами — проверяется всегда ────────────────
const htmlNow = readFileSync(HTML, 'utf8');
const cssNow = readFileSync(CSS, 'utf8');

const vHtml = versionInHtml(htmlNow);
const vCss = versionInCss(cssNow);

if (vHtml === null) {
  fail([
    `В ${HTML} не найдена ссылка вида href="styles.css?v=N".`,
    'Без номера в адресе кэш на год превращается в ловушку:',
    'посетитель никогда не получит новые стили.',
  ]);
}

if (vCss === null) {
  fail([
    `В шапке ${CSS} не найдена строка «ВЕРСИЯ: N».`,
    'Номер нужен в обоих файлах, чтобы расхождение было видно глазами.',
  ]);
}

if (vHtml !== vCss) {
  fail([
    `${HTML} ссылается на v=${vHtml}, а в шапке ${CSS} стоит ВЕРСИЯ: ${vCss}.`,
    'Номера должны совпадать. Поднимите оба.',
  ]);
}

// ── 2. Рост номера при изменении стилей — если есть с чем сравнивать ─────
const base = process.argv[2] || 'HEAD~1';

let changed;
try {
  changed = git(['diff', '--name-only', base, 'HEAD']).split('\n').map((s) => s.trim());
} catch {
  console.log(dim(`  База «${base}» недоступна — сравнение пропущено.`));
  console.log(green(`✓ Версия согласована: v=${vHtml}`));
  process.exit(0);
}

if (!changed.includes(CSS)) {
  console.log(green(`✓ ${CSS} не менялся, версия согласована: v=${vHtml}`));
  process.exit(0);
}

const htmlBefore = fileAt(base, HTML);
if (htmlBefore === null) {
  console.log(dim(`  ${HTML} на ревизии ${base} отсутствует — сравнение пропущено.`));
  console.log(green(`✓ Версия согласована: v=${vHtml}`));
  process.exit(0);
}

const vBefore = versionInHtml(htmlBefore);

if (vBefore === null) {
  // На базовой ревизии номера ещё не было — версионирование только вводится,
  // сравнивать не с чем. Это не ошибка.
  console.log(green(`✓ ${CSS} изменился, версия проставлена впервые: v=${vHtml}`));
  process.exit(0);
}

if (vHtml <= vBefore) {
  fail([
    `${CSS} изменился, но номер версии не вырос: было v=${vBefore}, стало v=${vHtml}.`,
    '',
    'Что сделать:',
    `  1. поднять номер в ${HTML}:  href="styles.css?v=${vBefore + 1}"`,
    `  2. поднять его же в шапке ${CSS}:  ВЕРСИЯ: ${vBefore + 1}`,
    '',
    'Иначе вернувшиеся посетители увидят новую разметку со старыми стилями:',
    'файл кэшируется на год как immutable и повторно не запрашивается.',
  ]);
}

console.log(green(`✓ ${CSS} изменился, версия поднята: v=${vBefore} → v=${vHtml}`));
