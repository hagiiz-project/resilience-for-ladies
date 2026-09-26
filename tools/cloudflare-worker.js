/**
 * ぼうさい女子会｜相談窓口アプリ ― 中継サーバー（Cloudflare Worker）
 *
 * 役割：アプリから相談文を受け取り、「知の地図」に集まったデータを根拠に
 *       Gemini で返答を作って返します。APIキーはこの中だけに隠れます。
 *
 * Cloudflare の Secret（Settings → Variables and Secrets）に入れるもの:
 *   GEMINI_KEY … Gemini APIキー（AIza…）※これだけ。コードには書きません。
 *
 * 設置手順は docs/05-cloudflare-worker.md を参照。
 */

/* ▼▼▼ 設置者が直す ▼▼▼ */

// 1) アプリの公開オリジン（パス・末尾スラッシュを付けない「ドメインまで」）
const APP_ORIGIN = "https://hagiiz-project.github.io";

// 2) 参照先の切り替え： "map"=知の地図 / "kb"=knowledge.json / "both"=両方
const SOURCE = "map";

// 3) 「知の地図」GASウェブアプリのURL（SOURCE が map / both のとき使用）
const MAP_URL = "https://script.google.com/macros/s/AKfycbw9-KkyqvF7gQioVsIXwxSe4_NB8PTNptuzGi_LjS2AHmFEs9vf06dISzfGmL6eiBNJAw/exec";

// 4) 使うモデル名（Google AI Studio に表示されている現行のFlash系IDに合わせる）
const MODEL = "gemini-2.0-flash";

// 5) knowledge.json のURL（SOURCE が kb / both のときだけ使用。map のままなら未使用）
const KB_URL = "https://hagiiz-project.github.io/resilience-for-ladies/soudan-app/knowledge.json";

// 6) 相談先（知の地図には相談先が無いため、ここの値を回答に添えます）
const DEFAULT_CONTACTS = "110（身の危険） / #8891（性暴力被害） / #8008（DV相談） / 0120-279-338（よりそいホットライン）";

/* ▲▲▲ ここまで ▲▲▲ */

/* 以下は動作の上限値です。通常は触らなくて構いません。 */
const MAP_MAX_CARDS     = 40;     // 知の地図から根拠に渡すカードの最大枚数
const MAX_INPUT_CHARS   = 800;    // 利用者の入力の上限（文字）
const MAX_OUTPUT_TOKENS = 400;    // AIの回答の長さの上限
const CACHE_MS          = 300000; // 参照データの再取得間隔（5分）

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), origin);
    if (request.method !== "POST")    return cors(json({ error: "POST only" }, 405), origin);

    let body = {};
    try { body = await request.json(); } catch (_) {}
    return cors(await handleAi(body, env), origin);
  }
};

