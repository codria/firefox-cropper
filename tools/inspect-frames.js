/* ===========================================================================
 * ページ構造の調査スニペット (テキストのみ出力・画像は一切取得しない)
 *
 * 使い方:
 *   1. ログイン済みの Firefox で対象ページを開く
 *   2. F12 → コンソール。初回は "貼り付けを許可" と入力を求められる
 *   3. このファイルの中身を丸ごと貼って Enter
 *   4. 出た表 / JSON をそのまま貼り返してもらえれば、対象の絞り込みに使えます
 *
 * 内側のフレームを調べたい時は、開発ツール上部の
 * 「フレームを選択」ボタン (□が重なったアイコン) でコンテキストを切り替えてから
 * もう一度実行してください。クロスオリジンなので外側からは中を覗けません。
 * ========================================================================= */
(() => {
  const rows = [];
  const px = (n) => Math.round(n);

  /* クエリ文字列は落とす。埋め込み元の URL にセッショントークンや
     アカウントIDが載っていることがあり、出力をそのまま貼ると認証情報を
     晒すことになる。切り分けには配信元とパスで足りる。 */
  const safeUrl = (u) => {
    try { const x = new URL(u, location.href); return x.origin + x.pathname; }
    catch (_) { return String(u || '').split('?')[0].slice(0, 120); }
  };

  for (const el of document.querySelectorAll('iframe, canvas, video, embed, object')) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    rows.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      name: el.getAttribute('name') || '',
      class: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
      w: px(r.width),
      h: px(r.height),
      x: px(r.left),
      y: px(r.top),
      area: px(r.width * r.height),
      display: cs.display,
      src: safeUrl(el.getAttribute('src') || '')
    });
  }
  rows.sort((a, b) => b.area - a.area);

  console.log('%c--- 埋め込み要素 (面積の大きい順) ---', 'font-weight:bold');
  console.table(rows);

  // 一番大きい要素の祖先チェーン。position:fixed の基準枠を奪う
  // transform / filter / contain が付いていないかを見る。
  const biggest = [...document.querySelectorAll('iframe, canvas, video')]
    .map((el) => [el, el.getBoundingClientRect()])
    .filter(([, r]) => r.width > 200 && r.height > 150)
    .sort((a, b) => b[1].width * b[1].height - a[1].width * a[1].height)[0];

  if (!biggest) {
    console.log('大きな埋め込み要素が見つかりませんでした。');
    return;
  }

  const chain = [];
  for (let e = biggest[0]; e; e = e.parentElement) {
    const cs = getComputedStyle(e);
    chain.push({
      tag: e.tagName.toLowerCase(),
      id: e.id || '',
      class: (typeof e.className === 'string' ? e.className : '').slice(0, 40),
      position: cs.position,
      overflow: cs.overflow,
      transform: cs.transform === 'none' ? '' : cs.transform.slice(0, 30),
      filter: cs.filter === 'none' ? '' : cs.filter.slice(0, 20),
      contain: cs.contain === 'none' ? '' : cs.contain,
      zIndex: cs.zIndex
    });
  }
  console.log('%c--- 最大要素の祖先チェーン (transform/filter/contain が要注意) ---', 'font-weight:bold');
  console.table(chain);

  const out = { url: safeUrl(location.href), viewport: [innerWidth, innerHeight], elements: rows, ancestors: chain };
  console.log('%c--- コピペ用 JSON (下の文字列を選択してコピー) ---', 'font-weight:bold');
  console.log(JSON.stringify(out, null, 1));
  return out;
})();
