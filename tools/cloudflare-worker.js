/**
 * ぼうさい女子会｜相談窓口アプリ ― 中継サーバー兼「受付」（Cloudflare Worker）
 *
 * 3つの窓口（パスで振り分け）:
 *   POST /ticket … 指定サイトからの入口チケットを発行（❸ 入口制限）
 *   POST /login  … ID・パスワードを照合し、セッショントークンを発行（❶❷）
 *   POST /ai     … 相談文をGeminiで回答（要トークン。知識ベースに基づく）
 *
 * APIキー・アカウント・署名鍵はコードに書きません。Cloudflareの Secret に入れます:
 *   GEMINI_KEY      … Gemini APIキー
 *   SESSION_SECRET  … トークン/チケット署名用のランダムな長い文字列
 *   ACCOUNTS        … アカウント表(JSON文字列)  例は docs/06-auth-login.md
 *
 * 設置手順は docs/06-auth-login.md / docs/05-cloudflare-worker.md を参照。
 */

/* ▼▼▼ 設置者が直す ▼▼▼ */
const APP_ORIGIN      = "https://YOUR-NAME.github.io";                       // アプリの公開オリジン
const LAUNCHER_ORIGIN = "https://YOUR-LAUNCHER-SITE.example";                // ❸ ここからのみ入口チケットを出す（空なら入口制限なし）
const KB_URL          = "https://YOUR-NAME.github.io/soudan-app/knowledge.json";
const MODEL           = "gemini-2.0-flash";
/* ▲▲▲ ここまで ▲▲▲ */

const MAX_INPUT_CHARS  = 800;
const MAX_OUTPUT_TOKENS = 400;
const TICKET_TTL_MS  = 5 * 60 * 1000;        // 入口チケットの有効時間（5分）
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;  // ログインセッションの有効時間（12時間）

let KB_CACHE = null, KB_CACHE_AT = 0;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), origin);
    if (request.method !== "POST")    return cors(json({ error: "POST only" }, 405), origin);

    const path = new URL(request.url).pathname;
    let body = {};
    try { body = await request.json(); } catch (_) {}

    if (path.endsWith("/ticket")) return cors(await handleTicket(request, env), origin);
    if (path.endsWith("/login"))  return cors(await handleLogin(body, env), origin);
    return cors(await handleAi(body, env), origin);   // /ai（既定）
  }
};

/* ---------- ❸ 入口チケット ---------- */
async function handleTicket(request, env) {
  if (LAUNCHER_ORIGIN) {
    const origin = request.headers.get("Origin") || "";
    const ref = request.headers.get("Referer") || "";
    const ok = origin === LAUNCHER_ORIGIN || ref.startsWith(LAUNCHER_ORIGIN);
    if (!ok) return json({ error: "not allowed from here" }, 403);
  }
  const ticket = await sign(env.SESSION_SECRET, { k: "ticket", exp: Date.now() + TICKET_TTL_MS });
  return json({ ticket });
}

/* ---------- ❶❷ ログイン ---------- */
async function handleLogin(body, env) {
  const id = String(body.id || "").trim();
  const pass = String(body.pass || "");
  // 入口制限が有効なら、正しいチケット必須
  if (LAUNCHER_ORIGIN) {
    const t = await verify(env.SESSION_SECRET, String(body.ticket || ""));
    if (!t || t.k !== "ticket") return json({ error: "entry" }, 401);
  }
  let accounts = {};
  try { accounts = JSON.parse(env.ACCOUNTS || "{}"); } catch (_) {}
  const acc = accounts[id];
  if (!acc) return json({ error: "auth" }, 401);
  const h = await sha256hex(pass);
  if (h !== acc.h) return json({ error: "auth" }, 401);
  const attrs = acc.attrs || {};
  const token = await sign(env.SESSION_SECRET, { id, attrs, exp: Date.now() + SESSION_TTL_MS });
  return json({ token, attrs });
}

/* ---------- AI（要トークン） ---------- */
async function handleAi(body, env) {
  // アカウントを設定している運用では、AIもログイン必須にする
  if (env.ACCOUNTS) {
    const s = await verify(env.SESSION_SECRET, String(body.token || ""));
    if (!s || !s.id) return json({ error: "unauthorized" }, 401);
  }
  const text = String(body.text || "").slice(0, MAX_INPUT_CHARS).trim();
  if (!text) return json({ error: "empty" }, 400);
  if (!env.GEMINI_KEY) return json({ error: "no key" }, 500);

  const kb = await loadKb();
  const payload = {
    systemInstruction: { parts: [{ text: buildSystemPrompt(kb) }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: MAX_OUTPUT_TOKENS },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
    ]
  };
  let reply = "";
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      { method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
        body: JSON.stringify(payload) });
    const data = await res.json();
    reply = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
  } catch (_) { reply = ""; }
  if (!reply) reply = "うまく言葉にできなくても大丈夫です。よければ、下の相談先にそのまま話してみてください。";
  return json({ reply });
}

/* ---------- 知識ベース ---------- */
async function loadKb() {
  const now = Date.now();
  if (KB_CACHE && (now - KB_CACHE_AT) < 300000) return KB_CACHE;
  try { KB_CACHE = await (await fetch(KB_URL, { cf: { cacheTtl: 300 } })).json(); KB_CACHE_AT = now; }
  catch (_) { KB_CACHE = KB_CACHE || { contacts: {}, chunks: [] }; }
  return KB_CACHE;
}
function buildSystemPrompt(kb) {
  const contacts = Object.values(kb.contacts || {}).map(c => `${c.number}（${c.label}）`).join(" / ");
  const chunks = (kb.chunks || []).map(ch => {
    const emp = ch.empathy ? (ch.empathy.soft || Object.values(ch.empathy)[0] || "") : "";
    const steps = (ch.steps || []).slice(0, 3).map((s, i) => `   ${i + 1}. ${s}`).join("\n");
    return `● ${ch.title}\n   ${emp}\n${steps}`;
  }).join("\n\n");
  return [
    "あなたは、災害時の困りごとを聞く相談窓口の担当です。相手には10代も含まれます。",
    "次の【監修資料】の範囲だけを根拠に、やさしく短く（日本語200字程度）答えてください。",
    "資料にない事実・数字・電話番号・団体名は決して作らないでください。",
    "命の危険・被害進行中・自傷のような内容には助言を作らず、「まず下の相談先にすぐ連絡してください」と伝え、相談先を案内。",
    "回答の最後に必ず、資料内の相談先（電話番号）を1〜3件そえてください。",
    "", "【監修資料】", `相談先: ${contacts}`, "", chunks
  ].join("\n");
}

/* ---------- 署名まわり（WebCrypto） ---------- */
const te = new TextEncoder();
function b64url(buf) {
  const b = String.fromCharCode(...new Uint8Array(buf));
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function ub64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", te.encode(secret || ""),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, te.encode(msg)));
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", te.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function sign(secret, obj) {
  const p = b64url(te.encode(JSON.stringify(obj)));
  return p + "." + await hmac(secret, p);
}
async function verify(secret, token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [p, sig] = token.split(".");
  const good = await hmac(secret, p);
  if (!safeEq(good, sig)) return null;
  let obj; try { obj = JSON.parse(new TextDecoder().decode(ub64url(p))); } catch (_) { return null; }
  if (obj.exp && Date.now() > obj.exp) return null;
  return obj;
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------- 共通 ---------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
function cors(res, origin) {
  const allow = (origin === APP_ORIGIN || origin === LAUNCHER_ORIGIN) ? origin : APP_ORIGIN;
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", allow);
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, headers: h });
}
