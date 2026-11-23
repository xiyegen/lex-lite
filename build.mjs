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

/* ---------- 条文中の参照（第九十五条、前条、民法第七百九条 など）---------- */
const ARTS = new Map(); // 法令ID → 現行版の条の一覧 { order, set, ranges }
let TITLES = []; // [題名, 法令ID] を題名の長い順に
const LOCAL_ALIAS = { 会社法施行規則: { 法: '会社法' }, 会社計算規則: { 法: '会社法' } };
let ctx = null; // いま変換中の条の文脈。null のあいだは参照をリンクにしない（附則など）

const KN = '[〇一二三四五六七八九十百千]+';
const REF = new RegExp(`(第${KN}条(?:[のノ]${KN})*|前条|次条|同条|前[二三四五六七八九十]条)((?:第${KN}項)?(?:第${KN}号)?)`, 'g');
// 2つの参照のあいだがこれだけなら、同じ法令の条が続いているとみなす（「第九十二条第九項及び第十項、第九十四条」）
const CONNECT = new RegExp(`^(?:まで|、|，|及び|又は|並びに|若しくは|から|第${KN}[項号編章節款目]|ただし書|本文|前段|後段|各号|[イロハニホヘトチリヌ])+$`);
// 法令名らしい語の終わり（「同法」が何を指すかを探すのに使う）
const NAMEPOS = /(?<!方)(?:法律|法|規則|令)(?=(?:（[^（）]*）)?(?:第|の規定|中|又は|及び|並びに|、|に規定|による|その他|（))/g;
const SELF = /(この法律|この法|本法|この規則|この省令|この政令)$/;
const SAME = /同(法|法律|令|規則|省令|政令)$/;
const NAMEEND = /(法|法律|令|規則|条約|規程|憲章|議定書|条例|定款|規約|附則|別表)$/;
const CJK = /[一-鿿゠-ヿ々]/;

function kan(s) {
  let n = 0;
  let c = 0;
  for (const ch of s) {
    const d = '〇一二三四五六七八九'.indexOf(ch);
    if (d >= 0) c = c * 10 + d;
    else {
      n += (c || 1) * { 十: 10, 百: 100, 千: 1000 }[ch];
      c = 0;
    }
  }
  return n + c;
}
// "第三百九十八条の二" → "398_2"
const keyOf = (t) => t.slice(1).split(/条[のノ]?|[のノ]/).filter(Boolean).map(kan).join('_');

function collectArts(raw) {
  const order = [];
  const visit = (n) => {
    for (const c of kids(n)) {
      if (typeof c === 'string') continue;
      if (c.tag === 'Article') {
        if (c.attr && c.attr.Num) order.push(c.attr.Num);
      } else visit(c);
    }
  };
  const body = kids(raw.law_full_text).find((c) => c.tag === 'LawBody');
  visit(kids(body).find((c) => c.tag === 'MainProvision'));
  const ranges = order.filter((k) => k.includes(':')).map((k) => [...k.split(':').map((x) => parseInt(x, 10)), k]);
  return { order, set: new Set(order), ranges };
}
// 実在する条なら、その Num を返す（削除された範囲に入る番号は範囲の Num）
function exists(arts, key) {
  if (!arts) return null;
  if (arts.set.has(key)) return key;
  if (key.includes('_')) return null;
  const v = parseInt(key, 10);
  const r = arts.ranges.find(([a, b]) => a <= v && v <= b);
  return r ? r[2] : null;
}

// 文字列の末尾が収録法令の題名なら法令ID。別の名前の一部（「旧民法」「日本郵政株式会社法」）なら null。題名でなければ undefined。
function titleAt(p) {
  for (const [t, id] of [...ctx.alias, ...TITLES]) {
    if (!p.endsWith(t)) continue;
    const before = p[p.length - t.length - 1];
    return before && CJK.test(before) ? null : id;
  }
  return NAMEEND.test(p) ? null : undefined;
}

