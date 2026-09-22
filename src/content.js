'use strict';
/* Frame Cropper — content script (全フレームで document_start に実行される)
 *
 * 役割はフレームの深さで変わる:
 *   最上位フレーム : 中身 iframe を探し、CSS だけで全画面化 + 他を黒幕で隠す
 *   内側フレーム   : 自分の html/body を 100% に伸ばし、更に内側の iframe/canvas を全画面化
 *
 * 重要: iframe を DOM 上で移動 (appendChild 等) させない。移動すると再読み込みが
 * 走って状態が失われるため、位置合わせは position:fixed だけで行う。
 */
(() => {
  const api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime || !api.runtime.id) return;

  const IS_TOP = (() => { try { return window.top === window; } catch (_) { return false; } })();

  const MIN_W = 200, MIN_H = 150;                    // これ未満の要素は候補から除外
  const SUBFRAME_MIN_W = 400, SUBFRAME_MIN_H = 300;  // 広告 iframe を巻き込まないための下限

  // 広告 / 計測系ホスト。ここに載る iframe は候補から落とす
  const AD_HOST = /(^|\.)(doubleclick\.net|googlesyndication\.com|googletagservices\.com|googletagmanager\.com|google\.com|gstatic\.com|criteo\.(com|net)|rubiconproject\.com|amazon-adsystem\.com|scorecardresearch\.com|i-mobile\.co\.jp|microad\.jp|fout\.jp|yimg\.jp|facebook\.com|facebook\.net)$/i;

  // 語としてほぼ描画面を指す強い手掛かり
  const STRONG_RE = /game[_-]?frame|gameframe|game[_-]?canvas|unity|cocos|pixi|phaser|stage/i;
  // 弱い手掛かり (単独では決め手にしない)
  const WEAK_RE = /\bgame\b|canvas|player/i;
  // 広告・レコメンド枠にありがちな語。当たったら大減点
  const BAD_RE = /(^|[^a-z])(ads?|advert|adframe|banner|promo|recommend|ranking|campaign|notice|news|sns|share|twitter|survey)([^a-z]|$)/i;

  const state = {
    active: false,
    mode: 'auto',        // 'auto' | 'fill' | 'fit'
    strategy: 'auto',    // 'auto' | 'first' | 'largest'  … 対象の選び方
    selector: null,      // 手動で選んだ対象の CSS セレクタ
    stretchFrames: true,
    exitButton: true,
    exitCorner: 'br',    // tr | tl | br | bl
    launcher: false      // このサイトに設定が保存されているか (OFF 時の起動ボタン用)
  };
  let target = null;
  let picking = false;
  let waiter = null;     // 対象出現待ちの MutationObserver + タイマー

  // ---------------------------------------------------------------- 検出
  function isVisible(el) {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  // 手掛かり文字列。src は「ホスト + パスの先頭」だけを見る
  // (クエリ文字列に中身IDや広告IDが紛れて誤爆するのを避ける)
  function hintOf(el) {
    const raw = el.getAttribute('src') || '';
    let srcPart = raw;
    try { const u = new URL(raw, location.href); srcPart = u.hostname + u.pathname; } catch (_) {}
    return [el.id || '', el.getAttribute('name') || '',
      typeof el.className === 'string' ? el.className : '',
      el.getAttribute('title') || '', srcPart].join(' ');
  }

  /* 寸法がまだ決まっていない canvas。width/height 属性が無い canvas は
     HTML の既定である 300x150 になる。自動適用は document_start で走るため、
     中身がサイズを決める前のこの値を掴んでしまうことがある。
     掴むと比率 2:1 のまま拡大され、横長に表示される (実際に踏んだ)。 */
  /* いつまでも待たないための猶予。canvas のサイズを CSS だけで決めて
     width/height 属性を付けない作りだと、「準備中」が永久に真になって
     一度も切り抜かれない。一定時間で諦めて、あるものを使う。 */
  const UNSIZED_GRACE_MS = 3000;
  let waitStarted = 0;

  function isUnsizedCanvas(el) {
    if (el.tagName !== 'CANVAS') return false;
    if (el.hasAttribute('width') || el.hasAttribute('height')) return false;
    return !waitStarted || (Date.now() - waitStarted) < UNSIZED_GRACE_MS;
  }

  function scoreOf(el) {
    const r = rectOf(el);
    if (r.width < MIN_W || r.height < MIN_H) return 0;
    if (!isVisible(el)) return 0;
    if (isUnsizedCanvas(el)) return 0;
    let host = '';
    try { if (el.src) host = new URL(el.src, location.href).hostname; } catch (_) { /* about:blank 等 */ }
    if (host && AD_HOST.test(host)) return 0;

    let s = r.width * r.height;
    const hint = hintOf(el);

    if (STRONG_RE.test(hint)) s *= 6;
    else if (WEAK_RE.test(hint)) s *= 2;
    if (BAD_RE.test(hint)) s *= 0.03;

    // 対象の枠はだいたい最初の一画面に居る。ずっと下にあるものは広告/関連枠の公算が高い
    const topAbs = (r.top === undefined ? 0 : r.top) + window.scrollY;
    if (topAbs > window.innerHeight * 1.5) s *= 0.3;

    // 全画面化を許可している枠はプレイヤーや本体であることが多い
    if (el.hasAttribute('allowfullscreen') || (el.getAttribute('allow') || '').includes('fullscreen')) s *= 1.5;
    if (el.tagName === 'CANVAS' || el.tagName === 'VIDEO') s *= 1.2;
    return s;
  }

  /* 引き伸ばす前の実寸。これが無いと、一度対象にした要素は 100vw×100vh に
     なって面積が最大になり、以後の自動検出で必ず勝ち続ける (自己強化ラッチ)。
     後から本物の対象の枠が現れても乗り換えられなくなるので、元の寸法を覚えておく。 */
  const origSize = new WeakMap();

  function rectOf(el) {
    if (el.classList.contains('ffc-target')) {
      const o = origSize.get(el);
      if (o) return o;
    }
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height, top: r.top };
  }

  // 手掛かり抜きの素の面積。largest 戦略と、手動指定の妥当性チェックに使う
  function sizeScore(el) {
    const r = rectOf(el);
    if (r.width < MIN_W || r.height < MIN_H) return 0;
    if (!isVisible(el)) return 0;
    return r.width * r.height;
  }

  /* 選び方は 3 通り:
       auto    … 面積 × 手掛かりのスコアが最大のもの (既定)
       first   … DOM 上で最初に現れる、十分な大きさの枠
       largest … 手掛かりを無視して純粋に面積が最大のもの */
  function autoDetect() {
    const all = [];
    for (const el of document.querySelectorAll('iframe, canvas, video, embed, object')) {
      if (el.id && el.id.startsWith('ffc-')) continue;
      all.push(el);
    }
    if (state.strategy === 'first') {
      for (const el of all) if (scoreOf(el) > 0) return el;
      // 手掛かり込みで 0 なら、大きささえ足りていれば拾う
      for (const el of all) if (sizeScore(el) > 0) return el;
      return null;
    }
    let best = null, bestScore = 0;
    for (const el of all) {
      const s = state.strategy === 'largest' ? sizeScore(el) : scoreOf(el);
      if (s > bestScore) { bestScore = s; best = el; }
    }
    /* 内側フレームでの保険。対象には box-shadow で周囲を黒く塗るので、
       小さな要素を誤って掴むとフレーム全体が真っ黒になる。
       フレームの 15% も占めない要素は「描画面ではない」と見て掴まない
       (土台の 100% 引き伸ばしだけ行い、中身は中身に任せる)。 */
    if (!IS_TOP && best) {
      const r = rectOf(best);
      const frameArea = window.innerWidth * window.innerHeight;
      if (frameArea > 0 && (r.width * r.height) / frameArea < 0.15) return null;
    }
    return best;
  }

  /* 診断出力用の URL。クエリ文字列を落とす。
     埋め込み元の URL にセッショントークンやアカウントIDが載っていることがあり、
     この一覧は「JSON でコピーして貼る」使い方を想定しているので、
     そのまま出すと公開の場に認証情報を晒すことになる。
     切り分けに要るのは配信元とパスだけなので、そこまでに削る。 */
  function safeUrl(u) {
    try { const x = new URL(u, location.href); return x.origin + x.pathname; }
    catch (_) { return String(u || '').split('?')[0].slice(0, 160); }
  }

  /* 検出候補の一覧。切り抜き中は対象以外が display:none なので、
     採寸の間だけクラスを外す。同期処理のうちに戻すので描画は挟まらない = ちらつかない。 */
  function candidates() {
    const de = document.documentElement;
    const hadActive = de.classList.contains('ffc-active');
    const hadHide = de.classList.contains('ffc-hide-siblings');
    const t = target;
    const hadFit = t && t.classList.contains('ffc-fit');
    if (hadActive) {
      de.classList.remove('ffc-active', 'ffc-hide-siblings');
      if (t) t.classList.remove('ffc-target', 'ffc-fit');
    }

    const out = [];
    try {
      for (const el of document.querySelectorAll('iframe, canvas, video, embed, object')) {
        if (el.id && el.id.startsWith('ffc-')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 90) continue;
        out.push({
          selector: cssPath(el),
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          name: el.getAttribute('name') || '',
          src: safeUrl(el.getAttribute('src') || ''),
          w: Math.round(r.width), h: Math.round(r.height),
          y: Math.round(r.top + window.scrollY),
          score: Math.round(scoreOf(el)),
          current: el === t
        });
      }
    } finally {
      if (hadActive) {
        de.classList.add('ffc-active');
        if (hadHide) de.classList.add('ffc-hide-siblings');
        if (t) { t.classList.add('ffc-target'); if (hadFit) t.classList.add('ffc-fit'); }
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /* 今このフレームで何が対象になっていて、どのモードが効いているか。
     対象が div などだと候補一覧 (iframe/canvas/video のみ) に出ないので、
     これが無いと「何が効いているのか」を誰も確認できない。 */
  function targetInfo() {
    if (!target) return null;
    const o = origSize.get(target);
    const r = target.getBoundingClientRect();
    return {
      tag: target.tagName.toLowerCase(),
      id: target.id || '',
      cls: (typeof target.className === 'string' ? target.className : '')
        .split(/\s+/).filter((c) => c && !c.startsWith('ffc-')).join(' ').slice(0, 60),
      selector: state.selector || '(自動検出)',
      mode: effectiveMode(target),
      natural: o ? [Math.round(o.width), Math.round(o.height)] : null,
      rendered: [Math.round(r.width), Math.round(r.height)],
      zoomRequested: zoomRequested
    };
  }

  function resolveTarget() {
    if (state.selector) {
      let el = null;
      try { el = document.querySelector(state.selector); } catch (_) { /* 壊れたセレクタ */ }
      if (el) {
        /* 手で指定した対象はスコアで弾かない。大きさと可視性だけ見る
           (広告ホスト判定などでスコア 0 になる枠を手で選べなくなるのを防ぐ)。

           ただし、使えない時に「代わりに別の要素を掴む」ことはしない。
           指定された対象が未初期化の canvas だった場合、代わりに掴んだ iframe が
           兄弟要素を display:none にして canvas 自身を隠してしまい、
           隠れたせいで二度と候補に戻れなくなる (実際に固まった)。
           人が指した対象があるなら、準備できるまで待つのが正しい。 */
        if (isUnsizedCanvas(el)) return null;
        return sizeScore(el) > 0 ? el : null;
      }
    }
    /* 「内側のフレームも引き伸ばす」が OFF の内側フレームは、
       人が指したものが実在する時だけ動く。自動検出に落ちると、
       同名ホストの別フレーム (情報パネル等) まで巻き添えで引き伸ばしてしまう。 */
    if (!IS_TOP && !state.stretchFrames) return null;
    return autoDetect();
  }

  /* 候補の並び順。スコア降順だが、記憶済みの対象があればそれを先頭に置く。
     「一度当てたら次からは 1 押しで正解」にするため。 */
  function orderedCandidates() {
    const list = candidates();
    if (!state.selector) return list;
    const i = list.findIndex((c) => c.selector === state.selector);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
    return list;
  }

  /* Alt+Shift+Z の本体。OFF → 候補1 → 候補2 → … → 最後まで行ったら OFF のループ。
     ショートカットを複数覚えなくて済むよう、1 キーに寄せている。 */
  function stepTarget() {
    if (!state.active) {
      pendingAnnounce = true;
      activateTop();
      return { state: 'on' };
    }
    const list = orderedCandidates();
    if (!list.length) { deactivate(); toast('切り抜き OFF'); return { state: 'off' }; }
    const i = list.findIndex((c) => c.current);
    const next = i + 1;
    if (i >= 0 && next >= list.length) {          // 最後の候補の次は OFF
      deactivate();
      toast('切り抜き OFF');
      return { state: 'off' };
    }
    const c = list[i < 0 ? 0 : next];
    state.selector = c.selector;
    stopWaiting();
    clearMarks();
    target = null;
    pendingAnnounce = true;
    waitForTarget();
    return { state: 'on', selector: c.selector };
  }

  /* 今どの候補に居るかを画面上部に出す。切り抜いた枠より前面なので、
     全画面状態でも読める。これが無いと「あと何回押せばOFFか」が分からない。 */
  let toastTimer = null, fadeTimer = null;
  function toast(text) {
    if (!IS_TOP || !document.documentElement) return;
    let t = document.getElementById('ffc-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ffc-toast';
      document.documentElement.appendChild(t);
    }
    t.classList.remove('ffc-fade');
    t.textContent = text;
    clearTimeout(toastTimer); clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => t.classList.add('ffc-fade'), 1300);
    toastTimer = setTimeout(() => t.remove(), 1700);
  }

  let pendingAnnounce = false;
  function announce(el) {
    const list = orderedCandidates();
    const i = list.findIndex((c) => c.current);
    const pos = i >= 0 ? (i + 1) + '/' + list.length + '  ' : '';
    toast(pos + describe(el) + (i >= 0 && i + 1 === list.length ? '  (次で OFF)' : ''));
  }

  // ---------------------------------------------------------------- 適用
  const REPLACED = { IFRAME: 1, CANVAS: 1, VIDEO: 1, EMBED: 1, OBJECT: 1, IMG: 1 };

  const MODES = { fill: 1, fit: 1, zoom: 1, bzoom: 1 };

  function effectiveMode(el) {
    /* iframe は「器」。中身を見せるには広げるのが常に正しく、拡大系のモードは
       意味を持たない。ここを分けないと、モード設定はサイト単位なので
       「canvas を bzoom にしたら、上位の iframe まで自然サイズに戻って
       ズーム倍率が 0.41 に化ける」という壊れ方をする。 */
    if (el.tagName === 'IFRAME') {
      return (state.mode === 'fit') ? 'fit' : 'fill';
    }
    if (MODES[state.mode]) return state.mode;
    // auto:
    //   iframe … 中身がレターボックスを持つことが多いので引き伸ばす
    //   canvas … 素の縦横比しか持たないので比率を保つ (CSS の幅高さを実際に変える
    //            ので clientWidth も追従し、中身の座標計算が壊れない)
    //   その他  … div などは箱を広げても中身が大きくならない。拡大変換は座標が
    //            ズレるので、ブラウザのズームに任せる
    if (el.tagName === 'IFRAME') return 'fill';
    if (REPLACED[el.tagName]) return 'fit';
    return 'bzoom';
  }

  /* ブラウザズームの要求。倍率計算に必要な材料だけ background へ渡す
     (tabs.setZoom はコンテントスクリプトからは呼べない)。 */
  let zoomRequested = false, zoomTimer = 0;
  function requestZoomFit(el, immediate) {
    const o = origSize.get(el);
    if (!o || !(o.width > 0 && o.height > 0)) return;
    clearTimeout(zoomTimer);
    const fire = () => {
      zoomRequested = true;
      api.runtime.sendMessage({
        ffc: true, cmd: 'fitZoom',
        w: o.width, h: o.height, vw: window.innerWidth, vh: window.innerHeight
      }).catch(() => {});
    };
    /* リサイズが止まってから計算する。揺さぶり (1px) の最中の寸法で計算すると、
       その 1px ぶん違う倍率を要求 → ズーム変更 → resize → 揺さぶり … と
       発振して倍率がガタつく。 */
    if (immediate) fire(); else zoomTimer = setTimeout(fire, 250);
  }

  function releaseZoom() {
    /* デバウンス待ちの要求を必ず取り消す。解除後に発火すると
       復元したばかりのズームを上書きし返してしまう。 */
    clearTimeout(zoomTimer);
    zoomTimer = 0;
    zoomRequested = false;
    /* 要求を出したのが自分のフレームとは限らない (最上位が解除を受けても、
       ズームを頼んだのは内側フレーム)。background 側は保存値が無ければ
       何もしないので、無条件に送ってよい。 */
    api.runtime.sendMessage({ ffc: true, cmd: 'restoreZoom' }).catch(() => {});
  }

  /* 拡大モードの倍率と位置を実測して入れる。ウィンドウが変わるたびに呼び直す。
     元の実寸を保ったまま scale するので中の座標系は壊れず、
     CSS 変換は当たり判定にも適用されるのでクリック位置もずれない。 */
  function updateZoom(el) {
    const o = origSize.get(el) || el.getBoundingClientRect();
    const w = o.width, h = o.height;
    if (!(w > 0 && h > 0)) return;
    const k = Math.min(window.innerWidth / w, window.innerHeight / h);
    el.style.setProperty('--ffc-w', String(w));
    el.style.setProperty('--ffc-h', String(h));
    el.style.setProperty('--ffc-k', String(k));
    el.style.setProperty('--ffc-x', String((window.innerWidth - w * k) / 2));
    el.style.setProperty('--ffc-y', String((window.innerHeight - h * k) / 2));
  }

  function clearMarks() {
    if (arObserver) { arObserver.disconnect(); arObserver = null; }
    document.documentElement.classList.remove('ffc-hide-siblings');
    for (const el of document.querySelectorAll('.ffc-target, .ffc-ancestor, .ffc-fit, .ffc-zoom, .ffc-natural')) {
      el.classList.remove('ffc-target', 'ffc-ancestor', 'ffc-fit', 'ffc-zoom', 'ffc-natural');
      if (el.style) {
        for (const v of ['--ffc-ar', '--ffc-w', '--ffc-h', '--ffc-k', '--ffc-x', '--ffc-y']) {
          el.style.removeProperty(v);
        }
      }
    }
  }

  /* 縦横比。canvas は表示サイズではなく描画解像度 (width/height 属性) を使う。
     表示サイズは我々自身が変えてしまうので基準にならないし、中身が解像度を
     変えた時も属性を見ていれば追従できる。 */
  function aspectOf(el, pre) {
    if (el.tagName === 'CANVAS' && el.width > 0 && el.height > 0) return el.width / el.height;
    const r = pre || rectOf(el);
    return (r.width > 0 && r.height > 0) ? r.width / r.height : 16 / 9;
  }

  // 中身が canvas の解像度を変えたら比率を取り直す (切替時の比率で固定されないように)
  let arObserver = null;
  /* canvas の解像度は後から変わる。中身が起動時に自分で決めることが多く、
     こちらが先に測っていると古い値が残る。origSize は一度きりの記録なので、
     属性が変わったら測り直して当て直す。
     これが無いと、掴んだ瞬間の寸法で固定されたまま直らない。 */
  function watchAspect(el) {
    if (arObserver) { arObserver.disconnect(); arObserver = null; }
    if (!el || el.tagName !== 'CANVAS') return;
    arObserver = new MutationObserver(() => {
      if (target !== el) return;
      const w = el.width, h = el.height;
      if (!(w > 0 && h > 0)) return;
      origSize.set(el, { width: w, height: h, top: 0 });
      const m = effectiveMode(el);
      if (m === 'fit') el.style.setProperty('--ffc-ar', String(aspectOf(el)));
      else if (m === 'zoom') updateZoom(el);
      else if (m === 'bzoom') requestZoomFit(el, true);
      kickResize();
    });
    arObserver.observe(el, { attributes: true, attributeFilter: ['width', 'height'] });
  }

  function markTarget(el) {
    clearMarks();
    // 印を付ける前に採寸する。付けた後だと 100vw×100vh になっていて元の比率が分からない
    const pre = el.getBoundingClientRect();
    origSize.set(el, { width: pre.width, height: pre.height, top: pre.top });
    target = el;
    el.classList.add('ffc-target');
    // 兄弟要素の非表示は iframe が対象の時だけ (canvas の兄弟は中身のUIかもしれない)。
    // canvas の場合は代わりに黒幕を対象の真下に差し込んで透けを止める。
    document.documentElement.classList.toggle('ffc-hide-siblings', el.tagName === 'IFRAME');
    const m = effectiveMode(el);
    if (m === 'fit') {
      el.style.setProperty('--ffc-ar', String(aspectOf(el, pre)));
      el.classList.add('ffc-fit');
    } else if (m === 'zoom') {
      el.classList.add('ffc-zoom');
      updateZoom(el);
    } else if (m === 'bzoom') {
      // 大きさには触らない。中央に置くだけで、拡大はブラウザズームに任せる
      el.classList.add('ffc-natural');
      requestZoomFit(el, true);
    }
    watchAspect(el);
    // 祖先の transform/filter を無効化 (fixed の基準枠を奪われないように)
    for (let p = el.parentElement; p; p = p.parentElement) p.classList.add('ffc-ancestor');
    // 内側フレームで「対象が決まってから土台を触る」経路の分
    if (!IS_TOP) document.documentElement.classList.add('ffc-fill-root', 'ffc-active');
    liftOverlays();
    if (IS_TOP && pendingAnnounce) { pendingAnnounce = false; announce(el); }
  }

  /* 対象が決まるまでの間だけ使う黒幕 (<html> 直下)。
     対象が決まった後の「周囲の塗りつぶし」は .ffc-target の box-shadow が担う。
     <html> の子として足すので、サイトのコンポーネントツリーには触れない。 */
  /* 自前の重ね合わせ要素を <html> の末尾へ移す。
     document_start (自動切り抜き) では <body> がまだ無いので、そこに差し込むと
     後から追加された <body> より前に残る。終了ボタンと対象は z-index が同値で、
     同値のときは DOM 順で後にある方が上に来るため、そのままだと
     対象が終了ボタンを覆って押せなくなる (実測で確認)。
     黒幕は z-index が 1 つ下なので、順序に関係なく対象より下に来る。 */
  function liftOverlays() {
    const de = document.documentElement;
    if (!de) return;
    /* 対象を id で列挙すると、要素を足した時に追加し忘れる (実際 ffc-shot で踏んだ)。
       <html> 直下にある自前の要素を id の接頭辞で拾い、列挙をやめる。 */
    for (const el of Array.from(de.children)) {
      if (el.id && el.id.startsWith('ffc-') && el.nextSibling) de.appendChild(el);
    }
  }

  function backdrop(on) {
    const d = document.getElementById('ffc-backdrop');
    if (on) {
      if (!d && document.documentElement) {
        const n = document.createElement('div');
        n.id = 'ffc-backdrop';
        document.documentElement.appendChild(n);
      }
    } else if (d) {
      d.remove();
    }
  }

  /* 画面隅の常設ボタン。kind で役割が変わる:
       'exit'   … 切り抜き中。押すと解除
       'launch' … OFF だが設定済みのサイト。押すと切り抜き開始
       null     … 出さない
     同じ位置でアイコンだけ入れ替えるので、ショートカットを覚えなくても
     ON / OFF を往復できる。最上位フレームにだけ置く。 */
  function cornerButton(kind) {
    if (!IS_TOP || !document.documentElement) return;
    const b = document.getElementById('ffc-exit');
    if (!kind) { if (b) b.remove(); return; }
    const cls = 'ffc-' + (state.exitCorner || 'br') + (kind === 'launch' ? ' ffc-launch' : '');
    if (b && b.dataset.ffcKind === kind) { b.className = cls; return; }
    if (b) b.remove();

    const n = document.createElement('div');
    n.id = 'ffc-exit';
    n.dataset.ffcKind = kind;
    n.className = cls;                    // アイコンは CSS 側の SVG で描く
    const label = kind === 'launch' ? '切り抜きを開始' : '切り抜きを終了';
    n.title = label;
    n.setAttribute('role', 'button');
    n.setAttribute('aria-label', label);
    n.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (kind === 'launch') {
        api.runtime.sendMessage({ ffc: true, cmd: 'launch' }).catch(() => {});
      } else {
        deactivate();
        api.runtime.sendMessage({ ffc: true, cmd: 'deactivated' }).catch(() => {});
      }
    }, true);
    document.documentElement.appendChild(n);
    liftOverlays();
  }

  /* スクリーンショットのボタン。切り抜き中だけ、終了ボタンの隣に出す。 */
  function shotButton(on) {
    if (!IS_TOP || !document.documentElement) return;
    const b = document.getElementById('ffc-shot');
    if (!on) { if (b) b.remove(); return; }
    if (b) { b.className = 'ffc-' + (state.exitCorner || 'br'); return; }
    const n = document.createElement('div');
    n.id = 'ffc-shot';
    n.className = 'ffc-' + (state.exitCorner || 'br');
    n.title = '表示中の範囲を画像で保存';
    n.setAttribute('role', 'button');
    n.setAttribute('aria-label', '表示中の範囲を画像で保存');
    n.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      api.runtime.sendMessage({ ffc: true, cmd: 'shot' })
        .then((res) => { if (res && res.error) toast('撮影に失敗: ' + res.error); })
        .catch(() => {});
    }, true);
    document.documentElement.appendChild(n);
    liftOverlays();
  }

  /* 撮影の段取り。撮る直前に自前の UI を隠さないと写り込む。
     visibility で隠すのは、レイアウトを動かさないため。 */
  function shotPrepare(on) {
    document.documentElement.classList.toggle('ffc-shooting', !!on);
  }

  /* 切り抜く範囲。中間フレームはすべて 100vw×100vh に広げてあるので、
     最深フレームでの座標がそのまま最上位の座標になる。
     これで入れ子を跨いだ座標変換が要らない。 */
  function shotRect() {
    if (!target) return { ffc: true, rect: null, isTop: IS_TOP };
    const r = target.getBoundingClientRect();
    return {
      ffc: true, isTop: IS_TOP,
      isIframe: target.tagName === 'IFRAME',
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      vw: window.innerWidth, vh: window.innerHeight
    };
  }

  /* 受け取った画像を保存する。downloads 権限は使わない —
     自己ホストの拡張機能で権限を増やすと、更新のたびに各端末で
     許可のし直しが要る (自動更新が止まる)。
     Blob と <a download> なら追加権限なしで保存ダイアログが出せる。 */
  function saveShot(dataUrl) {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const name = 'frame-cropper-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate())
      + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.png';
    fetch(dataUrl).then((r) => r.blob()).then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      toast('保存: ' + name);
    }).catch((e) => toast('保存に失敗: ' + e.message));
  }

  // 解除後も、設定済みサイトなら起動ボタンを出しておく
  function idleButton() {
    cornerButton(state.exitButton && state.launcher ? 'launch' : null);
    shotButton(false);   // 切り抜いていない時は撮る対象が無い
  }

  /* 中身に「窓の大きさが変わった」と伝える。起動済みのエンジンを再レイアウトさせる用。

     中身がいつ寸法を読むか分からないので数回に分けて叩くが、
     毎回無条件に投げると、寸法が変わっていなくてもそのたびに再レイアウトが走り、
     切り抜いた直後に画面が数回揺れる。
     そこで「前回通知した寸法と違う時だけ」投げる。レイアウトが落ち着いていれば
     1 回で済み、まだ動いている間だけ追加で通知される。 */
  let lastKick = '';

  function sizeStamp() {
    let t = '';
    if (target) {
      const r = target.getBoundingClientRect();
      t = ':' + Math.round(r.width) + 'x' + Math.round(r.height);
    }
    return window.innerWidth + 'x' + window.innerHeight + t;
  }

  function kickResize() {
    for (const d of [0, 150, 500, 1200]) {
      setTimeout(() => {
        const now = sizeStamp();
        if (now === lastKick) return;   // 寸法が変わっていないなら黙る
        lastKick = now;
        fireResize();
        if (IS_TOP) relayDown();
      }, d);
    }
  }

  function fireResize() {
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
  }

  /* 下のフレームへ「寸法が変わった」を伝える。クロスオリジンだと
     childWindow.dispatchEvent は呼べないので postMessage で中継し、
     受けた側のコンテントスクリプトが自分の window に resize を投げ直す。 */
  function relayDown() {
    for (const fr of document.querySelectorAll('iframe')) {
      try { if (fr.contentWindow) fr.contentWindow.postMessage({ __ffc: 'resized' }, '*'); } catch (_) {}
    }
  }

  /* インラインスタイルを一時的に上書きして元に戻すための小道具。
     サイトが元から付けていたインライン値を壊さないよう、優先度ごと退避する。 */
  function withTempStyle(el, props, frames) {
    const saved = props.map(([name]) => [name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]);
    for (const [name, value] of props) el.style.setProperty(name, value, 'important');
    let n = frames || 2;
    const restore = () => {
      if (--n > 0) { requestAnimationFrame(restore); return; }
      for (const [name, value, prio] of saved) {
        if (value) el.style.setProperty(name, value, prio); else el.style.removeProperty(name);
      }
    };
    requestAnimationFrame(restore);
  }

  /* ウィンドウのリサイズ追従。
     枠自体は 100vw/100vh なので CSS だけで追従する。問題は中の中身が
     「最初に読んだ寸法」を握ったままになること。クロスオリジンなので
     childWindow.dispatchEvent() は呼べず、postMessage で中継するしかない。

     設計上の肝は「駆動するのは最上位フレームだけ」という点:
     各階層が自分のタイマーで揺さぶると、親の 1px 変更が子の resize を呼び、
     子が 200ms 後に自分を揺さぶり…と連鎖して発振が止まらなくなる。
     下層は中継メッセージを受けた時だけ反応する受動側に徹する。 */
  const RELAY_THROTTLE = 250;   // ドラッグ中の中継間隔 (毎フレームだと中身が描き直し続けて震える)
  const SETTLE_DELAY = 200;     // リサイズが止まったとみなすまで
  let lastRelay = 0, settleTimer = 0;

  function onWindowResize() {
    if (!state.active) return;
    if (target && target.classList.contains('ffc-zoom')) updateZoom(target);
    if (target && target.classList.contains('ffc-natural')) requestZoomFit(target);
    if (!IS_TOP) return;
    const now = Date.now();
    if (now - lastRelay > RELAY_THROTTLE) { lastRelay = now; relayDown(); }
    clearTimeout(settleTimer);
    settleTimer = setTimeout(afterResizeSettled, SETTLE_DELAY);
  }

  function afterResizeSettled() {
    if (!state.active || !IS_TOP) return;
    const el = target;
    /* bzoom を使っているサイトでは揺さぶらない。
       このモードは要素の寸法を一切変えないので揺さぶる必要が無く、
       逆に内側フレームのズーム再計算を叩いて発振の種になる。 */
    if (state.mode === 'bzoom') { relayDown(); return; }
    if (el && effectiveMode(el) === 'fill') {
      /* 合成 resize を無視して実寸だけ見るエンジン (ResizeObserver 系) 向けの一撃。
         縮めると縁に黒線が一瞬出るので、逆に 1px 広げる。
         html は overflow:hidden なのではみ出た分は切り取られ、見た目には出ない。 */
      withTempStyle(el, [['width', 'calc(100vw + 1px)'], ['height', 'calc(100vh + 1px)']], 2);
    }
    lastRelay = Date.now();
    relayDown();
    setTimeout(() => { if (state.active) relayDown(); }, 150);  // 揺さぶりが戻った後に確定値で
  }

  window.addEventListener('resize', onWindowResize, true);

  // 親フレームからの中継を受けて、自分の window に resize を投げ直し、更に下へ流す
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.__ffc) return;
    if (e.data.__ffc === 'pick') { startPicking(); return; }
    if (e.data.__ffc === 'resized' && state.active) { fireResize(); relayDown(); }
  }, false);

  function activateTop() {
    state.active = true;
    document.documentElement.classList.add('ffc-active');
    backdrop(true);                 // 対象が見つかる前に先に黒幕を出す (バナーを一瞬も見せない)
    cornerButton(state.exitButton ? 'exit' : null);
    shotButton(state.exitButton);
    waitForTarget();
  }

  function activateSubframe() {
    // このフレーム用に人が選んだ対象があるなら、自動判定の遠慮は要らない。
    // 「内側フレームは触らない」設定でも、手で指したものは必ず適用する。
    const manual = !!state.selector;
    if (!state.stretchFrames && !manual) return;
    // 広告のような小さいフレームは触らない (手動指定時を除く)
    if (!manual && (window.innerWidth < SUBFRAME_MIN_W || window.innerHeight < SUBFRAME_MIN_H)) return;
    state.active = true;
    if (!state.stretchFrames) { waitForTarget(); return; }  // 対象が決まってから土台を触る
    document.documentElement.classList.add('ffc-fill-root', 'ffc-active');
    backdrop(true);          // 内側フレームでも、対象が決まるまでは黒地にしておく
    waitForTarget();
    kickResize();
  }

  function waitForTarget(timeoutMs = 30000) {
    stopWaiting();
    waitStarted = Date.now();
    const attempt = () => {
      if (!state.active) { stopWaiting(); return true; }
      const el = resolveTarget();
      if (el && el !== target) { markTarget(el); kickResize(); }
      return !!el;
    };
    attempt();
    if (!document.documentElement) return;
    const obs = new MutationObserver(attempt);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // SPA は属性変更だけでサイズが決まることもあるので、保険でポーリングも回す
    const iv = setInterval(attempt, 600);
    const to = setTimeout(() => {
      stopWaiting();
      // 何も見つからないまま時間切れ → 真っ黒で固まらないよう黒幕を外す
      if (IS_TOP && state.active && !target) deactivate();
    }, timeoutMs);
    waiter = { obs, iv, to };
  }

  function stopWaiting() {
    if (!waiter) return;
    waiter.obs.disconnect();
    clearInterval(waiter.iv);
    clearTimeout(waiter.to);
    waiter = null;
  }

  function deactivate() {
    lastSig = '';
    lastKick = '';
    stopWaiting();
    releaseZoom();
    clearMarks();
    document.documentElement.classList.remove('ffc-active', 'ffc-fill-root', 'ffc-hide-siblings');
    backdrop(false);
    target = null;
    state.active = false;
    idleButton();          // OFF でも設定済みサイトなら起動ボタンを残す
    kickResize();
  }

  /* フレームの識別キー。ホスト名だけだと、同じホストにぶら下がる別フレーム
     (/a/main.html と /a/sub/panel.html のような構成) を取り違える。
     パスまで含めて区別する。クエリは可変なので含めない。 */
  function frameKey() { return location.hostname + location.pathname; }

  /* 同じ指示が撒き直されただけなら何もしない。
     background は「後から生えるフレームに届ける」ため 300〜8000ms に同じ apply を
     5 回送る。毎回 clearMarks → 再採寸 → 再適用すると、その都度
     枠が素の寸法に戻ってから切り抜き寸法に戻る reflow が起きて画面がガタつく
     (bzoom ではズーム再計算まで巻き込む)。 */
  let lastSig = '';

  function applyMessage(msg) {
    if (msg.announce) pendingAnnounce = true;
    const sig = JSON.stringify([msg.siteKey, msg.mode, msg.strategy, msg.selector,
      msg.sub || null, msg.stretchFrames, msg.exitButton, msg.exitCorner]);
    if (state.active && target && sig === lastSig) {
      if (pendingAnnounce) { pendingAnnounce = false; announce(target); }
      return;
    }
    lastSig = sig;
    state.mode = msg.mode || 'auto';
    state.strategy = msg.strategy || 'auto';
    // 最上位はサイト用のセレクタ、内側フレームは自分のホスト用に保存されたものを使う
    state.selector = IS_TOP
      ? (msg.selector || null)
      : ((msg.sub && (msg.sub[frameKey()] || msg.sub[location.hostname])) || null);
    state.stretchFrames = msg.stretchFrames !== false;
    state.exitButton = msg.exitButton !== false;
    state.exitCorner = msg.exitCorner || 'br';
    state.launcher = !!msg.launcher;
    if (state.active) {
      // 設定変更の再適用: 対象を選び直す
      stopWaiting();
      target = null;
      clearMarks();
      if (IS_TOP) { cornerButton(state.exitButton ? 'exit' : null); shotButton(state.exitButton); }
      waitForTarget();
      return;
    }
    if (IS_TOP) activateTop(); else activateSubframe();
  }

  // ---------------------------------------------------------- 要素ピッカー
  function cssPath(el) {
    if (el.id && !el.id.startsWith('ffc-')) {
      const sel = '#' + CSS.escape(el.id);
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) {}
    }
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 8; e = e.parentElement) {
      if (e.id && !e.id.startsWith('ffc-')) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let sel = e.tagName.toLowerCase();
      const parent = e.parentElement;
      if (parent) {
        const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === e.tagName);
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(e) + 1) + ')';
      }
      parts.unshift(sel);
      if (!e.parentElement || e.parentElement === document.body) break;
    }
    return parts.join(' > ');
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    return el.tagName.toLowerCase()
      + (el.id ? '#' + el.id : '')
      + ' ' + Math.round(r.width) + '×' + Math.round(r.height);
  }

  function reactivate() { if (IS_TOP) activateTop(); else activateSubframe(); }

  function startPicking() {
    if (picking) return;
    picking = true;

    // 切り抜き中だと「間違って選ばれた iframe」が画面全面を覆っていて、
    // 結局それしかクリックできない。選び直せるよう、採取の間だけ素のページに戻す。
    const wasActive = state.active;
    if (wasActive) {
      stopWaiting();
      clearMarks();
      document.documentElement.classList.remove('ffc-active', 'ffc-fill-root', 'ffc-hide-siblings');
      backdrop(false);
      cornerButton(null);      // ピッカー中はボタンを出さない (誤爆防止)
      shotButton(false);
      target = null;
      state.active = false;
    }

    const catcher = document.createElement('div');
    catcher.id = 'ffc-catcher';
    const hl = document.createElement('div');
    hl.id = 'ffc-highlight';
    const hint = document.createElement('div');
    hint.id = 'ffc-hint';
    hint.textContent = IS_TOP
      ? 'クリック: 枠なら中に入る / Shift+クリック: その枠を対象に / Esc 中止'
      : 'クリックでこのフレームの対象を決定 / Esc 中止';
    document.documentElement.append(catcher, hl, hint);

    let current = null;

    // クロスオリジン iframe はマウスイベントを飲むので、透明な捕捉層を最前面に置き、
    // 座標から下の要素を elementsFromPoint で引く (自前の ffc-* は読み飛ばす)。
    const under = (x, y) => {
      for (const e of document.elementsFromPoint(x, y)) {
        if (e.id && e.id.startsWith('ffc-')) continue;
        return e;
      }
      return null;
    };

    const onMove = (e) => {
      const el = under(e.clientX, e.clientY);
      if (!el || el === current) return;
      current = el;
      const r = el.getBoundingClientRect();
      hl.style.left = r.left + 'px';
      hl.style.top = r.top + 'px';
      hl.style.width = r.width + 'px';
      hl.style.height = r.height + 'px';
      hint.textContent = describe(el)
        + (el.tagName === 'IFRAME' ? '  —  クリックで中へ / Shift+クリックでこの枠に決定'
                                   : '  —  クリックで決定')
        + ' / Esc 中止';
    };

    const onClick = (e) => {
      e.preventDefault(); e.stopPropagation();
      finish(under(e.clientX, e.clientY), e.shiftKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    };

    function finish(el, shift) {
      picking = false;
      catcher.remove(); hl.remove(); hint.remove();
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('keydown', onKey, true);
      catcher.removeEventListener('click', onClick, true);
      if (!el) {
        if (wasActive) reactivate();   // Esc で中止 → 元の切り抜き状態に戻す
        return;
      }
      const sel = cssPath(el);
      state.selector = sel;
      api.runtime.sendMessage({
        ffc: true, cmd: 'picked', selector: sel, isTop: IS_TOP, frameKey: frameKey()
      }).catch(() => {});
      reactivate();

      /* クロスオリジンの枠は外側から中を覗けないので、選択そのものを中へ渡す。
         枠を全画面にしてから、その中のコンテントスクリプトにピッカーを始めさせる。
         Shift+クリックなら降りずにその枠で確定する。 */
      if (!shift && el.tagName === 'IFRAME' && el.contentWindow) {
        setTimeout(() => {
          try { el.contentWindow.postMessage({ __ffc: 'pick' }, '*'); } catch (_) {}
        }, 60);
      }
    }

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    catcher.addEventListener('click', onClick, true);
  }

  // ------------------------------------------------------------ メッセージ
  api.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.ffc) return;
    switch (msg.cmd) {
      case 'apply':
        applyMessage(msg);
        break;
      case 'clear':
        deactivate();
        break;
      case 'pick':
        startPicking();
        break;
      case 'candidates':
        // 最上位フレームだけが答える (background は frameId:0 指定で送る)
        return Promise.resolve({
          ffc: true, list: candidates(), url: safeUrl(location.href), isTop: IS_TOP,
          active: state.active, stretched: document.documentElement.classList.contains('ffc-fill-root'),
          mode: state.mode, stretchFrames: state.stretchFrames,
          targetInfo: targetInfo(),
          viewport: [window.innerWidth, window.innerHeight]
        });
      case 'setTarget':
        // このフレームの対象を選び直す (内側フレームの誤検出を人手で直す口)
        state.selector = msg.selector || null;
        stopWaiting();
        clearMarks();
        target = null;
        if (!state.active) { if (IS_TOP) activateTop(); else activateSubframe(); }
        else waitForTarget();
        return Promise.resolve({ ffc: true, ok: true });
      case 'shotPrepare':
        shotPrepare(msg.on);
        return Promise.resolve({ ffc: true, ok: true });
      case 'shotRect':
        return Promise.resolve(shotRect());
      case 'shotSave':
        if (IS_TOP) saveShot(msg.dataUrl);
        break;
      case 'step':
        if (!IS_TOP) return undefined;
        return Promise.resolve({ ffc: true, picked: stepTarget() });
      case 'ping':
        return Promise.resolve({ ffc: true, active: state.active, hasTarget: !!target });
      default:
        break;
    }
    return undefined;
  });

  // Esc で解除 (最上位ドキュメントにフォーカスがある時のみ効く。
  //  中身 iframe にフォーカスが居る時は Alt+Shift+Z / ツールバーから抜ける)
  window.addEventListener('keydown', (e) => {
    if (!state.active || picking || !IS_TOP) return;
    if (e.key !== 'Escape') return;
    deactivate();
    api.runtime.sendMessage({ ffc: true, cmd: 'deactivated' }).catch(() => {});
  }, true);

  // 読み込み時に「このタブは今 切り抜き中か?」を background に問い合わせる。
  // 遅れて生成される iframe もこれで自力で追従できる。
  api.runtime.sendMessage({ ffc: true, cmd: 'query' })
    .then((res) => {
      if (!res || !res.ffc) return;
      if (res.cmd === 'apply') { applyMessage(res); return; }
      // 切り抜きはしないが、設定済みサイトなら起動ボタンだけ置く
      state.exitButton = res.exitButton !== false;
      state.exitCorner = res.exitCorner || 'br';
      state.launcher = !!res.launcher;
      idleButton();
    })
    .catch(() => {});
})();
