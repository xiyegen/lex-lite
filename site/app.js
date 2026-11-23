'use strict';
const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('roppo.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('roppo.' + k, JSON.stringify(v));
    } catch {}
  },
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// "398_2" → "第398条の2"、"38:84" → "第38条〜第84条"
const one = (n) => {
  const [a, ...r] = n.split('_');
  return `第${a}条${r.map((x) => 'の' + x).join('')}`;
};
const label = (n) => n.split(':').map(one).join('〜');
// "2026-06-24" → "2026.6.24"
const ymd = (d) => (d ? d.split('-').map(Number).join('.') : '');

let index = null;
const laws = new Map();
let cur = null; // 表示中の法令
let curN = null; // 画面上端にある条
let back = [];
let fwd = [];
const stacks = new Map(); // 法令ごとの「戻る／進む」
const metaOf = (id) => index.groups.flatMap((g) => g.laws).find((l) => l.id === id);

/* ---------- 設定 ---------- */
const prefs = Object.assign({ fs: 17, font: 'gothic', dim: '0' }, store.get('prefs', {}));
function applyPrefs() {
  document.documentElement.style.setProperty('--fs', prefs.fs + 'px');
  document.body.dataset.font = prefs.font;
  document.body.dataset.dim = prefs.dim;
  $('#fs-val').textContent = prefs.fs;
  document.querySelectorAll('[data-font]').forEach((b) => b.classList.toggle('on', b.dataset.font === prefs.font));
  document.querySelectorAll('[data-dim]').forEach((b) => b.classList.toggle('on', b.dataset.dim === prefs.dim));
  store.set('prefs', prefs);
}
// 文字サイズ等を変えても読んでいた条がずれないようにする
function keepPlace(fn) {
  const n = curN;
  const locked = lockY !== null;
  unlock();
  fn();
  applyPrefs();
  if (cur && n) scrollToArt(n, false);
  if (locked) lock();
}
$('#fs-dn').onclick = () => keepPlace(() => (prefs.fs = Math.max(13, prefs.fs - 1)));
$('#fs-up').onclick = () => keepPlace(() => (prefs.fs = Math.min(26, prefs.fs + 1)));
document.querySelectorAll('[data-font]').forEach((b) => (b.onclick = () => keepPlace(() => (prefs.font = b.dataset.font))));
document.querySelectorAll('[data-dim]').forEach((b) => (b.onclick = () => keepPlace(() => (prefs.dim = b.dataset.dim))));

/* ---------- シート ---------- */
let openSheet = null;
// シートを開いているあいだ、裏の本文がスクロールしないよう body を固定する
let lockY = null;
function lock() {
  if (lockY !== null) return;
  lockY = scrollY;
  Object.assign(document.body.style, { position: 'fixed', top: -lockY + 'px', left: 0, right: 0 });
}
function unlock() {
  if (lockY === null) return;
  Object.assign(document.body.style, { position: '', top: '', left: '', right: '' });
  scrollTo(0, lockY);
  lockY = null;
}
function sheet(id) {
  if (openSheet) {
    openSheet.hidden = true;
    openSheet.style.transform = openSheet.style.transition = '';
  }
  openSheet = id ? $(id) : null;
  $('#scrim').hidden = !openSheet;
  if (openSheet) {
    openSheet.hidden = false;
    lock();
  } else unlock();
}

// 下スワイプで閉じる。中身をスクロールできるときは、いちばん上まで戻っている場合だけ引っ張れる。
document.querySelectorAll('.sheet').forEach((el) => {
  let y0 = null;
  let dy = 0;
  let scroller = null;
  el.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1 || e.target.closest('#pad, input')) return (y0 = null);
      scroller = e.target.closest('.scroll, #jump-hist');
      y0 = scroller && scroller.scrollTop > 0 ? null : e.touches[0].clientY;
      dy = 0;
      el.style.transition = 'none';
    },
    { passive: true },
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      if (y0 === null) return;
      dy = e.touches[0].clientY - y0;
      if (dy <= 0) {
        // 上方向は中身のスクロールに任せる
        el.style.transform = '';
        if (scroller && scroller.scrollHeight > scroller.clientHeight) y0 = null;
        return;
      }
      e.preventDefault();
      el.style.transform = `translateY(${dy}px)`;
    },
    { passive: false },
  );
  const end = () => {
    if (y0 === null) return;
    y0 = null;
    el.style.transition = 'transform .18s ease-out';
    if (dy > 80) {
      el.style.transform = 'translateY(100%)';
      setTimeout(() => {
        if (openSheet === el) sheet(null);
      }, 170);
    } else el.style.transform = '';
  };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
});
$('#scrim').onclick = () => sheet(null);
$('#btn-set').onclick = () => sheet('#sheet-set');

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 1800);
}

