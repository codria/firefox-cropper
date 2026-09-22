'use strict';
/* Frame Cropper — background (常駐ページ)
 *
 * タブごとの ON/OFF を握り、全フレームへ指示を配る係。
 * tabs.sendMessage は frameId を省くとタブ内の全フレームに配送される性質を使う。
 */
const api = globalThis.browser || globalThis.chrome;

const DEFAULTS = {
  mode: 'auto',          // auto | fill | fit
  strategy: 'auto',      // auto | first | largest … 対象の選び方
  stretchFrames: true,   // 内側フレームも 100% に伸ばす
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

async function restoreZoom(tabId) {
  if (!savedZoom.has(tabId)) return;
  const z = savedZoom.get(tabId);
  savedZoom.delete(tabId);
  /* 2 つを別々の try に分ける。ひとつの try にまとめると、
     scope を戻すのに失敗した時点で肝心の倍率復元が実行されないまま
     握りつぶされてしまう (ズームが掛かりっぱなしで残る)。 */
  try { await api.tabs.setZoomSettings(tabId, { scope: 'per-origin' }); }
  catch (e) { note(tabId, { at: stamp(), result: '復元: scope 戻し失敗 ' + e.message }); }
  try { await api.tabs.setZoom(tabId, z); note(tabId, { at: stamp(), result: '復元 → ' + z }); }
  catch (e) { note(tabId, { at: stamp(), error: '復元失敗: ' + e.message }); }
}

function stamp() { return new Date().toISOString().slice(11, 19); }

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
  const cur = await api.storage.sync.get(['sites', 'settings']);
  if (cur.sites || cur.settings) return;
  const old = await api.storage.local.get(['sites', 'settings']);
  if (!old.sites && !old.settings) return;
  await api.storage.sync.set(old);
}

/* 移行が終わるまで読み書きを待たせる。待たないと、移行中の読み取りが
   空の sync を見てしまい「設定が消えた」ように見える。 */
/* 旧レイアウト (sites に全部入り) を 1 サイト 1 項目へ分割する。
   分割後も getSites() は両方を読むので、片方の端末が古いままでも壊れない。 */
async function splitSites() {
  const all = await STORE.get('sites');
  if (!all.sites || !Object.keys(all.sites).length) return;
  const obj = {};
  for (const k of Object.keys(all.sites)) obj[SITE_PREFIX + k] = all.sites[k];
  await STORE.set(obj);
  await STORE.remove('sites');
}

const storeReady = migrateToSync()
  .then(splitSites)
  .catch((e) => { storeError = '移行: ' + e.message; });

/* どちらの保存領域に何件入っているかを返す。
   同期が効いていない時、原因は「sync に書けていない」「sync にはあるが
   端末に降りてきていない」のどちらか。件数を見比べれば切り分けられる。
   サイトのキー自体は URL なので、件数だけを返して中身は出さない。 */
async function syncStatus() {
  /* 新旧どちらのレイアウトも数える。旧キー (sites) だけを見ていると、
     splitSites で s:<キー> に分割した後は常に 0 と表示され、
     「同期が効いていない」と誤診する材料になる。 */
  const count = async (area) => {
    try {
      const all = await api.storage[area].get(null);
      const keys = new Set(Object.keys(all.sites || {}));
      for (const k of Object.keys(all)) {
        if (k.startsWith(SITE_PREFIX)) keys.add(k.slice(SITE_PREFIX.length));
      }
      return keys.size;
    } catch (_) { return null; }
  };
  return {
    enabled: SYNCED,
    error: storeError,
    syncCount: await count('sync'),
    localCount: await count('local'),
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
    || (site.sub && Object.keys(site.sub).length));
}

async function siteFor(url) {
  const sites = await getSites();
  return sites[siteKeyOf(url)] || sites[hostOf(url)] || {};
}

async function getSettings() {
  await storeReady;
  const got = await STORE.get('settings');
  return Object.assign({}, DEFAULTS, got.settings || {});
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
    mode: site.mode || s.mode,
    strategy: site.strategy || s.strategy,
    selector: site.selector || null,
    sub: site.sub || {},
    stretchFrames: s.stretchFrames,
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
    await restoreZoom(tab.id);                   // ブラウザズームを元に戻す
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

function deactivate(tabId) {
  activeTabs.delete(tabId);
  send(tabId, { ffc: true, cmd: 'clear' });
  restoreZoom(tabId);
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
      if (!savedZoom.has(tabId)) {
        savedZoom.set(tabId, cur);
        // per-tab にしておかないと、このサイトの既定ズームを書き換えてしまう
        try { await api.tabs.setZoomSettings(tabId, { scope: 'per-tab' }); }
        catch (e) { log.scopeWarn = e.message; }
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

    // 隅の起動ボタンから ON にする
    case 'launch':
      if (tabId != null && tab) await activate(tabId, tab.url, true);
      return undefined;

    case 'restoreZoom':
      if (tabId != null) await restoreZoom(tabId);
      return undefined;

    // ページ内 (Esc / ×ボタン) から解除された
    case 'deactivated':
      if (tabId != null) {
        activeTabs.delete(tabId);
        send(tabId, { ffc: true, cmd: 'clear' });
        await restoreZoom(tabId);      // ここが抜けていて × / Esc だけ戻らなかった
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
        sync: await syncStatus()
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
      const s = Object.assign(await getSettings(), msg.patch);
      await storeSet({ settings: s });
      if (msg.tab) await reapply(msg.tab.id, msg.tab.url);
      return { ffc: true, settings: s };
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
      const obj = { settings: Object.assign({}, local.settings || {}, cur.settings || {}) };
      for (const k of Object.keys(merged)) obj[SITE_PREFIX + k] = merged[k];
      await storeSet(obj);
      return { ffc: true, restored: Object.keys(merged).length };
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
api.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading' || !info.url) return;
  tabFrames.delete(tabId);          // 読み込み直しで frameId は振り直される
  const cur = activeTabs.get(tabId);
  if (!cur) return;
  // 別の中身 (パスが違う) へ移ったら状態を落とす
  if (siteKeyOf(info.url) !== cur.siteKey) deactivate(tabId);
  else rebroadcast(tabId);
});

api.tabs.onActivated.addListener(({ tabId }) => badge(tabId, activeTabs.has(tabId)));
