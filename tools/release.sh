#!/usr/bin/env bash
#
# リリース一括実行。
#
#   bash tools/release.sh 0.3.0
#
# 手作業だと 4 ステップあり、特に順序を間違えやすい:
#   updates.json を Release 作成より先に push すると、その間 Firefox が
#   「存在しない .xpi」を指す更新情報を読むことになる。
#   そのため commit を 2 つに分け、Release を作ってから updates.json を送る。
#
# 前提: gh にログイン済み / ~/.web-ext-config.cjs に AMO の API 資格情報

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: bash tools/release.sh <version>    例: bash tools/release.sh 0.3.0" >&2
  exit 1
fi
if ! printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: バージョンは x.y.z 形式で指定してください (指定値: $VERSION)" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
XPI="web-ext-artifacts/frame-cropper-${VERSION}.xpi"
TAG="v${VERSION}"

# ---- 事前チェック。途中で失敗すると中途半端な状態が残るので先に全部見る ----
if [ -n "$(git status --porcelain)" ]; then
  echo "error: コミットされていない変更があります。先に整理してください" >&2
  git status --short >&2
  exit 1
fi
CURRENT="$(node -e 'process.stdout.write(require("./manifest.json").version)')"
if [ "$VERSION" = "$CURRENT" ]; then
  echo "error: 現在のバージョンと同じです ($CURRENT)。AMO は同一バージョンの再署名を拒否します" >&2
  exit 1
fi
# 番号は必ず増やす方向で。小さいと Firefox が更新と見なさない
LOWER="$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | head -1)"
if [ "$LOWER" = "$VERSION" ]; then
  echo "error: $VERSION は現在の $CURRENT より小さい値です" >&2
  exit 1
fi
if git ls-remote --tags origin "refs/tags/$TAG" | grep -q .; then
  echo "error: タグ $TAG は既に存在します" >&2
  exit 1
fi

echo "==> $CURRENT -> $VERSION"

# ---- 1. manifest のバージョンを上げる (整形を変えないよう行置換) ----
node -e '
  const fs = require("fs");
  const p = "manifest.json";
  const s = fs.readFileSync(p, "utf8");
  const v = process.argv[1];
  const out = s.replace(/"version":\s*"[^"]*"/, `"version": "${v}"`);
  if (out === s) { console.error("manifest.json の version を置換できませんでした"); process.exit(1); }
  fs.writeFileSync(p, out);
' "$VERSION"

# ---- 2. 署名 (AMO の自動検証 → 署名。数十秒〜数分かかる) ----
echo "==> 署名中 (AMO の検証待ち)"
npx --yes web-ext sign --channel=unlisted

SIGNED="$(ls -t web-ext-artifacts/*-"${VERSION}".xpi 2>/dev/null | head -1 || true)"
if [ -z "$SIGNED" ]; then
  echo "error: 署名済み .xpi が見つかりません" >&2
  exit 1
fi
cp "$SIGNED" "$XPI"

# ---- 3. manifest を先に push。タグはこのコミットに付く ----
git add manifest.json
git commit -q -m "Release v${VERSION}"
git push -q origin main

# ---- 4. Release を作る。updates.json が指す先を先に実在させる ----
echo "==> Release $TAG を作成"
gh release create "$TAG" "$XPI" --title "$TAG" \
  --notes "署名済みの \`.xpi\` を添付しています。

新規PCでは一度だけ \`about:addons\` にドラッグしてください。
インストール済みの環境は Firefox が自動で更新します。"

# ---- 5. updates.json を Release の後に push ----
node -e '
  const fs = require("fs");
  const p = "updates.json";
  const v = process.argv[1], repo = process.argv[2];
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  const id = Object.keys(d.addons)[0];
  d.addons[id].updates = [{
    version: v,
    update_link: `https://github.com/${repo}/releases/download/v${v}/frame-cropper-${v}.xpi`,
  }];
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
' "$VERSION" "$REPO"

git add updates.json
git commit -q -m "Point update manifest at v${VERSION}"
git push -q origin main

# ---- 6. 配信経路が実際に生きているか確かめる ----
echo "==> 配信経路の確認"
RAW="https://raw.githubusercontent.com/${REPO}/main/updates.json"
LINK="https://github.com/${REPO}/releases/download/${TAG}/frame-cropper-${VERSION}.xpi"
echo -n "    updates.json : "; curl -sS -o /dev/null -w "HTTP %{http_code}\n" "$RAW"
echo -n "    xpi          : "; curl -sSL -o /dev/null -w "HTTP %{http_code}  %{size_download} bytes\n" "$LINK"

echo
echo "完了: $TAG"
echo "  $LINK"
echo
echo "raw.githubusercontent.com は数分キャッシュされるため、"
echo "updates.json の反映が少し遅れることがあります。"