/* ---------- 法令一覧 ---------- */
function renderHome() {
  const q = $('#filter').value.trim();
  let html = '';
  for (const g of index.groups) {
    const ls = g.laws.filter((l) => !q || l.title.includes(q));
    if (!ls.length) continue;
    html += `<div class="grp">${esc(g.name)}</div>`;
    for (const l of ls) {
      html += `<button class="lawrow" data-id="${l.id}"><span>${esc(l.title)}</span></button>`;
    }
  }
  $('#lawlist').innerHTML = html || '<div class="empty">該当する法令がありません</div>';
}
$('#filter').oninput = renderHome;
$('#lawlist').onclick = (e) => {
  const b = e.target.closest('.lawrow');
  if (!b) return;
  const t = tabs.find((x) => x.id === b.dataset.id);
  location.hash = t ? tabHash(t) : b.dataset.id;
};
$('#back').onclick = () => (location.hash = '');

function setFoot(offline, ver) {
  $('#foot').innerHTML =
    `出典: e-Gov法令検索（デジタル庁）のデータを加工して作成。<br>データ更新日 <b>${index.built}</b>。改正法の附則と別表は収録していません。<br>` +
    (offline ? `<b>オフライン利用可</b>（全法令を端末に保存済み）<br>アプリの版 ${ver}` : 'オフライン用データを保存中…');
}

/* ---------- タブ（開いている法令。1法令につき1つ） ---------- */
let tabs = store.get('tabs', []); // [{ id, rev }]  rev は旧版を表示しているときだけ
const tabHash = (t) => t.id + (t.rev ? '@' + t.rev : '');
function drawTabs() {
  const el = $('#tabs');
  el.hidden = !tabs.length;
  el.innerHTML =
    tabs
      .map((t) => {
        const on = cur && cur.id === t.id;
        return `<button class="tab${on ? ' on' : ''}" data-id="${t.id}"><span>${esc(metaOf(t.id).title)}</span>${on ? '<i data-close aria-label="閉じる">×</i>' : ''}</button>`;
      })
      .join('') + (cur ? '<button class="tab add" data-add aria-label="別の法令を開く">＋</button>' : '');
  const on = el.querySelector('.on');
  if (on) el.scrollLeft = Math.max(0, on.offsetLeft - 60);
}
$('#tabs').onclick = (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  if (b.dataset.add !== undefined) return (location.hash = '');
  const i = tabs.findIndex((t) => t.id === b.dataset.id);
  if (e.target.closest('[data-close]')) {
    tabs.splice(i, 1);
    store.set('tabs', tabs);
    const next = tabs[Math.min(i, tabs.length - 1)];
    location.hash = next ? tabHash(next) : '';
    return;
  }
  location.hash = tabHash(tabs[i]);
};

/* ---------- 法令の読み込みと表示 ---------- */
async function loadLaw(id) {
  if (laws.has(id)) return laws.get(id);
  const law = await (await fetch(`data/${id}.json`)).json();
  law.map = new Map();
  law.ranges = [];
  law.nodes.forEach((nd, i) => {
    if (nd[0] !== 'a') return;
    law.map.set(nd[1], i);
    if (nd[1].includes(':')) {
      const [a, b] = nd[1].split(':').map((x) => parseInt(x, 10));
      law.ranges.push([a, b, nd[1]]);
    }
  });
  laws.set(id, law);
  return law;
}

