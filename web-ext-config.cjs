/* web-ext の設定。
 *
 * ignoreFiles を置く理由は 2 つ:
 *   1. 検証用フィクスチャや README は拡張機能の動作に不要で、XPI に入れる意味がない
 *   2. tools/fixture.html はインライン <script> を持つ。拡張機能本体では
 *      既定の CSP がインラインスクリプトを禁じるため、同梱すると
 *      AMO の検証で INLINE_SCRIPT 警告が出る (本体のコードは一切使っていない)
 */
module.exports = {
  ignoreFiles: [
    'tools',
    'tools/**',
    'README.md',
    'LICENSE',
    '.git/**',
    '.gitignore',
    '.gitattributes',
    'web-ext-config.cjs',
    'web-ext-artifacts/**',
  ],
};
