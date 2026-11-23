#!/usr/bin/env node
// e-Gov 法令 API v2 から法令を取得し、site/data/ にアプリ用の JSON を書き出す。
//   node build.mjs            キャッシュ(.cache/)があれば再利用
//   node build.mjs --refresh  現行版をすべて取り直す（新しい版が出ていれば旧版を残して追加）
//   node build.mjs --regen    旧版のファイルも e-Gov から取り直して作り直す
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(ROOT, 'site');
const DATA = path.join(SITE, 'data');
const CACHE = path.join(ROOT, '.cache');
const API = 'https://laws.e-gov.go.jp/api/2';
const REFRESH = process.argv.includes('--refresh');
const REGEN = process.argv.includes('--regen');

const HEAD = { Part: 1, Chapter: 2, Section: 3, Subsection: 4, Division: 5 };

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// 括弧書きを <span class="pr"> で包む（入れ子対応）。対応が取れない文字列はそのまま返す。
function txt(s, paren) {
  if (!paren || !/[（(]/.test(s)) return esc(s);
  let out = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '（') {
      depth++;
      out += '<span class="pr">（';
    } else if (ch === '）') {
      if (depth === 0) return esc(s);
      depth--;
      out += '）</span>';
    } else out += esc(ch);
  }
  return depth === 0 ? out : esc(s);
}

const kids = (n) => (n && n.children) || [];

function plain(n) {
  if (typeof n === 'string') return n;
  if (n.tag === 'Rt') return '';
  return kids(n).map(plain).join('');
}

function inline(n, paren) {
  if (typeof n === 'string') return txt(n, paren);
  const inner = () => kids(n).map((c) => inline(c, paren)).join('');
  switch (n.tag) {
    case 'Ruby': {
      const base = kids(n).filter((c) => c.tag !== 'Rt').map((c) => inline(c, paren)).join('');
      const rt = kids(n).filter((c) => c.tag === 'Rt').map(plain).join('');
      return `<ruby>${base}<rt>${esc(rt)}</rt></ruby>`;
    }
    case 'Rt':
      return '';
    case 'Sup':
      return `<sup>${inner()}</sup>`;
    case 'Sub':
      return `<sub>${inner()}</sub>`;
    case 'Line':
      return `<u>${inner()}</u>`;
    default:
      return inner();
  }
}

// ParagraphSentence / ItemSentence 等の中身。Column は全角空白でつなぐ。
function sentence(n) {
  const cs = kids(n);
  const hasCol = cs.some((c) => c.tag === 'Column');
  return cs.map((c) => inline(c, true)).join(hasCol ? '　' : '');
}

const UNIT = /^(Paragraph|Item|Subitem\d+)$/;
const depthOf = (tag) => (tag === 'Paragraph' ? 0 : tag === 'Item' ? 1 : 1 + Number(tag.slice(7)));

// 項・号・号の細分を 1 ブロックに描く。lead は第1項に付ける条名。
function unit(n, lead) {
  let title = '';
  let sent = '';
  let cap = '';
  let rest = '';
  for (const c of kids(n)) {
    if (typeof c === 'string') continue;
    if (c.tag === 'ParagraphCaption') cap = `<div class="cap">${inline(c)}</div>`;
    else if (c.tag === 'ParagraphNum' || c.tag === n.tag + 'Title') title = inline(c);
    else if (c.tag === n.tag + 'Sentence') sent = sentence(c);
    else rest += block(c);
  }
  const head = lead || (title ? `<span class="n">${title}</span>` : '');
  const d = depthOf(n.tag);
  const body = head ? `${head}　${sent}` : sent;
  return `${cap}<div class="u d${d}${head ? '' : ' nh'}">${body}</div>${rest}`;
}

function block(n) {
  if (typeof n === 'string') return n.trim() ? `<div class="s">${txt(n, true)}</div>` : '';
  const t = n.tag;
  if (UNIT.test(t)) return unit(n);
  if (t === 'Sentence' || t === 'Column') return `<div class="s">${inline(n, true)}</div>`;
  if (t === 'Table') return `<div class="tw"><table>${kids(n).map(block).join('')}</table></div>`;
  if (t === 'TableRow' || t === 'TableHeaderRow') return `<tr>${kids(n).map(block).join('')}</tr>`;
  if (t === 'TableColumn' || t === 'TableHeaderColumn') {
    const a = n.attr || {};
    const span = (a.rowspan ? ` rowspan="${Number(a.rowspan)}"` : '') + (a.colspan ? ` colspan="${Number(a.colspan)}"` : '');
    const el = t === 'TableColumn' ? 'td' : 'th';
    return `<${el}${span}>${kids(n).map(block).join('')}</${el}>`;
  }
  if (/(Caption|Title|Label)$/.test(t)) return `<div class="cap">${inline(n)}</div>`;
  if (t === 'Fig' || t === 'FigStruct') return '<div class="s">（図は省略）</div>';
  return kids(n).map(block).join('');
}