// 入力キー（"398_2"）を実在する条の Num に解決する。削除された範囲（第38条〜第84条）も拾う。
function resolve(law, key) {
  if (!key) return null;
  if (law.map.has(key)) return key;
  if (!key.includes('_')) {
    const v = parseInt(key, 10);
    const r = law.ranges.find(([a, b]) => a <= v && v <= b);
    if (r) return r[2];
  }
  return null;
}

// 冒頭の「○○ 施行の版」。版が複数あるときは切り替えボタンにする。
function verLine(law) {
  const t = `${ymd(law.enforced)} 施行の版${law.old ? '（旧版）' : ''}`;
  return law.meta.versions.length > 1 ? `<button id="ver-btn">${t} ▾</button>` : t;
}
$('#body').addEventListener('click', (e) => {
  if (!e.target.closest('#ver-btn')) return;
  $('#ver-list').innerHTML = cur.meta.versions
    .map((v, i) => `<button class="hrow" data-rev="${v.rev}"><span>${ymd(v.enforced)} 施行</span><span class="c">${i === 0 ? '現行' : ''}</span><span class="k">${v.rev === cur.rev ? '表示中' : ''}</span></button>`)
    .join('');
  sheet('#sheet-ver');
});
$('#ver-list').onclick = (e) => {
  const b = e.target.closest('.hrow');
  if (!b) return;
  const latest = b.dataset.rev === cur.meta.versions[0].rev;
  // 読んでいた条のまま版を切り替える
  location.hash = cur.id + (latest ? '' : '@' + b.dataset.rev) + (curN ? '/' + curN : '');
};

let arts = [];
function renderLaw(law) {
  let html = `<div class="lawnum">${esc(law.num)}<br>${verLine(law)}</div><h1>${esc(law.title)}</h1>`;
  law.nodes.forEach((nd, i) => {
    if (nd[0] === 'h') html += `<div class="h h${nd[1]}" id="h${i}">${esc(nd[2])}</div>`;
    else if (nd[0] === 'a') html += `<section class="a" id="a-${nd[1]}" data-n="${nd[1]}">${nd[2]}</section>`;
    else html += `<div class="x">${nd[1]}</div>`;
  });
  $('#body').innerHTML = html;
  arts = [...document.querySelectorAll('#body .a')];
}

function scrollToArt(n, flash = true) {
  const el = document.getElementById('a-' + n);
  if (!el) return false;
  el.scrollIntoView({ block: 'start' });
  if (flash) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
  setCur(n);
  return true;
}

function setCur(n) {
  if (n === curN) return;
  curN = n;
  $('#cur').textContent = n ? label(n) : '';
  if (cur && n) {
    const pos = store.get('pos', {});
    pos[cur.id] = n;
    store.set('pos', pos);
  }
}

// 画面上端にかかっている条を二分探索で求める
function track() {
  if (!cur || !arts.length) return;
  const line = $('#hd').offsetHeight + 12;
  let lo = 0;
  let hi = arts.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arts[mid].getBoundingClientRect().top <= line) {
      hit = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  setCur(hit < 0 ? null : arts[hit].dataset.n);
}
let ticking = false;
addEventListener(
  'scroll',
  () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      track();
    });
  },
  { passive: true },
);

function navButtons() {
  $('#nav-back').disabled = !back.length;
  $('#nav-fwd').disabled = !fwd.length;
}
// 現在地を「戻る」に積んでから移動する
function jumpTo(n) {
  if (curN && curN !== n) {
    back.push(curN);
    fwd.length = 0;
  }
  scrollToArt(n);
  navButtons();
}
$('#nav-back').onclick = () => {
  if (!back.length) return;
  if (curN) fwd.push(curN);
  scrollToArt(back.pop());
  navButtons();
};
$('#nav-fwd').onclick = () => {
  if (!fwd.length) return;
  if (curN) back.push(curN);
  scrollToArt(fwd.pop());
  navButtons();
};

