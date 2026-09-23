'use strict';
/* Frame Cropper — background (常駐ページ)
 *
 * タブごとの ON/OFF を握り、全フレームへ指示を配る係。
 * tabs.sendMessage は frameId を省くとタブ内の全フレームに配送される性質を使う。
 */
const api = globalThis.browser || globalThis.chrome;

/* 設定は性質で 2 つに分ける。
     ページの作りで決まるもの → ページごと (同じホストでも別ページなら別の値)
     見た目の好みで決まるもの → 全体
   この区別が無いと、片方のページで必要だった値がもう片方を壊す。
   実際 stretchFrames を全体設定にしていたため、あるページで OFF にすると
   内側フレームの引き伸ばしが要る別ページまで効かなくなっていた。 */
const PAGE_DEFAULTS = {
  mode: 'auto',          // auto | fill | fit | bzoom | zoom
  strategy: 'auto',      // auto | first | largest … 対象の選び方
  stretchFrames: true    // 内側フレームも 100% に伸ばす
};

const GLOBAL_DEFAULTS = {
  exitButton: true,      // 画面隅に小さな × を出す (既定ON)
  exitCorner: 'br'       // tr | tl | br | bl
};

/** tabId -> {ffc,cmd:'apply',mode,selector,stretchFrames,exitButton,host} */
const activeTabs = new Map();

/* tabId -> Set(frameId)。content script が読み込み時に送ってくる 'query' で集める。
   候補一覧を全フレームから取るのに要る (tabs.sendMessage は frameId を指定しないと
   応答が 1 つしか返らず、どのフレームの答えか分からない)。 */
const tabFrames = new Map();

/* ブラウザズームを触る前の倍率。解除時にここへ戻す。
   tabs.setZoom は「CSS ピクセルの定義」を変えるので、transform: scale() と違って
   getBoundingClientRect() と clientWidth が同じ単位のまま = 中身の
   座標計算が崩れない。固定サイズの HTML 製中身を拡大する唯一まともな手。 */
const savedZoom = new Map();

/* 最後のズーム操作の結果。エラーを握りつぶすと「静かに何も起きない」状態になり
   原因が追えないので、必ず残してパネルに出す。 */
const zoomLog = new Map();

/* ズームはサイト単位で記録されるため、Firefox を再起動しても残る。
   その時こちらは何も覚えていないので、元の倍率をディスクにも控えておく。
   端末固有の情報なので local に置く (sync すると他端末のズームを壊す)。 */
async function rememberZoom(url, zoom) {
  const origin = originOf(url);
  if (!origin) return;
  try {
    const got = await api.storage.local.get('zoomRestore');
    const map = got.zoomRestore || {};
    if (map[origin] === undefined) {
      map[origin] = zoom;
      await api.storage.local.set({ zoomRestore: map });
    }
  } catch (_) {}
}

async function keptZoom(url) {
  const origin = originOf(url);
  if (!origin) return undefined;
  try {
    const got = await api.storage.local.get('zoomRestore');
    return (got.zoomRestore || {})[origin];
  } catch (_) { return undefined; }
}

async function forgetZoom(url) {
  const origin = originOf(url);
  if (!origin) return;
  try {
    const got = await api.storage.local.get('zoomRestore');
    const map = got.zoomRestore || {};
    if (map[origin] === undefined) return;
    delete map[origin];
    await api.storage.local.set({ zoomRestore: map });
  } catch (_) {}
}

const originOf = (url) => { try { return new URL(url).origin; } catch (_) { return ''; } };

async function restoreZoom(tabId, url) {
  const mem = savedZoom.get(tabId);
  savedZoom.delete(tabId);
  // ディスクの控えを優先する。こちらは一度しか書かないので、ずり上がらない
  const kept = await keptZoom(url);
  const z = kept !== undefined ? kept : mem;
  if (z === undefined) return;
  try { await api.tabs.setZoom(tabId, z); note(tabId, { at: stamp(), result: '復元 → ' + z }); }
  catch (e) { note(tabId, { at: stamp(), error: '復元失敗: ' + e.message }); }
  await forgetZoom(url);
}

function stamp() { return new Date().toISOString().slice(11, 19); }

/* 撮った画像を対象の矩形で切り抜く。
   captureVisibleTab は端末ピクセルで返すので、CSS ピクセルの矩形を
   画像の幅 / ビューポートの幅 で換算する (ブラウザズームも倍率に含まれる)。
   矩形が取れなければ無加工で返す — 何も保存されないより良い。 */
