/**
 * テスト用アカウント表(ACCOUNTS)を作るツール。
 * パスワードは平文で保存せず、SHA-256ハッシュにして出力します。
 *
 * 使い方:
 *   1) 下の ACCOUNTS_INPUT に、ID・パスワード・属性を書く
 *   2) node tools/make-accounts.mjs を実行
 *   3) 出力されたJSON1行を、Cloudflare の Secret「ACCOUNTS」に貼る
 *
 * 属性(attrs)は自由。age/style/detail はアプリの設定に自動反映されます。
 *   age: es / hs / u25 / sh / pa    style: soft / plain / together
 *   detail: less / normal / more    その他(group等)はログ分析用に自由追加可
 */

const ACCOUNTS_INPUT = [
  { id: "tester01", pass: "Test-Pass-01", attrs: { age: "hs",  style: "soft",  group: "A" } },
  { id: "tester02", pass: "Test-Pass-02", attrs: { age: "u25", style: "plain", group: "B" } },
  { id: "tester03", pass: "Test-Pass-03", attrs: { age: "sh",  style: "together", group: "A" } },
];

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const out = {};
for (const a of ACCOUNTS_INPUT) out[a.id] = { h: await sha256hex(a.pass), attrs: a.attrs || {} };

console.log("\n=== Cloudflare の Secret「ACCOUNTS」にこの1行を貼ってください ===\n");
console.log(JSON.stringify(out));
console.log("\n=== 配布用（テスターに渡すID・パスワード。この控えは安全に保管） ===");
for (const a of ACCOUNTS_INPUT) console.log(`  ${a.id} / ${a.pass}  (${JSON.stringify(a.attrs)})`);