/* ---------- 条文番号 ---------- */
let val = '';
const keyOf = (v) => v.replace(/の$/, '').replace(/の/g, '_');
function capOf(n) {
  return cur.nodes[cur.map.get(n)][3] || '';
}
function drawJump() {
  $('#jump-val').textContent = val ? `第${val.replace(/^(\d+)/, '$1条')}` : '';
  const n = resolve(cur, keyOf(val));
  $('#jump-prev').textContent = !val ? '' : n ? (n.includes(':') ? label(n) + '　削除' : capOf(n)) : '該当なし';
}
function drawHist() {
  const h = (store.get('hist', {})[cur.id] || []).filter((x) => cur.map.has(x.k));
  $('#jump-hist').innerHTML = h.length
    ? '<div class="lbl">履歴</div>' +
      h.map((x) => `<button class="hrow" data-n="${x.k}"><span>${label(x.k)}</span><span class="c">${esc(capOf(x.k))}</span><span class="k">${x.c}</span></button>`).join('')
    : '';
}
function remember(n) {
  const all = store.get('hist', {});
  const h = all[cur.id] || [];
  const i = h.findIndex((x) => x.k === n);
  const item = i >= 0 ? h.splice(i, 1)[0] : { k: n, c: 0 };
  item.c++;
  h.unshift(item);
  all[cur.id] = h.slice(0, 40);
  store.set('hist', all);
}
function go() {
  const n = resolve(cur, keyOf(val));
  if (!n) {
    const box = $('#jump-input');
    box.classList.remove('ng');
    void box.offsetWidth;
    box.classList.add('ng');
    return;
  }
  remember(n);
  sheet(null);
  jumpTo(n);
}
$('#nav-jump').onclick = () => {
  val = '';
  $('#jump-input').classList.remove('ng');
  drawJump();
  drawHist();
  sheet('#sheet-jump');
};
$('#pad').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'pad-go') return go();
  if (b.id === 'pad-del') val = val.slice(0, -1);
  else {
    const k = b.dataset.k;
    if (k === 'の' ? !val || val.endsWith('の') : val === '' && k === '0') return;
    if (val.length >= 12) return;
    val += k;
  }
  $('#jump-input').classList.remove('ng');
  drawJump();
};
$('#jump-hist').onclick = (e) => {
  const b = e.target.closest('.hrow');
  if (!b) return;
  remember(b.dataset.n);
  sheet(null);
  jumpTo(b.dataset.n);
};
// 外付けキーボードでも打てるように
addEventListener('keydown', (e) => {
  if (openSheet !== $('#sheet-jump')) return;
  if (/^[0-9]$/.test(e.key)) $(`#pad [data-k="${e.key}"]`).click();
  else if (e.key === '-' || e.key === '_') $('#pad .no').click();
  else if (e.key === 'Backspace') $('#pad-del').click();
  else if (e.key === 'Enter') go();
  else if (e.key === 'Escape') sheet(null);
});

/* ---------- 目次 ---------- */
$('#nav-toc').onclick = () => {
  const rows = [];
  cur.nodes.forEach((nd, i) => {
    if (nd[0] === 'h') rows.push(`<button class="trow l${nd[1]}" data-i="${i}">${esc(nd[2])}</button>`);
  });
  $('#toc').innerHTML = rows.join('') || '<div class="empty">この法令には章立てがありません</div>';
  sheet('#sheet-toc');
};
$('#toc').onclick = (e) => {
  const b = e.target.closest('.trow');
  if (!b) return;
  sheet(null);
  if (curN) {
    back.push(curN);
    fwd.length = 0;
    navButtons();
  }
  document.getElementById('h' + b.dataset.i).scrollIntoView({ block: 'start' });
};

