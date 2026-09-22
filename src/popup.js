'use strict';
const api = globalThis.browser || globalThis.chrome;

const $ = (id) => document.getElementById(id);
let tab = null;

const bg = (cmd, extra) => api.runtime.sendMessage(Object.assign({ ffc: true, cmd, tab }, extra));

function paint(st) {
  const on = !!st.active;
  $('toggle').textContent = on ? '切り抜きを解除' : '切り抜き ON';
  $('toggle').classList.toggle('on', on);
  $('host').textContent = st.host || '(このページでは使えません)';
  // ページ設定は site から、全体設定は settings から読む
  const site = st.site || {};
  $('mode').value = site.mode || 'auto';
  $('strategy').value = site.strategy || 'auto';
  $('auto').checked = !!site.auto;
  $('stretchFrames').checked = site.stretchFrames !== false;
  $('exitButton').checked = st.settings.exitButton !== false;
  $('exitCorner').value = st.settings.exitCorner || 'br';
  $('saved').textContent = st.site && st.site.selector
    ? '記憶中の対象: ' + st.site.selector
    : '対象: 自動検出 (未確定)';

  /* 同期の状態。失敗しても黙っていると「同期されないことに気づけない」ので出す。
     主な失敗要因は容量超過 (sites は 1 項目 8192 バイトまで)。 */
  const sync = st.sync || {};
  const el = $('syncInfo');
  if (sync.error) {
    el.textContent = '⚠ 設定の保存に失敗: ' + sync.error;
    el.style.color = '#d3455b';
  } else {
    const n = (v) => (v === null || v === undefined ? '?' : v + '件');
    el.textContent = (sync.enabled ? '同期あり' : 'この端末のみ')
      + '   sync: ' + n(sync.syncCount) + ' / local: ' + n(sync.localCount);
    el.style.removeProperty('color');
  }
  // local にしか無い設定がある時だけ復元ボタンを出す
  const canRestore = (sync.localCount || 0) > (sync.syncCount || 0);
  $('restoreRow').style.display = canRestore ? '' : 'none';
}

async function refresh() {
  paint(await bg('popup:getState'));
}

let lastFrames = [];
let usefulFrames = [];
let lastZoom = null;

function mkLine(text) {
  const d = document.createElement('div');
  d.className = 'saved';
  d.textContent = text;
  return d;
}

function shortSrc(src) {
  if (!src) return '(src なし)';
  try { const u = new URL(src, 'https://x/'); return u.hostname + u.pathname.slice(0, 40); }
  catch (_) { return src.slice(0, 50); }
}