// 直前の文字列から、どの法令の条かを決める。戻り値: 法令ID / null（リンクにしない）
function lawBefore(prefix) {
  let p = prefix;
  if (p.endsWith('）')) {
    // 「民法（明治二十九年法律第八十九号）第七百九条」の括弧を読み飛ばす
    let d = 0;
    let i = p.length - 1;
    for (; i >= 0; i--) {
      if (p[i] === '）') d++;
      else if (p[i] === '（' && --d === 0) break;
    }
    if (i > 0) p = p.slice(0, i);
  }
  if (SELF.test(p)) return ctx.lawId;
  if (SAME.test(p)) {
    // 直近に出てきた法令名を探す。条番号を伴わない言及（「民事訴訟法第一編から…」）も拾う。
    const hits = [...p.replace(SAME, '').matchAll(NAMEPOS)];
    if (hits.length) {
      const h = hits[hits.length - 1];
      ctx.named = titleAt(p.slice(0, h.index + h[0].length));
    }
    return ctx.named || null;
  }
  const t = titleAt(p);
  if (t !== undefined) {
    ctx.named = t;
    return t;
  }
  return ctx.lawId;
}

function findRefs(s) {
  const out = [];
  let prevEnd = -1;
  let prevLaw = null;
  for (const m of s.matchAll(REF)) {
    const start = m.index;
    const end = start + m[0].length;
    const head = m[1];
    let attr = null;
    let law = ctx.lawId;
    if (head === '同条') attr = ctx.last;
    else if (head[0] === '第') {
      law = prevEnd >= 0 && CONNECT.test(s.slice(prevEnd, start)) ? prevLaw : lawBefore(s.slice(0, start));
      const key = law && exists(law === ctx.lawId ? ctx.own : ARTS.get(law), keyOf(head));
      if (key) attr = law === ctx.lawId ? key : `${law}:${key}`;
    } else if (ctx.idx >= 0) {
      // 前条・次条・前二条
      const n = head === '次条' ? -1 : head === '前条' ? 1 : kan(head.slice(1, -1));
      const ks = n < 0 ? [ctx.own.order[ctx.idx + 1]] : ctx.own.order.slice(Math.max(0, ctx.idx - n), ctx.idx);
      if (ks.length && ks.every(Boolean)) attr = ks.join(',');
    }
    ctx.last = attr;
    prevEnd = end;
    prevLaw = law;
    if (attr) out.push({ start, end, attr });
  }
  return out;
}