/* ---------- 法令内検索 ---------- */
function textOf(law) {
  if (!law.text) {
    law.text = law.nodes.map((nd) =>
      nd[0] === 'a' ? nd[2].replace(/<rt>.*?<\/rt>/g, '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : '',
    );
  }
  return law.text;
}
let findT;
function find() {
  const q = $('#find-q').value.trim();
  const box = $('#find-res');
  if (!q) return (box.innerHTML = '<div class="empty">条文の本文と見出しから探します</div>');
  const text = textOf(cur);
  const out = [];
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const p = text[i].indexOf(q);
    if (p < 0) continue;
    total++;
    if (out.length >= 100) continue;
    const nd = cur.nodes[i];
    const s = Math.max(0, p - 18);
    const snip = (s ? '…' : '') + esc(text[i].slice(s, p)) + '<mark>' + esc(q) + '</mark>' + esc(text[i].slice(p + q.length, p + q.length + 50));
    out.push(`<button class="frow" data-n="${nd[1]}"><b>${label(nd[1])}</b><i>${esc(nd[3] || '')}</i><p>${snip}</p></button>`);
  }
  box.innerHTML = total
    ? `<div class="empty" style="padding:4px 0 8px;text-align:left">${total}条が該当${total > 100 ? '（先頭100件を表示）' : ''}</div>` + out.join('')
    : '<div class="empty">見つかりませんでした</div>';
}
$('#find-q').oninput = () => {
  clearTimeout(findT);
  findT = setTimeout(find, 160);
};
$('#nav-find').onclick = () => {
  find();
  sheet('#sheet-find');
};
$('#find-res').onclick = (e) => {
  const b = e.target.closest('.frow');
  if (!b) return;
  $('#find-q').blur();
  sheet(null);
  jumpTo(b.dataset.n);
};

/* ---------- 条文中の参照を小窓で開く ---------- */
let refView = null; // { law, keys }
const refStack = [];
// data-r: "95" / "93,94"（同じ法令）、"法令ID:709"（他の法令）
function parseRef(r, base) {
  const i = r.indexOf(':');
  if (i > 0 && !/^[\d_]+$/.test(r.slice(0, i))) return { lawId: r.slice(0, i), keys: [r.slice(i + 1)] };
  return { lawId: base.id, keys: r.split(',') };
}
async function openRef(r, base, push) {
  const { lawId, keys } = parseRef(r, base);
  let law = base;
  if (lawId !== base.id) {
    const m = metaOf(lawId);
    try {
      law = await loadLaw(m.versions[0].rev);
    } catch {
      return toast('読み込めませんでした');
    }
    law.meta = m;
  }
  const ks = keys.map((k) => resolve(law, k)).filter(Boolean);
  if (!ks.length) return toast('該当する条がありません');
  if (push && refView) refStack.push(refView);
  else refStack.length = 0;
  refView = { law, keys: ks };
  drawRef();
  sheet('#sheet-ref');
}
function drawRef() {
  const { law, keys } = refView;
  const range = keys.length > 1 ? `${label(keys[0])}〜${label(keys[keys.length - 1])}` : label(keys[0]);
  $('#ref-title').textContent = (law.id !== cur.id ? law.title + ' ' : '') + range;
  $('#ref-body').innerHTML = keys.map((k) => `<section class="a" data-n="${k}">${law.nodes[law.map.get(k)][2]}</section>`).join('');
  $('#ref-body').scrollTop = 0;
  $('#ref-back').hidden = !refStack.length;
}
$('#ref-back').onclick = () => {
  if (!refStack.length) return;
  refView = refStack.pop();
  drawRef();
};
$('#ref-go').onclick = () => {
  const { law, keys } = refView;
  sheet(null);
  if (law === cur) jumpTo(keys[0]);
  else location.hash = (law.id === cur.id ? tabHash({ id: law.id, rev: cur.old ? cur.rev : undefined }) : law.id) + '/' + keys[0];
};