function article(a) {
  let cap = '';
  let capText = '';
  let title = '';
  let html = '';
  let first = true;
  for (const c of kids(a)) {
    if (typeof c === 'string') continue;
    if (c.tag === 'ArticleCaption') {
      cap = `<div class="cap">${inline(c)}</div>`;
      capText = plain(c);
    } else if (c.tag === 'ArticleTitle') title = inline(c);
    else if (c.tag === 'Paragraph') {
      html += unit(c, first ? `<b class="at">${title}</b>` : '');
      first = false;
    } else html += block(c);
  }
  if (first && title) html = `<div class="u d0"><b class="at">${title}</b></div>` + html;
  return { n: (a.attr && a.attr.Num) || '', html: cap + html, cap: capText };
}

function walk(node, out, suppl) {
  for (const c of kids(node)) {
    if (typeof c === 'string') continue;
    if (HEAD[c.tag]) {
      const t = kids(c).find((x) => x.tag === c.tag + 'Title');
      out.push(['h', HEAD[c.tag], t ? plain(t) : '']);
      walk(c, out, suppl);
    } else if (c.tag === 'Article') {
      const a = article(c);
      out.push(suppl || !a.n ? ['x', a.html] : ['a', a.n, a.html, a.cap]);
    } else if (/Title$|Label$/.test(c.tag)) continue;
    else {
      const h = block(c);
      if (h) out.push(['x', h]);
    }
  }
}

function convert(raw) {
  const body = kids(raw.law_full_text).find((c) => c.tag === 'LawBody');
  const nodes = [];
  for (const c of kids(body)) {
    if (typeof c === 'string') continue;
    switch (c.tag) {
      case 'EnactStatement':
        nodes.push(['x', `<div class="u nh">${inline(c)}</div>`]);
        break;
      case 'Preamble':
        nodes.push(['x', block(c)]);
        break;
      case 'MainProvision':
        walk(c, nodes, false);
        break;
      case 'SupplProvision': {
        if (c.attr && c.attr.AmendLawNum) break; // 改正法の附則は載せない
        const l = kids(c).find((x) => x.tag === 'SupplProvisionLabel');
        nodes.push(['h', 1, l ? plain(l).replace(/\s+/g, '') : '附則']);
        walk(c, nodes, true);
        break;
      }
      default: // LawTitle, TOC, 別表など
    }
  }
  return nodes;
}

async function getJson(url) {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (i >= 3) throw new Error(`${r.status} ${url}`);
    await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
  }
}

async function resolveId(title) {
  const j = await getJson(`${API}/laws?law_title=${encodeURIComponent(title)}&limit=100`);
  const live = (j.laws || []).filter((l) => (l.revision_info.repeal_status || 'None') === 'None');
  const name = (l) => (l.current_revision_info || l.revision_info).law_title;
  // 完全一致を優先。なければ「明治○年法律第○号（題名）」形式の件名を拾う。
  let hits = live.filter((l) => name(l) === title);
  if (!hits.length) hits = live.filter((l) => name(l).endsWith(`（${title}）`));
  if (!hits.length) return null;
  const rank = (l) => ['Constitution', 'Act'].indexOf(l.law_info.law_type);
  hits.sort((a, b) => rank(b) - rank(a));
  return hits[0].law_info.law_id;
}

async function cached(key, fn, fresh) {
  const file = path.join(CACHE, key + '.json');
  if (!fresh) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {}
  }
  const v = await fn();
  if (v) await fs.writeFile(file, JSON.stringify(v));
  return v;
}

// いま施行されている版
function fetchCurrent(title) {
  const key = 'cur-' + crypto.createHash('sha1').update(title).digest('hex').slice(0, 12);
  return cached(
    key,
    async () => {
      const id = await resolveId(title);
      return id ? getJson(`${API}/law_data/${id}?law_full_text_format=json`) : null;
    },
    REFRESH,
  );
}