async function loadCandidates() {
  const box = $('cands');
  box.textContent = '読み込み中…';
  const res = await bg('popup:candidates');
  lastFrames = (res && res.frames) || [];
  lastZoom = (res && res.zoom) || null;
  const total = lastFrames.reduce((n, f) => n + f.list.length, 0);
  const shown = lastFrames.filter((f) => f.list.length || f.targetInfo).length;
  $('candCount').textContent = '(' + total + ' / ' + shown + 'フレーム)';
  box.textContent = '';

  // ブラウザズームの現況と、最後の操作の結果 (失敗していればその理由)
  if (lastZoom) {
    const z = document.createElement('div');
    z.className = 'saved';
    const L = lastZoom.last;
    let txt = 'ブラウザズーム: 現在 ' + (lastZoom.now == null ? '?' : lastZoom.now)
      + (lastZoom.saved != null ? ' (元 ' + lastZoom.saved + ')' : ' / 未操作')
      + '  要求回数 ' + (lastZoom.calls || 0);
    for (const h of (lastZoom.history || []).slice(-6)) {
      txt += '\n  ' + h.at + ' 枠' + (h.vp || []).join('×')
        + ' ' + (h.before != null ? h.before : '?') + '→' + (h.want != null ? h.want : '?')
        + ' ' + (h.result || h.error || '');
    }
    if (L) {
      txt += '\n最後の要求 ' + L.at + ' 対象' + (L.req || []).join('×')
        + ' 枠' + (L.vp || []).join('×')
        + (L.want != null ? ' 希望倍率 ' + L.want : '')
        + (L.result ? ' → ' + L.result : '')
        + (L.after != null ? ' (実測 ' + L.after + ')' : '')
        + (L.error ? '  ✖ ' + L.error : '')
        + (L.scopeWarn ? '  ⚠ scope: ' + L.scopeWarn : '');
    } else {
      txt += '\nズーム要求は一度も出ていない (= bzoom モードが動いていない)';
    }
    z.textContent = txt;
    z.style.whiteSpace = 'pre-line';
    box.appendChild(z);
  }

  if (!lastFrames.length) {
    box.appendChild(document.createTextNode('候補なし。ページを読み込み直してから開いてください。'));
    return;
  }

  /* 候補も対象も無いフレームは省く。トラッキング用の 1x1、SNS ウィジェット、
     about:blank などが大半を占め、一覧も JSON も無用に長くなる。
     「いくつ省いたか」は切り分けの材料になるので件数だけ残す。 */
  usefulFrames = lastFrames.filter((f) => f.list.length || f.targetInfo);
  const skipped = lastFrames.length - usefulFrames.length;
  if (skipped) {
    box.appendChild(mkLine('候補も対象も無いフレーム ' + skipped + ' 件は省略'));
  }

  for (const fr of usefulFrames) {
    const head = document.createElement('div');
    head.className = 'frameHead';
    const cur = fr.list.find((c) => c.current);
    const vp = fr.viewport || [0, 0];
    const follows = cur && Math.abs(cur.w - vp[0]) <= 2 && Math.abs(cur.h - vp[1]) <= 2;
    const ti = fr.targetInfo;
    head.style.whiteSpace = 'pre-line';
    head.textContent = (fr.isTop ? '最上位' : '内側 #' + fr.frameId) + '  ' + hostOf(fr.url)
      + '  枠 ' + vp[0] + '×' + vp[1]
      + '  設定=' + (fr.mode || '?') + (fr.stretchFrames === false ? ' / 内側OFF' : '')
      + '\n対象: ' + (ti
        ? ti.tag + (ti.id ? '#' + ti.id : '') + (ti.cls ? '.' + ti.cls.split(' ')[0] : '')
          + '  実効モード=' + ti.mode
          + '  元' + (ti.natural ? ti.natural.join('×') : '?')
          + ' → 今' + ti.rendered.join('×')
          + (follows ? ' ✓枠と一致' : '')
        : 'なし');
    box.appendChild(head);

    if (!fr.list.length) {
      const none = document.createElement('div');
      none.className = 'saved';
      none.textContent = '  (このフレームには候補となる要素がありません)';
      box.appendChild(none);
      continue;
    }
    for (const c of fr.list) {
      const b = document.createElement('button');
      b.className = 'cand' + (c.current ? ' current' : '');
      const t = document.createElement('b');
      t.textContent = c.tag + (c.id ? '#' + c.id : '') + (c.name ? '[' + c.name + ']' : '');
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.style.whiteSpace = 'pre-line';
      meta.textContent = c.w + '×' + c.h + '  y=' + c.y + '  score=' + c.score + '\n' + shortSrc(c.src);
      b.append(t, meta);
      b.addEventListener('click', async () => {
        await bg('popup:setFrameTarget', { frameId: fr.frameId, selector: c.selector });
        await refresh();
        await loadCandidates();
      });
      box.appendChild(b);
    }
  }
}

/* 保存済みサイトの一覧と削除。キーがページ単位になったぶん件数が増えるので、
   中身が見えて消せないと管理できない。 */