/* ---------- 条文のコピー（条名をタップ） ---------- */
function artText(sec) {
  const lines = [];
  sec.querySelectorAll('.cap, .u, .s, tr').forEach((el) => {
    const row = el.tagName === 'TR';
    if (!row && el.closest('table')) return;
    const c = el.cloneNode(true);
    c.querySelectorAll('rt').forEach((x) => x.remove());
    const d = Number((el.className.match(/\bd(\d)\b/) || [])[1] || 0);
    lines.push('　'.repeat(d) + (row ? [...c.children].map((td) => td.textContent.trim()).join('\t') : c.textContent));
  });
  return lines.join('\n');
}
async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(msg);
}
$('#ref-copy').onclick = () => {
  const secs = [...document.querySelectorAll('#ref-body .a')];
  copy(refView.law.title + '\n' + secs.map(artText).join('\n'), 'コピーしました');
};
document.addEventListener('click', (e) => {
  if (!cur) return;
  const inRef = !!e.target.closest('#ref-body');
  const a = e.target.closest('a[data-r]');
  if (a) return openRef(a.dataset.r, inRef ? refView.law : cur, inRef);
  const at = e.target.closest('.at');
  if (at) {
    const sec = at.closest('.a, .x');
    const law = inRef ? refView.law : cur;
    copy(law.title + '\n' + artText(sec), (sec.dataset.n ? label(sec.dataset.n) : at.textContent) + 'をコピーしました');
  }
});

/* ---------- ルーティング: #<法令ID> または #<法令ID>/<条> ---------- */
async function route() {
  sheet(null);
  const [idv, n] = decodeURIComponent(location.hash.slice(1)).split('/');
  const [id, rev] = idv.split('@');
  const meta = id && index.groups.flatMap((g) => g.laws).find((l) => l.id === id);
  if (!meta) {
    cur = null;
    curN = null;
    document.body.classList.add('home');
    $('#home').hidden = false;
    $('#law').hidden = $('#bar').hidden = true;
    $('#lawname').textContent = '簡易六法';
    $('#old').hidden = true;
    $('#cur').textContent = '';
    $('#body').innerHTML = '';
    renderHome();
    drawTabs();
    scrollTo(0, 0);
    return;
  }
  let law;
  let ver;
  try {
    ver = meta.versions.find((v) => v.rev === rev) || meta.versions[0];
    law = await loadLaw(ver.rev);
  } catch {
    toast('読み込めませんでした（オフライン用データが未保存）');
    location.hash = '';
    return;
  }
  cur = law;
  cur.meta = meta;
  cur.old = ver !== meta.versions[0];
  curN = null;
  if (!stacks.has(id)) stacks.set(id, { back: [], fwd: [] });
  ({ back, fwd } = stacks.get(id));
  navButtons();
  let tab = tabs.find((t) => t.id === id);
  if (!tab) tabs.push((tab = { id }));
  tab.rev = cur.old ? ver.rev : undefined;
  store.set('tabs', tabs);
  drawTabs();
  document.body.classList.remove('home');
  $('#home').hidden = true;
  $('#law').hidden = $('#bar').hidden = false;
  $('#lawname').textContent = law.title;
  $('#old').hidden = !cur.old;
  $('#cur').textContent = '';
  $('#find-q').value = '';
  // 条番号つきのリンクで開いても、再読み込み時は前回位置に戻れるよう URL から条番号を外す
  history.replaceState(null, '', '#' + id + (cur.old ? '@' + ver.rev : ''));
  renderLaw(law);
  const target = resolve(law, n) || store.get('pos', {})[id];
  if (!target || !scrollToArt(target, !!n)) scrollTo(0, 0);
}

async function main() {
  applyPrefs();
  index = await (await fetch('data/index.json')).json();
  tabs = tabs.filter((t) => metaOf(t.id));
  setFoot(false);
  addEventListener('hashchange', route);
  await route();
  if ('serviceWorker' in navigator) {
    try {
      // 新しい版が端末に入り終わったら知らせる（初回の保存完了時は出さない）
      let had = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (had) $('#update').hidden = false;
        had = true;
      });
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      // ホーム画面のアプリは閉じても裏で生きていることが多いので、前面に戻るたびに更新を確かめる
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
      await navigator.serviceWorker.ready;
      const v = (await caches.keys()).filter((k) => k.startsWith('roppo-')).pop();
      setFoot(true, v ? v.slice(6) : '');
    } catch {
      $('#foot').innerHTML += '<br>この開き方ではオフライン保存が使えません（HTTPS が必要）。';
    }
  }
}
$('#update').onclick = () => location.reload();
main();
