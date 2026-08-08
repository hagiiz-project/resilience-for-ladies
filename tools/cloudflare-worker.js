/**
 * ぼうさい女子会｜相談窓口アプリ ― 中継サーバー（Cloudflare Worker）
 *
 * 役割：アプリからの相談文を受け取り、監修済み知識ベース(knowledge.json)を根拠に
 *       Gemini でやさしい返答を作って返します。APIキーはこの中だけに隠れます。
 *
 * 設置手順は docs/05-cloudflare-worker.md を参照してください。
 * APIキーは下のコードには書きません。Cloudflare の「Secret（GEMINI_KEY）」に入れます。
 */

/* ▼▼▼ 設置者が直す3か所 ▼▼▼ */
// 1) アプリの公開URL（このオリジンからの呼び出しだけ許可します）
const ALLOWED_ORIGIN = "https://YOUR-NAME.github.io";
// 2) 知識ベースの場所（アプリと同じ knowledge.json のURL）
const KB_URL = "https://YOUR-NAME.github.io/soudan-app/knowledge.json";
// 3) 使うモデル名（Google AI Studio に表示される現行のFlash系IDに合わせる）
const MODEL = "gemini-2.0-flash";
/* ▲▲▲ ここまで ▲▲▲ */

const MAX_INPUT_CHARS = 800;    // 入力の上限（費用と悪用の抑制）
const MAX_OUTPUT_TOKENS = 400;  // 出力の上限（費用の抑制）

let KB_CACHE = null;            // 知識ベースの簡易キャッシュ
let KB_CACHE_AT = 0;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    if (request.method !== "POST")    return withCors(json({ error: "POST only" }, 405));

    let body;
    try { body = await request.json(); } catch { return withCors(json({ error: "bad json" }, 400)); }
    const text = String(body.text || "").slice(0, MAX_INPUT_CHARS).trim();
    if (!text) return withCors(json({ error: "empty" }, 400));
    if (!env.GEMINI_KEY) return withCors(json({ error: "no key set" }, 500));

    const kb = await loadKb();
    const system = buildSystemPrompt(kb);

    const payload = {
      systemInstruction: { parts: [{ text: system }] },
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
      // Gemini が応答しない／内容がブロックされた等の保険
      reply = "うまく言葉にできなくても大丈夫です。よければ、下の相談先にそのまま話してみてください。";
    }
    return withCors(json({ reply }));
  }
};

async function loadKb() {
  const now = Date.now();
  if (KB_CACHE && (now - KB_CACHE_AT) < 5 * 60 * 1000) return KB_CACHE; // 5分キャッシュ
  try {
    const res = await fetch(KB_URL, { cf: { cacheTtl: 300 } });
    KB_CACHE = await res.json();
    KB_CACHE_AT = now;
  } catch (_) { KB_CACHE = KB_CACHE || { contacts: {}, chunks: [] }; }
  return KB_CACHE;
}

function buildSystemPrompt(kb) {
  const contacts = Object.values(kb.contacts || {})
    .map(c => `${c.number}（${c.label}）`).join(" / ");
  const chunks = (kb.chunks || []).map(ch => {
    const emp = ch.empathy ? (ch.empathy.soft || Object.values(ch.empathy)[0] || "") : "";
    const steps = (ch.steps || []).slice(0, 3).map((s, i) => `   ${i + 1}. ${s}`).join("\n");
    return `● ${ch.title}\n   ${emp}\n${steps}`;
  }).join("\n\n");

  return [
    "あなたは、災害時の困りごとを聞く相談窓口の担当です。相手には10代も含まれます。",
    "次の【監修資料】に書かれている範囲だけを根拠に、やさしく短く（日本語で200字程度）答えてください。",
    "資料にない事実・数字・電話番号・団体名は決して作らないでください。",
    "断定や説教をせず、まず気持ちを受けとめ、できる次の一歩をひとつ示します。",
    "命の危険、被害が今まさに起きている、自分を傷つけたい——そうした内容には助言を作らず、",
    "「まず下の相談先に、すぐ連絡してください」とだけ伝え、相談先を案内してください。",
    "回答の最後に必ず、資料内の相談先（電話番号）を1〜3件そえてください。",
    "",
    "【監修資料】",
    `相談先: ${contacts}`,
    "",
    chunks
  ].join("\n");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
function withCors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, headers: h });
}