// 過去の版（law_revision_id 指定）。中身は変わらないのでキャッシュを常に使う。
function fetchRevision(rev) {
  return cached('rev-' + rev, () => getJson(`${API}/law_data/${rev}?law_full_text_format=json`), false);
}

const SW = (version, files) => `// build.mjs が生成する。直接編集しない。
const V = 'roppo-${version}';
const FILES = ${JSON.stringify(files)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('roppo-') && k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    caches.open(V).then(async (c) => {
      const hit = await c.match(e.request.mode === 'navigate' ? './index.html' : e.request, { ignoreSearch: true });
      return hit || fetch(e.request);
    }),
  );
});
`;

async function main() {
  await fs.mkdir(DATA, { recursive: true });
  await fs.mkdir(CACHE, { recursive: true });
  const config = JSON.parse(await fs.readFile(path.join(ROOT, 'laws.config.json'), 'utf8'));

  // 前回の index.json から各法令の版の一覧を引き継ぐ。新しい版が出たら先頭に足し、古い版は残す。
  const prev = new Map();
  let built = null;
  try {
    const p = JSON.parse(await fs.readFile(path.join(DATA, 'index.json'), 'utf8'));
    built = p.built;
    for (const g of p.groups) for (const l of g.laws) if (l.versions) prev.set(l.id, l);
  } catch {}

  const groups = [];
  const missing = [];
  const keep = new Set(['index.json']);
  let changed = false;
  for (const g of config) {
    const laws = [];
    for (const title of g.laws) {
      const raw = await fetchCurrent(title);
      if (!raw) {
        missing.push(title);
        continue;
      }
      const id = raw.law_info.law_id;
      const rev = raw.revision_info.law_revision_id;
      const versions = [...((prev.get(id) || {}).versions || [])];
      if (!versions.some((v) => v.rev === rev)) {
        versions.push({ rev, enforced: raw.revision_info.amendment_enforcement_date || '' });
        changed = true;
        if (prev.has(id)) console.log(`★ 新しい版: ${title} ${rev}`);
      }
      versions.sort((a, b) => (a.enforced < b.enforced ? 1 : -1));
      for (const v of versions) {
        const file = path.join(DATA, v.rev + '.json');
        keep.add(v.rev + '.json');
        const exists = await fs.stat(file).then(() => true, () => false);
        if (exists && v.rev !== rev && !REGEN) continue; // 旧版は生成済みのファイルを使い回す
        const r = v.rev === rev ? raw : await fetchRevision(v.rev);
        const nodes = convert(r);
        const json = JSON.stringify({ id, title, num: r.law_info.law_num, rev: v.rev, enforced: v.enforced, nodes });
        await fs.writeFile(file, json);
        console.log(`${title}  ${v.enforced} 施行  ${nodes.filter((n) => n[0] === 'a').length}条  ${(json.length / 1024).toFixed(0)}KB`);
      }
      laws.push({ id, title, num: raw.law_info.law_num, versions });
    }
    groups.push({ name: g.group, laws });
  }
  if (prev.size !== groups.reduce((n, g) => n + g.laws.length, 0)) changed = true;
  for (const f of await fs.readdir(DATA)) if (!keep.has(f)) await fs.unlink(path.join(DATA, f));
  // built はデータの中身が変わった日。変化がなければ据え置く（毎回の再ダウンロードを避ける）。
  if (changed || !built) built = new Date().toISOString().slice(0, 10);
  await fs.writeFile(path.join(DATA, 'index.json'), JSON.stringify({ built, groups }));

  // Service Worker: site/ 配下の全ファイルをプリキャッシュする
  const files = [];
  const hash = crypto.createHash('sha1');
  for (const f of (await fs.readdir(SITE, { recursive: true })).sort()) {
    const p = path.join(SITE, f);
    if (!(await fs.stat(p)).isFile() || f === 'sw.js' || path.basename(f).startsWith('.')) continue;
    hash.update(f).update(await fs.readFile(p));
    files.push('./' + f.split(path.sep).join('/'));
  }
  const version = hash.digest('hex').slice(0, 10);
  await fs.writeFile(path.join(SITE, 'sw.js'), SW(version, ['./', ...files]));
  console.log(`\n${files.length} ファイル / version ${version}`);
  if (missing.length) console.log('見つからなかった法令: ' + missing.join('、'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