// 本文の文字列を HTML にする。括弧書きは <span class="pr">、条への参照は <a data-r> で包む。
function txt(s, paren) {
  if (!paren) return esc(s);
  const refs = ctx ? findRefs(s) : [];
  let d = 0;
  let bal = /（/.test(s);
  for (const ch of s) {
    if (ch === '（') d++;
    else if (ch === '）' && --d < 0) break;
  }
  if (d !== 0) bal = false;
  if (!refs.length && !bal) return esc(s);
  let out = '';
  let ri = 0;
  for (let i = 0; i < s.length; i++) {
    if (ri < refs.length && refs[ri].start === i) out += `<a data-r="${refs[ri].attr}">`;
    const ch = s[i];
    if (bal && ch === '（') out += '<span class="pr">（';
    else if (bal && ch === '）') out += '）</span>';
    else out += esc(ch);
    if (ri < refs.length && refs[ri].end === i + 1) {
      out += '</a>';
      ri++;
    }
  }
  return out;
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
  if (ctx) {
    ctx.idx = ctx.own.order.indexOf((a.attr && a.attr.Num) || '');
    ctx.last = null;
    ctx.named = null;
  }
  let cap = '';
  let capText = '';
  let title = '';
  let html = '';
  let first = true;
  for (const c of kids(a)) {
    if (typeof c === 'string') continue;
    if (c.tag === 'ArticleCaption') {
      capText = plain(c);
      // 見出しが条名のあとに置かれている法令（裁判所法など）は、元の並びどおり条名の直後に出す
      if (title) title += `</b>${inline(c)}<b>`;
      else cap = `<div class="cap">${inline(c)}</div>`;
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

function convert(raw, title) {
  const own = collectArts(raw);
  const alias = Object.entries(LOCAL_ALIAS[title] || {}).map(([k, v]) => [k, (TITLES.find(([t]) => t === v) || [])[1]]).filter(([, id]) => id);
  const main = () => ({ lawId: raw.law_info.law_id, own, alias, idx: -1, last: null, named: null });
  ctx = null;
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
        ctx = main();
        walk(c, nodes, false);
        ctx = null;
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

/* ---------- 検証: e-Gov の元データの文字列と、アプリが表示する文字列が一致するか ---------- */
// 元データ側: 収録対象（制定文・前文・本則・制定時の附則）の文字を、文書の順にすべてつなぐ。ルビの読みと図は除く。
function sourceText(raw) {
  const body = kids(raw.law_full_text).find((c) => c.tag === 'LawBody');
  let out = '';
  const visit = (n) => {
    if (typeof n === 'string') return (out += n);
    if (n.tag === 'Rt' || n.tag === 'Fig') return;
    kids(n).forEach(visit);
  };
  for (const c of kids(body)) {
    if (typeof c === 'string') continue;
    if (['EnactStatement', 'Preamble', 'MainProvision'].includes(c.tag)) visit(c);
    else if (c.tag === 'SupplProvision' && !(c.attr && c.attr.AmendLawNum)) visit(c);
  }
  return out;
}
// 表示側: 生成した HTML からタグを外した文字
function shownText(nodes) {
  return nodes
    .map((nd) => (nd[0] === 'h' ? nd[2] : nd[0] === 'a' ? nd[2] : nd[1]))
    .join('')
    .replace(/<rt>.*?<\/rt>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/（図は省略）/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
// 空白の違い（項番号のあとの全角空白など）は無視して比べる。食い違いがあれば、その場所を返す。
function verify(raw, nodes) {
  const norm = (t) => t.replace(/[\s\u3000]/g, '');
  const a = norm(sourceText(raw));
  const b = norm(shownText(nodes));
  if (a === b) return null;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `${i}文字目から不一致（元 ${a.length}字 / 表示 ${b.length}字）\n    元データ: …${a.slice(Math.max(0, i - 25), i)}【${a.slice(i, i + 40)}】\n    表示    : …${b.slice(Math.max(0, i - 25), i)}【${b.slice(i, i + 40)}】`;
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
  // cache: 'reload' でブラウザの HTTP キャッシュを通さずに取る（古いファイルを新しい版として保存しないため）
  e.waitUntil(caches.open(V).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
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
  const failures = [];
  let checked = 0;
  let changed = false;
  // 1周目: 現行版を全部取得し、法令間の参照を解決するための題名と条の一覧を集める
  const raws = new Map();
  for (const g of config) {
    for (const title of g.laws) {
      const raw = await fetchCurrent(title);
      if (!raw) {
        missing.push(title);
        continue;
      }
      raws.set(title, raw);
      ARTS.set(raw.law_info.law_id, collectArts(raw));
      TITLES.push([title, raw.law_info.law_id]);
      if (title === '日本国憲法') TITLES.push(['憲法', raw.law_info.law_id]);
    }
  }
  TITLES.sort((a, b) => b[0].length - a[0].length);

  for (const g of config) {
    const laws = [];
    for (const title of g.laws) {
      const raw = raws.get(title);
      if (!raw) continue;
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
        const nodes = convert(r, title);
        const bad = verify(r, nodes);
        if (bad) failures.push(`${title}（${v.enforced} 施行）: ${bad}`);
        checked++;
        const json = JSON.stringify({ id, title, num: r.law_info.law_num, rev: v.rev, enforced: v.enforced, nodes });
        await fs.writeFile(file, json);
        console.log(`${title}  ${v.enforced} 施行  ${nodes.filter((n) => n[0] === 'a').length}条  ${(json.length / 1024).toFixed(0)}KB`);
      }
      laws.push({ id, title, num: raw.law_info.law_num, versions });
    }
    groups.push({ name: g.group, laws });
  }
  // 条文の文字が元データと食い違う版が1つでもあれば、公開せずに止める
  if (failures.length) {
    console.error(`\n検証に失敗: ${failures.length} / ${checked} 版\n` + failures.map((f) => '  ' + f).join('\n'));
    process.exit(1);
  }
  console.log(`\n検証 OK: ${checked} 版すべて、元データと表示の文字が一致`);
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
    if (!(await fs.stat(p)).isFile() || f === 'sw.js' || f === 'version.js' || path.basename(f).startsWith('.')) continue;
    hash.update(f).update(await fs.readFile(p));
    files.push('./' + f.split(path.sep).join('/'));
  }
  const version = hash.digest('hex').slice(0, 10);
  // 画面側が「いま動いているコードの版」を表示するためのファイル
  await fs.writeFile(path.join(SITE, 'version.js'), `window.APP_V = '${version}';\n`);
  await fs.writeFile(path.join(SITE, 'sw.js'), SW(version, ['./', './version.js', ...files]));
  console.log(`\n${files.length} ファイル / version ${version}`);
  if (missing.length) console.log('見つからなかった法令: ' + missing.join('、'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