function cropShot(dataUrl, rect, vw) {
  return new Promise((resolve) => {
    if (!rect || !vw || !(rect.w > 0) || !(rect.h > 0)) return resolve(dataUrl);
    const img = new Image();
    img.onload = () => {
      try {
        const k = img.width / vw;
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(rect.w * k));
        c.height = Math.max(1, Math.round(rect.h * k));
        c.getContext('2d').drawImage(
          img, Math.round(rect.x * k), Math.round(rect.y * k), c.width, c.height,
          0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      } catch (_) { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function note(tabId, entry) {
  const hist = zoomLog.get(tabId) || [];
  hist.push(entry);
  while (hist.length > 12) hist.shift();
  zoomLog.set(tabId, hist);
}
function noteFrame(tabId, frameId) {
  if (tabId == null || frameId == null) return;
  let set = tabFrames.get(tabId);
  if (!set) { set = new Set(); tabFrames.set(tabId, set); }
  set.add(frameId);
}

/* 設定の保存先。storage.sync は Firefox アカウント経由で端末間を同期する
   (中身は E2E 暗号化される)。sync が使えない環境では local に落とす。

   容量の制限: 合計 102400 / 1項目 8192 バイト。sites は 1 項目に全サイトを
   まとめて入れるため、サイト数が数十を超えると書き込みに失敗する。
   失敗を握りつぶすと「同期されないのに気づかない」状態になるので、
   最後のエラーを保持してパネルに出す。 */
const STORE = api.storage.sync || api.storage.local;
const SYNCED = !!api.storage.sync;
let storeError = null;

/* local に残っている設定を一度だけ sync へ移す。
   sync 側に既に何かあれば移行済みとみなして触らない
   (2 台目で走らせた時に、空の local で上書きしてしまわないように)。 */
async function migrateToSync() {
  if (!SYNCED) return;
  /* 「まだ移行していない」の判定は、sync が **完全に空** かどうかで行う。
     旧レイアウトのキー (sites / settings) の有無で見てはいけない —
     1 項目ずつに分割した後はそのキー自体が存在しないので、移行済みなのに
     未移行と判定され、local の古いデータを sync へ書き戻してしまう。
     background は更新のたびに再起動するので、そのたびに現在の設定が
     古い内容で上書きされることになる (実際に 2 度飛ばした)。 */
  const cur = await api.storage.sync.get(null);
  if (Object.keys(cur).length) return;
  const old = await api.storage.local.get(['sites', 'settings']);
  if (!old.sites && !old.settings) return;
  const obj = {};
  if (old.sites) obj.sites = old.sites;
  if (old.settings) obj.settings = old.settings;
  await api.storage.sync.set(obj);
}

/* 移行が終わるまで読み書きを待たせる。待たないと、移行中の読み取りが
   空の sync を見てしまい「設定が消えた」ように見える。 */
/* 旧レイアウト (sites に全部入り) を 1 サイト 1 項目へ分割する。
   分割後も getSites() は両方を読むので、片方の端末が古いままでも壊れない。 */
/* 旧レイアウトを 1 項目ずつに分割する。
   **既にある項目は上書きしない**。分割は「取り残しの救済」であって、
   現在の値より古い内容で塗り替えるための処理ではない。
   書き込みに成功してから旧キーを消す (失敗した時に消すと元も失う)。 */
async function splitSettings() {
  const all = await STORE.get(null);
  if (!all.settings) return;
  const obj = {};
  for (const k of Object.keys(GLOBAL_DEFAULTS)) {
    if (all.settings[k] === undefined) continue;
    if (GLOBAL_PREFIX + k in all) continue;      // 新しい方が既にある
    obj[GLOBAL_PREFIX + k] = all.settings[k];
  }
  if (Object.keys(obj).length) await STORE.set(obj);
  await STORE.remove('settings');
}

async function splitSites() {
  const all = await STORE.get(null);
  if (!all.sites || !Object.keys(all.sites).length) return;
  const obj = {};
  for (const k of Object.keys(all.sites)) {
    if (SITE_PREFIX + k in all) continue;        // 新しい方が既にある
    obj[SITE_PREFIX + k] = all.sites[k];
  }
  if (Object.keys(obj).length) await STORE.set(obj);
  await STORE.remove('sites');
}

/* 起動のたびに sync の中身を local へ丸ごと控える。
   設定が消える事故が 2 度起きて、どちらも原因を特定できなかった。
   原因が分からない以上、**戻せるようにしておく**のが先。
   local はこの端末にしか無く、同期で壊れることがないので退避先に向く。
   直近 3 世代を残す (直前の 1 つだけだと、気づく前に空で上書きされる)。 */
async function snapshotSync() {
  if (!SYNCED) return;
  try {
    const cur = await api.storage.sync.get(null);
    const n = Object.keys(cur).length;
    const got = await api.storage.local.get('ffcBackup');
    const list = got.ffcBackup || [];
    const last = list[0];
    // 中身が空、または前回と同じなら残さない (空で世代を埋めてしまわない)
    if (n && (!last || JSON.stringify(last.data) !== JSON.stringify(cur))) {
      list.unshift({ at: new Date().toISOString(), count: n, data: cur });
      while (list.length > 3) list.pop();
      await api.storage.local.set({ ffcBackup: list });
    }
    await noteStartup({ at: new Date().toISOString(), syncKeys: n, backups: list.length });
  } catch (e) {
    await noteStartup({ at: new Date().toISOString(), error: e.message });
  }
}

/* 起動時に何が起きたかを残す。次に消えた時、これが手掛かりになる。 */
async function noteStartup(entry) {
  try {
    const got = await api.storage.local.get('ffcStartupLog');
    const list = got.ffcStartupLog || [];
    list.unshift(entry);
    while (list.length > 10) list.pop();
    await api.storage.local.set({ ffcStartupLog: list });
  } catch (_) {}
}

const storeReady = snapshotSync()
  .then(migrateToSync)
  .then(splitSites)
  .then(splitSettings)
  .catch((e) => { storeError = '移行: ' + e.message; });

/* どちらの保存領域に何件入っているかを返す。
   同期が効いていない時、原因は「sync に書けていない」「sync にはあるが
   端末に降りてきていない」のどちらか。件数を見比べれば切り分けられる。
   サイトのキー自体は URL なので、件数だけを返して中身は出さない。 */
/* パネルの「sync: N件」と同じ数え方。全キー数には全体設定も入るので、
   そのまま比べると減っていないのに「控えの方が多い」と誤判定する。 */
function countSites(data) {
  const set = new Set(Object.keys((data && data.sites) || {}));
  for (const k of Object.keys(data || {})) {
    if (k.startsWith(SITE_PREFIX)) set.add(k.slice(SITE_PREFIX.length));
  }
  return set.size;
}

async function syncStatus() {
  /* 新旧どちらのレイアウトも数える。旧キー (sites) だけを見ていると、
     splitSites で s:<キー> に分割した後は常に 0 と表示され、
     「同期が効いていない」と誤診する材料になる。 */
  // 控えとの比較で両辺が食い違わないよう、数え方は countSites 一本にする
  const count = async (area) => {
    try { return countSites(await api.storage[area].get(null)); }
    catch (_) { return null; }
  };
  let backups = [], startup = [];
  try {
    const got = await api.storage.local.get(['ffcBackup', 'ffcStartupLog']);
    /* サイト件数は控えの中身から数える。保存時に書き込む形だと、既に
       書かれている控えには入っておらず、いざ設定が飛んだ時 (控えは
       上書きされない) に復元ボタンが出ないまま終わる。 */
    backups = (got.ffcBackup || []).map((b) => ({
      at: b.at, count: b.count, sites: countSites(b.data),
    }));
    startup = got.ffcStartupLog || [];
  } catch (_) {}
  return {
    enabled: SYNCED,
    error: storeError,
    syncCount: await count('sync'),
    localCount: await count('local'),
    backups,
    startup: startup.slice(0, 3),
  };
}

/* ブラウザズームの現況。パネルに常時出す。
   候補一覧の中に畳んでいたら見つけてもらえなかった — 診断は
   見える所に無いと使われない。 */
async function zoomStatus(tabId) {
  let now = null;
  try { now = await api.tabs.getZoom(tabId); } catch (_) {}
  const hist = zoomLog.get(tabId) || [];
  const warn = hist.filter((h) => h.scopeWarn).pop();
  /* 表示する「元の倍率」もディスクの控えを正とする。メモリ側は
     background の再起動で失われ、再取得するとこちらが設定した倍率を
     拾ってしまうので、それを出すと解除先が拡大後の値に見えてしまう。 */
  let base;
  try {
    const tab = await api.tabs.get(tabId);
    base = await keptZoom(tab && tab.url);
  } catch (_) {}
  if (base === undefined) base = savedZoom.get(tabId);
  return {
    now: now == null ? null : Math.round(now * 100),
    saved: base === undefined ? null : Math.round(base * 100),
    scopeWarn: warn ? warn.scopeWarn : null,
  };
}

async function storeSet(obj) {
  await storeReady;
  try {
    await STORE.set(obj);
    storeError = null;
  } catch (e) {
    // 容量超過が主な原因。黙って落とすと同期されていないことに気づけない
    storeError = e.message;
    throw e;
  }
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch (_) { return ''; } };

/* 設定の保存キー。ホスト名だけだと、1 つのホストの下にぶら下がる
   別々のコンテンツ (/app/alpha, /app/beta …) が同じ 1 件を奪い合い、
   表示モードや対象セレクタを上書きし合う。
   パスの先頭 2 階層まで含めてページ単位で分ける。
   トップページ直下のサイトはホスト名だけのキーになる。 */
function siteKeyOf(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean).slice(0, 2);
    return u.hostname + (segs.length ? '/' + segs.join('/') : '');
  } catch (_) { return ''; }
}

/* キー変更前に保存した設定を拾えるよう、ホスト名だけの古いキーも見る。
   書き込みは新しいキーに行くので、一度触れば自動的に移行する。 */
/* そのサイトに「覚えていること」があるか。
   OFF 時の起動ボタンを出すかの判定と、保存済みサイト一覧の表示に使う。 */
function hasConfig(site) {
  if (!site) return false;
  return !!(site.selector || site.auto || site.mode || site.strategy
    || site.stretchFrames !== undefined
    || (site.sub && Object.keys(site.sub).length));
}

async function siteFor(url) {
  const sites = await getSites();
  return sites[siteKeyOf(url)] || sites[hostOf(url)] || {};
}

/* 全体設定も 1 設定 = 1 項目。項目数は少ないが、1 オブジェクトで書くと
   「ダウンロード前の端末が書いて他の項目を既定値に戻す」経路が残る。
   サイト設定で実際に起きた事故と同じ機序なので、同じ形に揃える。 */
const GLOBAL_PREFIX = 'g:';

async function getSettings() {
  await storeReady;
  const all = await STORE.get(null);
  const out = Object.assign({}, GLOBAL_DEFAULTS, all.settings || {});  // 旧レイアウト
  for (const k of Object.keys(GLOBAL_DEFAULTS)) {
    if (GLOBAL_PREFIX + k in all) out[k] = all[GLOBAL_PREFIX + k];
  }
  return out;
}

// ページ設定は「保存値 → 既定値」の順で解決する
function pageSetting(site, name) {
  return site && site[name] !== undefined ? site[name] : PAGE_DEFAULTS[name];
}

/* サイト設定は「1 サイト = 1 項目」で持つ。
   全サイトを 1 項目にまとめると、書き込みのたびに全体を置き換えることになり、
   エントリの少ない端末が書いた時点で他端末の設定を消してしまう
   (storage.sync は項目単位で突き合わせるので、触らない項目は無事)。
   1 項目 8192 バイトの上限にも掛かりにくくなる。 */
const SITE_PREFIX = 's:';

async function getSites() {
  await storeReady;
  const all = await STORE.get(null);
  const out = {};
  // 旧レイアウト (sites に全部入り) も読む。移行前の端末が書いたものが残り得る
  if (all.sites) Object.assign(out, all.sites);
  for (const k of Object.keys(all)) {
    if (k.startsWith(SITE_PREFIX)) out[k.slice(SITE_PREFIX.length)] = all[k];
  }
  return out;
}

async function patchSite(key, patch) {
  if (!key) return;
  const sites = await getSites();
  await storeSet({ [SITE_PREFIX + key]: Object.assign({}, sites[key], patch) });
}

async function removeSite(key) {
  await storeReady;
  await STORE.remove(SITE_PREFIX + key);
  // 旧レイアウトに残っている分も落とす
  const all = await STORE.get('sites');
  if (all.sites && key in all.sites) {
    delete all.sites[key];
    await storeSet({ sites: all.sites });
  }
}

async function payloadFor(url) {
  const siteKey = siteKeyOf(url);
  const s = await getSettings();
  const site = await siteFor(url);
  return {
    ffc: true,
    cmd: 'apply',
    siteKey,
    mode: pageSetting(site, 'mode'),
    strategy: pageSetting(site, 'strategy'),
    stretchFrames: pageSetting(site, 'stretchFrames'),
    selector: site.selector || null,
    sub: site.sub || {},
    exitButton: s.exitButton,
    exitCorner: s.exitCorner,
    launcher: hasConfig(site)      // OFF に戻した時も起動ボタンを残すため
  };
}

function send(tabId, msg, opts) {
  // 応答しないフレームが必ず居るので reject は握りつぶす
  Promise.resolve(api.tabs.sendMessage(tabId, msg, opts || {})).catch(() => {});
}

function badge(tabId, on) {
  try {
    api.browserAction.setBadgeText({ tabId, text: on ? 'ON' : '' });
    api.browserAction.setBadgeBackgroundColor({ tabId, color: '#2f7dff' });
  } catch (_) { /* タブが既に無い */ }
}

/* 中身 iframe は最上位フレームより後から生えてくる。生えた直後のフレームには
   初回ブロードキャストが届かないので、数秒かけて撒き直す。 */
function rebroadcast(tabId) {
  for (const d of [300, 900, 2000, 4000, 8000]) {
    setTimeout(() => {
      const msg = activeTabs.get(tabId);
      if (msg) send(tabId, msg);
    }, d);
  }
}

async function activate(tabId, url, announce) {
  const msg = await payloadFor(url);
  activeTabs.set(tabId, msg);
  // announce は初回送信にだけ載せる (rebroadcast で毎回トーストが出ないように)
  send(tabId, announce ? Object.assign({}, msg, { announce: true }) : msg);
  rebroadcast(tabId);
  badge(tabId, true);
}

/* Alt+Shift+Z の本体: OFF → 候補1 → 候補2 → … → OFF のループ。
   最初の 1 押しだけは 'apply' (設定込みの起動)、2 押し目以降は 'step' を送る。 */
async function stepTab(tab) {
  if (!activeTabs.has(tab.id)) { await activate(tab.id, tab.url, true); return; }
  let res = null;
  try {
    res = await api.tabs.sendMessage(tab.id, { ffc: true, cmd: 'step' }, { frameId: 0 });
  } catch (_) { /* content script 不在 */ }
  if (!res || !res.picked) { deactivate(tab.id); return; }
  if (res.picked.state === 'off') {
    activeTabs.delete(tab.id);
    send(tab.id, { ffc: true, cmd: 'clear' });   // 内側フレームも戻す
    await restoreZoom(tab.id, tab.url);          // ブラウザズームを元に戻す
    badge(tab.id, false);
    return;
  }
  if (res.picked.selector) {
    await patchSite(siteKeyOf(tab.url), { selector: res.picked.selector });
    const cur = activeTabs.get(tab.id);
    if (cur) cur.selector = res.picked.selector;
    rebroadcast(tab.id);
  }
}

function deactivate(tabId, url) {
  activeTabs.delete(tabId);
  send(tabId, { ffc: true, cmd: 'clear' });
  restoreZoom(tabId, url);
  badge(tabId, false);
}

async function toggle(tab) {
  if (!tab) return;
  if (activeTabs.has(tab.id)) deactivate(tab.id);
  else await activate(tab.id, tab.url);
}

async function reapply(tabId, url) {
  if (!activeTabs.has(tabId)) return;
  const msg = await payloadFor(url);
  activeTabs.set(tabId, msg);
  send(tabId, msg);
}

// ------------------------------------------------------------- イベント
api.runtime.onMessage.addListener(async (msg, sender) => {
  if (!msg || !msg.ffc) return undefined;
  const tab = sender.tab;
  const tabId = tab ? tab.id : null;

  switch (msg.cmd) {
    // content script からの「今このタブは切り抜き中?」問い合わせ
    case 'query': {
      if (tabId == null) return { ffc: true, cmd: 'idle' };
      noteFrame(tabId, sender.frameId);
      if (activeTabs.has(tabId)) return activeTabs.get(tabId);
      // 最上位フレームで、そのサイトが自動適用ONなら即座に開始する
      if (sender.frameId === 0) {
        const url = sender.url || tab.url || '';
        const site = await siteFor(url);
        if (site && site.auto) {
          const p = await payloadFor(url);
          activeTabs.set(tabId, p);
          badge(tabId, true);
          rebroadcast(tabId);
          return p;
        }
      }
      /* 切り抜きはしないが、設定済みサイトなら隅の起動ボタンだけ置かせる。
         ショートカットを覚えなくても OFF → ON ができるように。 */
      if (sender.frameId === 0) {
        const st = await getSettings();
        const site = await siteFor(sender.url || tab.url || '');
        return {
          ffc: true, cmd: 'idle',
          launcher: hasConfig(site), exitButton: st.exitButton, exitCorner: st.exitCorner
        };
      }
      return { ffc: true, cmd: 'idle' };
    }

    // ピッカーで決まった対象を、そのサイトの設定として覚える
    case 'picked': {
      if (tabId == null) return undefined;
      const topHost = siteKeyOf((tab && tab.url) || sender.url || '');
      if (msg.isTop) {
        await patchSite(topHost, { selector: msg.selector });
      } else {
        // 内側フレームの選択は「サイト → フレームのキー → セレクタ」で覚える。
        // patchSite 経由にして、触るのはこのサイトの 1 項目だけにする
        const sites = await getSites();
        const sub = Object.assign({}, (sites[topHost] || {}).sub, { [msg.frameKey]: msg.selector });
        await patchSite(topHost, { sub });
      }
      if (!activeTabs.has(tabId)) { if (tab) await activate(tabId, tab.url); }
      else {
        const cur = activeTabs.get(tabId);
        if (msg.isTop) cur.selector = msg.selector;
        else cur.sub = Object.assign({}, cur.sub, { [msg.frameKey]: msg.selector });
      }
      badge(tabId, true);
      return undefined;
    }

    /* 対象を「元の実寸のまま」置いて、拡大はブラウザズームに任せるモード。
       基準になる幅は (ビューポートのCSS幅 × 現在の倍率) で、ズームを変えても
       不変。これで再計算が発振せず一発で収束する。 */
    case 'fitZoom': {
      if (tabId == null) return undefined;
      const log = { at: new Date().toISOString().slice(11, 19), req: [msg.w, msg.h], vp: [msg.vw, msg.vh] };
      note(tabId, log);   // 往復しているなら履歴で一目で分かる
      if (!(msg.w > 0) || !(msg.h > 0)) { log.error = '対象の実寸が取れていない'; return undefined; }
      let cur = 1;
      try { cur = await api.tabs.getZoom(tabId); } catch (e) { log.error = 'getZoom: ' + e.message; return undefined; }
      log.before = +cur.toFixed(3);
      /* Firefox は scope: 'per-tab' を受け付けない (Unsupported zoom settings)。
         つまりズームは必ずサイト単位で記録され、タブを閉じても残る。
         こちらでできるのは「解除時と読み込み時に必ず元へ戻す」ことだけなので、
         失敗する呼び出しは行わず、元の倍率を確実に控えることに集中する。 */
      if (!savedZoom.has(tabId)) {
        /* background は更新のたびに再起動し、その時点の倍率 (こちらが設定した値)
           を「元の倍率」として控えてしまう。一度ディスクに書いた値を正とし、
           あればそれを採る。そうしないと解除しても元へ戻らず、
           拡大した値が新しい基準としてずり上がっていく。 */
        const kept = await keptZoom(tab && tab.url);
        savedZoom.set(tabId, kept !== undefined ? kept : cur);
        if (kept === undefined) await rememberZoom(tab && tab.url, cur);
      }
      const baseW = msg.vw * cur, baseH = msg.vh * cur;
      let z = Math.min(baseW / msg.w, baseH / msg.h);
      z = Math.max(0.3, Math.min(5, z));
      /* Firefox はズーム値を小数2桁に丸める (1.412 を要求すると 1.41 になる)。
         要求値と実際の値が必ずずれるので、こちらも 2 桁に量子化した上で
         0.02 の不感帯を置く。これが無いと
         「丸められた倍率 → ビューポートの整数丸め → 少し違う倍率を要求」
         を延々繰り返して 140%↔142% を行き来する。
         不感帯 2% ぶんの余白 (十数 px) は見た目に影響しない。 */
      z = Math.round(z * 100) / 100;
      log.want = z;
      /* 上限・下限に張り付いた要求は適用しない。
         対象の実寸がまだ決まっていない (canvas の既定 300x150 など) 時に
         巨大な倍率が出る。実際に 5 倍が適用されて画面が壊れた。
         正当な要求がこの端に来ることはまず無いので、弾く方が安全。 */
      if (z >= 5 || z <= 0.3) { log.result = '却下 (倍率が上限/下限に張り付き)'; return undefined; }
      if (Math.abs(z - cur) < 0.02) { log.result = '変更不要 (不感帯 ±0.02 内)'; return undefined; }
      try {
        await api.tabs.setZoom(tabId, z);
        log.result = '適用';
        try { log.after = +(await api.tabs.getZoom(tabId)).toFixed(3); } catch (_) {}
      } catch (e) {
        log.error = 'setZoom: ' + e.message;
      }
      return undefined;
    }

    /* スクリーンショット。tabs.captureVisibleTab は表示領域をそのまま撮るので、
       撮る前に自前の UI を隠し、撮った後に戻す。
       切り抜く範囲は「対象の矩形」。中間フレームはすべて全面に広げてあるため、
       最深フレームの座標がそのまま最上位の座標として使える。 */
    case 'shot': {
      if (tabId == null || !tab) return { ffc: true, error: 'タブが取れない' };
      send(tabId, { ffc: true, cmd: 'shotPrepare', on: true });
      await new Promise((r) => setTimeout(r, 80));   // 隠した状態が描画されるのを待つ

      // 対象の矩形を全フレームから集め、iframe でない一番小さいものを採る
      // (iframe は器なので、実際の描画面はその内側にある)
      let best = null, top = null;
      for (const fid of Array.from(new Set([0, ...(tabFrames.get(tabId) || [])]))) {
        try {
          const r = await api.tabs.sendMessage(tabId, { ffc: true, cmd: 'shotRect' }, { frameId: fid });
          if (!r || !r.rect) continue;
          if (r.isTop) top = r;
          if (!r.isIframe && (!best || r.rect.w * r.rect.h < best.rect.w * best.rect.h)) best = r;
        } catch (_) { /* 応答しないフレーム */ }
      }

      let shot = null, error = null;
      try {
        shot = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } catch (e) { error = e.message; }
      send(tabId, { ffc: true, cmd: 'shotPrepare', on: false });
      if (!shot) return { ffc: true, error: error || '撮影できなかった' };

      const use = best || top;
      const cropped = await cropShot(shot, use && use.rect, top && top.vw);
      send(tabId, { ffc: true, cmd: 'shotSave', dataUrl: cropped }, { frameId: 0 });
      return { ffc: true, ok: true };
    }

    // 隅の起動ボタンから ON にする
    case 'launch':
      if (tabId != null && tab) await activate(tabId, tab.url, true);
      return undefined;

    case 'restoreZoom':
      if (tabId != null) await restoreZoom(tabId, (tab && tab.url) || sender.url);
      return undefined;

    // ページ内 (Esc / ×ボタン) から解除された
    case 'deactivated':
      if (tabId != null) {
        activeTabs.delete(tabId);
        send(tabId, { ffc: true, cmd: 'clear' });
        await restoreZoom(tabId, (tab && tab.url) || sender.url);   // × / Esc 経由
        badge(tabId, false);
      }
      return undefined;

    // ---- ここから popup 用 ----
    case 'popup:getState': {
      const t = msg.tab;
      const host = siteKeyOf(t.url);
      return {
        ffc: true,
        active: activeTabs.has(t.id),
        host,
        settings: await getSettings(),
        site: await siteFor(t.url),
        sync: await syncStatus(),
        zoom: await zoomStatus(t.id)
      };
    }

    case 'popup:toggle':
      await toggle(msg.tab);
      return { ffc: true, active: activeTabs.has(msg.tab.id) };

    case 'popup:pick':
      send(msg.tab.id, { ffc: true, cmd: 'pick' }, { frameId: 0 });
      return undefined;

    /* 検出候補の一覧を全フレームから集める。
       内側フレームで何が選ばれているかが見えないと、黒画面の原因を切り分けられない。 */
    case 'popup:candidates': {
      // 最上位 (0) は必ず入れる。読み込み中の frameId 表クリアと
      // content script の登録が競合して、0 が抜け落ちることがある
      const ids = Array.from(new Set([0, ...(tabFrames.get(msg.tab.id) || [])])).sort((a, b) => a - b);
      const frames = [];
      for (const fid of ids) {
        try {
          const res = await api.tabs.sendMessage(msg.tab.id, { ffc: true, cmd: 'candidates' }, { frameId: fid });
          if (res && res.list) frames.push(Object.assign({ frameId: fid }, res));
        } catch (_) { /* もう存在しないフレーム */ }
      }
      let zoomNow = null;
      try { zoomNow = +(await api.tabs.getZoom(msg.tab.id)).toFixed(3); } catch (_) {}
      const hist = zoomLog.get(msg.tab.id) || [];
      return { ffc: true, frames, zoom: {
        now: zoomNow, saved: savedZoom.get(msg.tab.id) || null,
        calls: hist.length, history: hist, last: hist[hist.length - 1] || null
      } };
    }

    // 指定フレームの対象を差し替える (内側フレームの誤検出を人手で直す)
    case 'popup:setFrameTarget':
      try {
        await api.tabs.sendMessage(msg.tab.id,
          { ffc: true, cmd: 'setTarget', selector: msg.selector }, { frameId: msg.frameId });
      } catch (_) { /* 応答不要 */ }
      if (msg.frameId === 0) await patchSite(siteKeyOf(msg.tab.url), { selector: msg.selector });
      return undefined;

    // 候補を順送り (ショートカットと同じループ)
    case 'popup:cycle':
      await stepTab(msg.tab);
      return { ffc: true, active: activeTabs.has(msg.tab.id) };

    // 一覧から選ばれた対象を、そのサイトの設定として覚えて即適用
    case 'popup:choose':
      await patchSite(siteKeyOf(msg.tab.url), { selector: msg.selector });
      if (!activeTabs.has(msg.tab.id)) await activate(msg.tab.id, msg.tab.url);
      else await reapply(msg.tab.id, msg.tab.url);
      badge(msg.tab.id, true);
      return undefined;

    case 'popup:setSettings': {
      // 変更した項目だけを書く。他の項目には触れない
      const obj = {};
      for (const k of Object.keys(msg.patch || {})) obj[GLOBAL_PREFIX + k] = msg.patch[k];
      await storeSet(obj);
      if (msg.tab) await reapply(msg.tab.id, msg.tab.url);
      return { ffc: true, settings: await getSettings() };
    }

    case 'popup:setSite':
      await patchSite(siteKeyOf(msg.tab.url), msg.patch);
      await reapply(msg.tab.id, msg.tab.url);
      return undefined;

    // 保存済みサイトの一覧 (管理用)。今開いているサイトに印を付ける
    case 'popup:listSites': {
      const sites = await getSites();
      const cur = siteKeyOf(msg.tab ? msg.tab.url : '');
      const rows = Object.keys(sites).sort().map((k) => {
        const v = sites[k] || {};
        return {
          key: k, current: k === cur,
          mode: v.mode || null, strategy: v.strategy || null,
          stretchFrames: v.stretchFrames,
          auto: !!v.auto, selector: v.selector || null,
          subCount: v.sub ? Object.keys(v.sub).length : 0
        };
      });
      return { ffc: true, sites: rows };
    }

    case 'popup:deleteSite': {
      await removeSite(msg.key);
      // 今開いているサイトを消したなら、その場の切り抜きも解除する
      if (msg.tab && siteKeyOf(msg.tab.url) === msg.key && activeTabs.has(msg.tab.id)) {
        deactivate(msg.tab.id);
      }
      return { ffc: true, ok: true };
    }

    /* storage.local に残っている設定を sync へ戻す。
       sites を 1 項目に丸ごと入れていたため、エントリの少ない端末が
       書き込むと全体を置き換えてしまう事故が起きる。その復旧用。
       消さずに「和集合」で入れる — 復元によって別端末の設定を
       巻き添えで消さないため。 */
    case 'popup:restoreFromLocal': {
      const local = await api.storage.local.get(['sites', 'settings']);
      const cur = { sites: await getSites(), settings: await getSettings() };
      const merged = Object.assign({}, local.sites || {}, cur.sites);
      // 同じキーがある場合、エントリ数の多い方 (情報量の多い方) を採る
      for (const k of Object.keys(local.sites || {})) {
        const a = local.sites[k] || {}, b = cur.sites[k] || {};
        merged[k] = Object.keys(a).length >= Object.keys(b).length ? a : b;
      }
      const obj = {};
      const gs = Object.assign({}, local.settings || {}, cur.settings || {});
      for (const k of Object.keys(GLOBAL_DEFAULTS)) {
        if (gs[k] !== undefined) obj[GLOBAL_PREFIX + k] = gs[k];
      }
      for (const k of Object.keys(merged)) obj[SITE_PREFIX + k] = merged[k];
      await storeSet(obj);
      return { ffc: true, restored: Object.keys(merged).length };
    }

    /* 控えておいた世代から戻す。現在の内容と和集合にする —
       別端末で増えた設定を巻き添えで消さないため。 */
    case 'popup:restoreBackup': {
      const got = await api.storage.local.get('ffcBackup');
      const list = got.ffcBackup || [];
      const b = list[msg.index || 0];
      if (!b) return { ffc: true, error: '控えがありません' };
      const cur = await STORE.get(null);
      const obj = {};
      for (const k of Object.keys(b.data)) {
        if (!(k in cur)) obj[k] = b.data[k];       // 今あるものは触らない
      }
      if (Object.keys(obj).length) await storeSet(obj);
      return { ffc: true, restored: Object.keys(obj).length };
    }

    case 'popup:clearSelector':
      await patchSite(siteKeyOf(msg.tab.url), { selector: null, sub: {} });
      await reapply(msg.tab.id, msg.tab.url);
      return undefined;

    default:
      return undefined;
  }
});

api.commands.onCommand.addListener(async (name) => {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) return;
  if (name === 'toggle-crop') await stepTab(tab);
  else if (name === 'pick-element') send(tab.id, { ffc: true, cmd: 'pick' }, { frameId: 0 });
});

/* 他の端末で設定が変わったら、このタブにも反映させる。
   読み取りは都度ストアを見る作りなので、貼り直すだけでよい。 */
if (api.storage.onChanged) {
  api.storage.onChanged.addListener(async (changes, area) => {
    if (area !== (SYNCED ? 'sync' : 'local')) return;
    if (!changes.sites && !changes.settings) return;
    for (const [tabId, cur] of activeTabs) {
      try {
        const tab = await api.tabs.get(tabId);
        await reapply(tabId, tab.url);
      } catch (_) { /* タブが既に無い */ }
    }
  });
}

api.tabs.onRemoved.addListener((tabId) => {
  activeTabs.delete(tabId); tabFrames.delete(tabId); savedZoom.delete(tabId);
});

// 別サイトへ移動したら状態を落とす (同一ホスト内の遷移は維持し、
// content script 側の 'query' で自動的に貼り直される)
api.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'loading' || !info.url) return;
  tabFrames.delete(tabId);          // 読み込み直しで frameId は振り直される
  const cur = activeTabs.get(tabId);
  if (!cur) {
    /* 切り抜いていないのにズームが残っている場合がある。
       ブラウザ側のズームはタブ (またはサイト) に紐づいて保持されるため、
       読み込み直してもこちらが設定した倍率が残り、
       「切り抜いていないのに拡大されたページ」になってしまう。 */
    await restoreZoom(tabId, info.url);
    return;
  }
  // 別の中身 (パスが違う) へ移ったら状態を落とす
  if (siteKeyOf(info.url) !== cur.siteKey) { deactivate(tabId, info.url); return; }

  /* 同じページの読み込み直し。自動適用が付いていれば、どうせ読み込み後に
     倍率を計算し直すので残したままにする (戻すと 100% を挟んでちらつく)。
     付いていなければ、拡大されたまま素のページが出てしまうので戻す。 */
  const site = await siteFor(info.url);
  if (!(site && site.auto)) await restoreZoom(tabId, info.url);
  rebroadcast(tabId);
});

api.tabs.onActivated.addListener(({ tabId }) => badge(tabId, activeTabs.has(tabId)));