/* ---------- AI 応答 ---------- */
async function handleAi(body, env) {
  const text = String(body.text || "").slice(0, MAX_INPUT_CHARS).trim();
  if (!text) return json({ error: "empty" }, 400);
  if (!env.GEMINI_KEY) return json({ error: "no key set" }, 500);

  const payload = {
    systemInstruction: { parts: [{ text: await buildGrounding() }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: MAX_OUTPUT_TOKENS },
    // 相談窓口という性質上、支援的な返答が過剰にブロックされないよう緩めに設定。
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

  if (!reply) {
    reply = "うまく言葉にできなくても大丈夫です。よければ、下の相談先にそのまま話してみてください。";
  }
  return json({ reply });
}

/* ---------- 参照先の読み込み ---------- */
let KB_CACHE = null,  KB_CACHE_AT = 0;
let MAP_CACHE = null, MAP_CACHE_AT = 0;

async function loadKb() {
  const now = Date.now();
  if (KB_CACHE && (now - KB_CACHE_AT) < CACHE_MS) return KB_CACHE;
  try {
    KB_CACHE = await (await fetch(KB_URL, { cf: { cacheTtl: 300 } })).json();
    KB_CACHE_AT = now;
  } catch (_) { KB_CACHE = KB_CACHE || { contacts: {}, chunks: [] }; }
  return KB_CACHE;
}

async function loadMap() {
  const now = Date.now();
  if (MAP_CACHE && (now - MAP_CACHE_AT) < CACHE_MS) return MAP_CACHE;
  try {
    const url = MAP_URL + (MAP_URL.indexOf("?") < 0 ? "?" : "&") + "t=" + now;
    MAP_CACHE = await (await fetch(url, { cf: { cacheTtl: 120 } })).json();
    MAP_CACHE_AT = now;
  } catch (_) { MAP_CACHE = MAP_CACHE || { domains: [], axes: [], cards: [], summaries: {} }; }
  return MAP_CACHE;
}

/* ---------- 応答の共通ルール（参照先が変わっても芯は変えない） ---------- */
const INSTRUCTIONS = [
  "あなたは、災害時の困りごとを聞く相談窓口の担当です。相手には10代も含まれます。",
  "次の【参照資料】に書かれている範囲だけを根拠に、やさしく短く（日本語200字程度）答えてください。",
  "資料にない事実・数字・電話番号・団体名は決して作らないでください。",
  "資料は調査中のメモを含み、確定情報ではありません。断定を避け、必要なら相談先につなぎます。",
  "命の危険・被害進行中・自傷のような内容には助言を作らず、「まず下の相談先にすぐ連絡してください」と伝え、相談先を案内してください。",
  "回答の最後に必ず、相談先（電話番号）を1〜3件そえてください。"
];

// knowledge.json → 参照資料テキスト
function buildKbBody(kb) {
  const contacts = Object.values(kb.contacts || {})
    .map(c => `${c.number}（${c.label}）`).join(" / ") || DEFAULT_CONTACTS;
  const chunks = (kb.chunks || []).map(ch => {
    const emp = ch.empathy ? (ch.empathy.soft || Object.values(ch.empathy)[0] || "") : "";
    const steps = (ch.steps || []).slice(0, 3).map((s, i) => `   ${i + 1}. ${s}`).join("\n");
    return `● ${ch.title}\n   ${emp}\n${steps}`;
  }).join("\n\n");
  return `相談先: ${contacts}\n\n${chunks}`;
}

// 知の地図(GAS) → 参照資料テキスト（調べたこと・出典・まとめを根拠に）
function buildMapBody(map) {
  const labelOf = (list, id) => {
    const x = (list || []).find(v => String(v.id) === String(id));
    return x ? x.label : "";
  };
  const cards = (map.cards || []).slice(-MAP_MAX_CARDS).map(c => {
    const place = [labelOf(map.domains, c.d), labelOf(map.axes, c.a)].filter(Boolean).join(" × ");
    const raw = String(c.raw || "").slice(0, 400);
    const src = String(c.src || "").split(/[\n\r]+/)[0] || "";
    return `● ${place}\n   ${raw}${src ? `\n   出典: ${src}` : ""}`;
  }).join("\n\n");
  const sums = Object.values(map.summaries || {})
    .map(s => `・${String(s.text || "").slice(0, 200)}`).join("\n");
  return `相談先: ${DEFAULT_CONTACTS}\n\n【集まった調べごと】\n${cards}${sums ? `\n\n【まとめ】\n${sums}` : ""}`;
}

async function buildGrounding() {
  let body;
  if (SOURCE === "map")       body = buildMapBody(await loadMap());
  else if (SOURCE === "both") body = buildKbBody(await loadKb()) + "\n\n----\n\n" + buildMapBody(await loadMap());
  else                        body = buildKbBody(await loadKb());
  return INSTRUCTIONS.join("\n") + "\n\n【参照資料】\n" + body;
}

/* ---------- 共通 ---------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
function cors(res, origin) {
  const allow = (origin === APP_ORIGIN) ? origin : APP_ORIGIN;
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", allow);
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, headers: h });
}