async function loadSites() {
  const box = $('sites');
  box.textContent = '読み込み中…';
  const res = await bg('popup:listSites');
  const rows = (res && res.sites) || [];
  $('siteCount').textContent = '(' + rows.length + ')';
  box.textContent = '';
  if (!rows.length) { box.textContent = 'まだ何も保存されていません。'; return; }

  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'site' + (r.current ? ' current' : '');

    const info = document.createElement('div');
    info.className = 'info';
    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = r.key + (r.current ? '  ← 表示中' : '');
    const d = document.createElement('div');
    d.className = 'd';
    const bits = [];
    if (r.auto) bits.push('自動適用');
    if (r.mode) bits.push('表示=' + r.mode);
    if (r.strategy && r.strategy !== 'auto') bits.push('選び方=' + r.strategy);
    if (r.stretchFrames === false) bits.push('内側フレーム=OFF');
    if (r.selector) bits.push('対象=' + r.selector);
    if (r.subCount) bits.push('内側フレーム ' + r.subCount + '件');
    d.textContent = bits.length ? bits.join(' / ') : '(設定なし)';
    info.append(k, d);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'この設定を削除';
    del.addEventListener('click', async () => {
      await bg('popup:deleteSite', { key: r.key });
      await refresh();
      await loadSites();
    });

    row.append(info, del);
    box.appendChild(row);
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return url ? url.slice(0, 30) : '?'; }
}

async function init() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  tab = tabs[0] ? { id: tabs[0].id, url: tabs[0].url } : null;
  if (!tab || !/^https?:/.test(tab.url || '')) {
    $('toggle').disabled = true;
    $('host').textContent = 'このページでは使えません';
    return;
  }
  await refresh();

  $('toggle').addEventListener('click', async () => { await bg('popup:toggle'); await refresh(); });
  $('pick').addEventListener('click', async () => { await bg('popup:pick'); window.close(); });
  $('reset').addEventListener('click', async () => {
    await bg('popup:clearSelector'); await refresh();
    if ($('siteBox').open) await loadSites();
  });
  // --- ここから「このページの設定」。保存先は popup:setSite ---
  $('mode').addEventListener('change', async (e) => {
    await bg('popup:setSite', { patch: { mode: e.target.value } });
    await refresh();
  });
  $('auto').addEventListener('change', async (e) => {
    await bg('popup:setSite', { patch: { auto: e.target.checked } });
  });
  $('stretchFrames').addEventListener('change', async (e) => {
    await bg('popup:setSite', { patch: { stretchFrames: e.target.checked } });
    await refresh();
  });
  // --- ここから「全体の設定」。保存先は popup:setSettings ---
  $('exitButton').addEventListener('change', async (e) => {
    await bg('popup:setSettings', { patch: { exitButton: e.target.checked } });
  });
  $('exitCorner').addEventListener('change', async (e) => {
    await bg('popup:setSettings', { patch: { exitCorner: e.target.value } });
  });
  $('strategy').addEventListener('change', async (e) => {
    // 選び方を変えたら、記憶済みの対象は邪魔になるので一緒に捨てる
    await bg('popup:setSite', { patch: { strategy: e.target.value, selector: null } });
    await refresh();
  });
  $('cycle').addEventListener('click', async () => {
    // ショートカット (Alt+Shift+Z) と同じループ。現在地はページ上に出る
    const res = await bg('popup:cycle');
    $('cycleInfo').textContent = (res && res.active) ? '' : '一周したので OFF にしました';
    await refresh();
    if ($('candBox').open) await loadCandidates();
  });
  $('siteBox').addEventListener('toggle', (e) => { if (e.target.open) loadSites(); });
  $('restore').addEventListener('click', async () => {
    const res = await bg('popup:restoreFromLocal');
    $('syncInfo').textContent = '復元しました: ' + ((res && res.restored) || 0) + '件';
    await refresh();
    if ($('siteBox').open) await loadSites();
  });
  $('candBox').addEventListener('toggle', (e) => { if (e.target.open) loadCandidates(); });
  $('copy').addEventListener('click', async (e) => {
    e.preventDefault();
    await navigator.clipboard.writeText(JSON.stringify({ url: tab.url, zoom: lastZoom, frames: usefulFrames }, null, 1));
    e.target.textContent = 'コピーしました';
    setTimeout(() => { e.target.textContent = '一覧を JSON でコピー'; }, 1500);
  });
}

init();
