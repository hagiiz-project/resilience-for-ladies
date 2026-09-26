/**
 * ぼうさい女子会｜相談窓口アプリ ― 中継サーバー（Cloudflare Worker）v3
 *
 * 参照スキーム（現状）:
 *   知の地図(GAS) → カードを多軸で絞り込み → そのカードの「URLの中身」を読む → Geminiが回答
 *
 * 設計の芯:
 *   - 回答の根拠は「URL内の情報」。調査員が書いた raw は既定では根拠にしない（属人化を避ける）。
 *   - 絞り込みは1軸に頼らない（マス／事象／タグ／語彙の4軸）。外すと信頼性を損なうため。
 *   - 確信が持てないときは断定せず、ワンタップで選べる聞き返しを返す。
 *   - 外したときに利用者が引き直せる（pick / exclude）。
 *
 * Cloudflare の Secret（Settings → Variables and Secrets）:
 *   GEMINI_KEY … Gemini APIキー（AIza…）※これだけ。コードには書きません。
 *
 * アプリからの呼び出し（POST / JSON）:
 *   { text: "相談文",
 *     pick: "d1|a3" または "事象タグ名"（任意：聞き返しで選ばれた場合）,
 *     exclude: ["d1|a3"]（任意：「ちがう場面だった」で除外する場面） }
 * 返り値:
 *   { reply, ask, options[], used[], scope }   ※ reply は常に入るので旧アプリでも動きます
 */

/* ======================================================================
   ▼▼▼ 設置者が直す ▼▼▼
   ====================================================================== */

// 1) アプリの公開オリジン（パス・末尾スラッシュを付けない）
const APP_ORIGIN = "https://hagiiz-project.github.io";

// 2) 参照先：
//    "map"   = 知の地図(GAS)               ← 現状これ
//    "sheet" = 月1整理した参照台帳(GAS)     ← ⑤将来用。SHEET_URL を設定すれば切替可能
//    "kb"    = knowledge.json
//    "both"  = 知の地図 ＋ knowledge.json
const SOURCE = "map";

// 3) 知の地図 GASウェブアプリ(doGet)のURL
const MAP_URL = "https://script.google.com/macros/s/AKfycbw9-KkyqvF7gQioVsIXwxSe4_NB8PTNptuzGi_LjS2AHmFEs9vf06dISzfGmL6eiBNJAw/exec";

// 4) ⑤将来用：月1整理でつくる「参照台帳」スプレッドシートの GAS doGet URL。
//    列の想定: id / url / publisher / fetchedAt / summary / mass / tags / phrases / status
//    未設定なら SOURCE="sheet" は使えません（自動で map にフォールバックします）。
const SHEET_URL = "";

// 5) knowledge.json のURL（SOURCE が kb / both のときだけ使用）
const KB_URL = "https://hagiiz-project.github.io/resilience-for-ladies/soudan-app/knowledge.json";

// 6) 使うモデル名（AI Studio のモデル一覧の文字列に合わせる）
const MODEL = "gemini-3.5-flash-lite";

// 7) 相談先（知の地図には相談先が無いため、ここの値を回答に添えます）
const DEFAULT_CONTACTS = "110（身の危険） / #8891（性暴力被害） / #8008（DV相談） / 0120-279-338（よりそいホットライン）";

// 8) ③回答の根拠をどこから取るか：
//    "url"  = URLの中身だけ（既定・属人化を避ける）
//    "raw"  = 調査員が書いた本文だけ
//    "both" = 両方（URLが読めないカードの保険になる）
const GROUNDING = "url";

// 9) 確信が持てないとき、断定せずに聞き返すか（②の芯）
const ASK_WHEN_UNSURE = true;

/* ======================================================================
   ▲▲▲ ここまで。以下は動作の調整値 ▲▲▲
   ====================================================================== */

const MAX_CARDS_GROUND   = 6;     // 根拠として渡すカードの最大枚数（絞り込み後）
const MAX_URLS_PER_CARD  = 3;     // 1カードから読むURLの最大数（複数URL対応）
const MAX_URL_FETCH      = 8;     // 1回の相談で読むURLの総上限
const URL_TEXT_CHARS     = 1800;  // 1URLから使う本文の文字数
const RAW_CHARS          = 600;   // raw を使う場合の文字数
const URL_TIMEOUT_MS     = 6000;  // URL取得のタイムアウト
const MAX_INPUT_CHARS    = 800;
const MAX_OUTPUT_TOKENS  = 500;
const DATA_CACHE_MS      = 300000;   // 知の地図/台帳の再取得間隔（5分）
const URL_CACHE_MS       = 86400000; // URL本文のキャッシュ（24時間）
const SCORE_CONFIDENT    = 3;        // これ以上なら聞き返さずに答える

/* ④事象タグ（女性が相談したくなる状況）。マスとは別軸。ここは運用で育てる想定。
   月1整理で phrases（想定相談の言い回し）を増やすほど、取りこぼしが減ります。 */
const EVENT_TAGS = [
  { tag:"生理・衛生",   kw:["生理","ナプキン","タンポン","経血","衛生用品","下着","ショーツ"] },
  { tag:"着替え・トイレ", kw:["着替え","更衣","トイレ","授乳","浴びたい","お風呂","シャワー","仕切り"] },
  { tag:"視線・夜の不安", kw:["視線","見られ","じろじろ","夜","眠れない","こわい","怖い","不安","одна","ひとり"] },
  { tag:"性暴力",       kw:["さわられ","触られ","痴漢","性被害","性暴力","レイプ","むりやり","無理やり","脱がさ"] },
  { tag:"つきまとい",   kw:["つきまと","ストーカー","ついてくる","待ち伏せ","しつこい","尾行"] },
  { tag:"DV・家庭",     kw:["殴ら","叩か","蹴ら","DV","暴力","夫","旦那","彼氏","パートナー","家族","怒鳴","親"] },
  { tag:"からだ・体調",  kw:["体調","だるい","熱","痛い","むくみ","車中泊","エコノミー","妊娠","授乳","持病","薬"] },
  { tag:"役割・負担",   kw:["炊き出し","家事","当番","押し付け","女性だけ","男性だけ","役割","負担","手伝い","育児","介護"] },
  { tag:"言えない・孤立", kw:["言えない","相談できない","無視","取り合って","我慢","ひとりで","つらい","聞いてほしい","居場所"] },
  { tag:"お金・仕事",   kw:["お金","仕事","失業","収入","給料","生活費","支援金","家賃"] }
];

/* ======================================================================
   エントリポイント
   ====================================================================== */
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

async function handleAi(body, env) {
  const text = String(body.text || "").slice(0, MAX_INPUT_CHARS).trim();
  if (!text) return json({ error: "empty" }, 400);
  if (!env.GEMINI_KEY) return json({ error: "no key set" }, 500);

  const pick    = String(body.pick || "").trim();
  const exclude = Array.isArray(body.exclude) ? body.exclude.map(String) : [];

  // --- 参照データを読む ---
  const src = await loadSource();

  // --- ②多軸で絞り込む ---
  const sel = selectCards(src, text, pick, exclude);

  // 確信が持てない → 断定せず、ワンタップで選べる聞き返しを返す
  if (ASK_WHEN_UNSURE && !pick && sel.needAsk) {
    const q = "もう少しだけ教えてください。いちばん近いのはどれですか。";
    const listed = sel.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
    return json({
      ask: true,
      options: sel.options,                       // 新アプリ：ワンタップ表示用
      reply: `${q}\n\n${listed}\n\n（番号でも、言葉でも大丈夫です）`, // 旧アプリ：そのまま表示される
      scope: sel.scope
    });
  }

  // --- ③根拠を組み立てる（既定はURLの中身） ---
  const built = await buildEvidence(sel.cards);

  // --- Gemini に投げる ---
  const reply = await askGemini(env, text, built.body, sel.scope);

  return json({
    reply,
    used: built.used,     // 使った出典（アプリ側で表示できます）
    scope: sel.scope      // どの場面で答えたか（「ちがう場面だった」用）
  });
}

/* ======================================================================
   参照データの読み込み（map / sheet / kb / both）
   ====================================================================== */
let SRC_CACHE = null, SRC_CACHE_AT = 0;

async function loadSource() {
  const now = Date.now();
  if (SRC_CACHE && (now - SRC_CACHE_AT) < DATA_CACHE_MS) return SRC_CACHE;

  let out = { cards: [], kb: null };
  try {
    if (SOURCE === "sheet" && SHEET_URL) {
      out.cards = normalizeSheet(await getJson(SHEET_URL));
    } else if (SOURCE === "kb") {
      out.kb = await getJson(KB_URL);
    } else if (SOURCE === "both") {
      out.cards = normalizeMap(await getJson(MAP_URL));
      out.kb    = await getJson(KB_URL).catch(() => null);
    } else {
      out.cards = normalizeMap(await getJson(MAP_URL));   // 既定：map
    }
    SRC_CACHE = out; SRC_CACHE_AT = now;
  } catch (_) {
    SRC_CACHE = SRC_CACHE || out;
  }
  return SRC_CACHE;
}

async function getJson(url) {
  const u = url + (url.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now();
  const r = await fetch(u, { cf: { cacheTtl: 120 } });
  return await r.json();
}

/* 知の地図(GAS doGet) → 共通カード形式へ */
function normalizeMap(map) {
  const label = (list, id) => {
    const x = (list || []).find(v => String(v.id) === String(id));
    return x ? String(x.label) : "";
  };
  return (map.cards || []).map(c => {
    const dL = label(map.domains, c.d), aL = label(map.axes, c.a);
    // ライフステージ・状況タグ（AI判定＋人の訂正）も絞り込み軸に使う
    const stageLabels = (c.stages || []).map(id => label(map.stages, id)).filter(Boolean);
    const situLabels  = (c.situations || []).map(id => label(map.situations, id)).filter(Boolean);
    return {
      id: String(c.id || ""),
      mass: (c.d && c.a) ? `${c.d}|${c.a}` : "",
      massLabel: [dL, aL].filter(Boolean).join(" × "),
      domain: dL, phase: aL,
      urls: splitSources(c.src),          // ★複数URLに対応
      raw: String(c.raw || ""),
      summary: String(c.summary || ""),   // 知の地図のAI要約（あれば）
      q: String(c.q || ""),
      tags: stageLabels.concat(situLabels),
      fixed: !!c.fixed,                   // 人が訂正した印（信頼度を上げる）
      conf: String(c.conf || "")
    };
  });
}

/* ⑤将来用：参照台帳スプレッドシート → 共通カード形式へ */
function normalizeSheet(sheet) {
  const rows = sheet.rows || sheet.items || [];
  return rows
    .filter(r => String(r.status || "有効") !== "失効")
    .map((r, i) => ({
      id: String(r.id || ("s" + i)),
      mass: String(r.mass || ""),
      massLabel: String(r.massLabel || r.mass || ""),
      domain: "", phase: "",
      urls: splitSources(r.url),
      raw: "",
      summary: String(r.summary || ""),   // 整理済みの要点（これが主な根拠になる）
      q: "",
      tags: String(r.tags || "").split(/[,、，]/).map(s => s.trim()).filter(Boolean),
      phrases: String(r.phrases || "").split(/[,、，\n]/).map(s => s.trim()).filter(Boolean),
      publisher: String(r.publisher || ""),
      fetchedAt: String(r.fetchedAt || ""),
      fixed: true, conf: "高"
    }));
}

/* ★知の地図と同じ分割規則（改行・スペース・読点・カンマ）。1行だけ見る実装をやめる。 */
function splitSources(t) {
  const out = [];
  String(t || "").split(/[\n\r、，,]+/).forEach(seg => {
    seg = seg.trim(); if (!seg) return;
    if ((seg.match(/https?:\/\//gi) || []).length > 1) {
      seg.split(/\s+/).forEach(p => { p = p.trim(); if (p) out.push(p); });
    } else out.push(seg);
  });
  return out;
}
function isHttp(u) { return /^https?:\/\//i.test(String(u || "").trim()); }

/* ======================================================================
   ②多軸の絞り込み（マス／事象／タグ／語彙）
   ====================================================================== */
function selectCards(src, text, pick, exclude) {
  const cards = (src.cards || []).filter(c => !exclude.includes(c.mass));
  if (!cards.length) return { cards: [], scope: "", needAsk: false, options: [] };

  // 事象タグの判定（相談文の語彙から）
  const hitTags = EVENT_TAGS.filter(t => t.kw.some(k => text.indexOf(k) >= 0)).map(t => t.tag);

  // 明示的な選択（聞き返しの答え／ワンタップ）があれば最優先
  const picked = pick ? cards.filter(c => c.mass === pick || c.massLabel === pick || c.tags.includes(pick)
                        || matchEventTag(c, pick)) : null;
  if (picked && picked.length) {
    return { cards: rank(picked, text, hitTags).slice(0, MAX_CARDS_GROUND),
             scope: pick, needAsk: false, options: [] };
  }

  const scored = rank(cards, text, hitTags);
  const top = scored[0];
  const best = top ? top._score : 0;

  // 確信が持てない → 候補を出して聞き返す
  if (best < SCORE_CONFIDENT) {
    return { cards: scored.slice(0, MAX_CARDS_GROUND), scope: "",
             needAsk: true, options: buildOptions(scored, hitTags) };
  }

  // 同じ場面に偏らないよう、上位から場面をまたいで拾う
  const outCards = [], seen = new Set();
  for (const c of scored) {
    if (outCards.length >= MAX_CARDS_GROUND) break;
    const key = c.mass || c.id;
    if (seen.has(key) && outCards.length >= 3) continue;
    seen.add(key); outCards.push(c);
  }
  return { cards: outCards, scope: top.mass || "", needAsk: false, options: [] };
}

function matchEventTag(card, tagName) {
  const t = EVENT_TAGS.find(x => x.tag === tagName);
  if (!t) return false;
  const hay = card.massLabel + " " + card.tags.join(" ") + " " + card.summary + " " + card.raw;
  return t.kw.some(k => hay.indexOf(k) >= 0);
}

/* 4軸スコアリング：マス名／事象タグ／判定タグ／語彙の重なり */
function rank(cards, text, hitTags) {
  const words = tokens(text);
  return cards.map(c => {
    let s = 0;
    // 軸1：マス名（領域・フェーズ）が相談文に出てくる
    if (c.domain && text.indexOf(c.domain) >= 0) s += 2;
    if (c.phase  && text.indexOf(c.phase)  >= 0) s += 1;
    // 軸2：事象タグ（女性が相談したくなる状況）
    hitTags.forEach(tag => { if (matchEventTag(c, tag)) s += 3; });
    // 軸3：知の地図のAI判定タグ（ライフステージ・状況）
    c.tags.forEach(t => { if (t && text.indexOf(t) >= 0) s += 2; });
    // 軸4：語彙の重なり（要点・本文・想定相談の言い回し）
    const hay = (c.summary || "") + " " + (c.raw || "") + " " + ((c.phrases || []).join(" "));
    words.forEach(w => { if (w.length >= 2 && hay.indexOf(w) >= 0) s += 1; });
    // 信頼度の補正：人が訂正済みは加点、AI確信度「低」は減点
    if (c.fixed) s += 1;
    if (c.conf === "低" && !c.fixed) s -= 1;
    // URLが無いカードは根拠にしづらい（GROUNDING="url" のとき）
    if (GROUNDING === "url" && !c.urls.some(isHttp)) s -= 2;
    c._score = s;
    return c;
  }).sort((a, b) => b._score - a._score);
}

function tokens(text) {
  return String(text || "")
    .replace(/[、。？?！!「」『』（）()\s]+/g, " ")
    .split(" ").filter(Boolean);
}

/* 聞き返しの選択肢：利用者が選びやすい「事象」を優先し、足りなければマスで補う。
   利用者は領域名より「どんな状況か」で答えやすいため。 */
function buildOptions(scored, hitTags) {
  const opts = [], seen = new Set();
  const add = (value, label) => { if (!seen.has(label) && opts.length < 5) { seen.add(label); opts.push({ value, label }); } };

  // 1) 相談文から引っかかった事象タグ
  hitTags.forEach(t => add(t, t));

  // 2) 上位カードに実際に当てはまる事象タグ（利用者の言葉に近い）
  for (const c of scored.slice(0, 8)) {
    for (const t of EVENT_TAGS) {
      if (opts.length >= 4) break;
      if (matchEventTag(c, t.tag)) add(t.tag, t.tag);
    }
  }

  // 3) それでも足りなければ、よく当たるマスで補う
  for (const c of scored) {
    if (opts.length >= 4) break;
    if (c.massLabel) add(c.mass, c.massLabel);
  }

  // 4) 何も無いときの既定
  if (!opts.length) EVENT_TAGS.slice(0, 4).forEach(t => add(t.tag, t.tag));

  opts.push({ value: "", label: "うまく選べない／その他" });
  return opts;
}

/* ======================================================================
   ③根拠の組み立て（既定：URLの中身を読む。複数URL対応）
   ====================================================================== */
async function buildEvidence(cards) {
  const parts = [], used = [];
  let fetched = 0;

  for (const c of cards) {
    const chunk = [];
    const head = c.massLabel ? `● ${c.massLabel}` : "●";

    if (GROUNDING === "url" || GROUNDING === "both") {
      const urls = c.urls.filter(isHttp).slice(0, MAX_URLS_PER_CARD);
      for (const u of urls) {
        if (fetched >= MAX_URL_FETCH) break;
        fetched++;
        const t = await fetchText(u);
        if (t) {
          chunk.push(`   〔出典: ${u}〕\n   ${t}`);
          used.push({ url: u, ok: true });
        } else {
          used.push({ url: u, ok: false });   // 読めなかった（PDF・リンク切れ等）
        }
      }
      // URLが読めない場合の保険：整理済み要点があれば使う
      if (!chunk.length && c.summary) chunk.push(`   ${c.summary.slice(0, RAW_CHARS)}`);
    }

    if (GROUNDING === "raw" || (GROUNDING === "both" && c.raw)) {
      if (c.raw) chunk.push(`   〔調査メモ〕${c.raw.slice(0, RAW_CHARS)}`);
    }

    if (chunk.length) parts.push(`${head}\n${chunk.join("\n")}`);
  }

  const body = parts.length
    ? parts.join("\n\n")
    : "（参照できる資料が見つかりませんでした。断定せず、相談先を案内してください。）";
  return { body, used };
}

/* URL本文の取得：HTMLからテキストだけを抜き、24時間キャッシュ */
const URL_CACHE = new Map();
async function fetchText(url) {
  const hit = URL_CACHE.get(url);
  if (hit && (Date.now() - hit.at) < URL_CACHE_MS) return hit.text;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), URL_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SoudanBot/1.0)" },
      cf: { cacheTtl: 3600 }
    });
    clearTimeout(timer);
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      URL_CACHE.set(url, { at: Date.now(), text: "" });   // PDF等は読めない
      return "";
    }
    const html = await res.text();
    const text = htmlToText(html).slice(0, URL_TEXT_CHARS);
    URL_CACHE.set(url, { at: Date.now(), text });
    return text;
  } catch (_) {
    URL_CACHE.set(url, { at: Date.now(), text: "" });
    return "";
  }
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/* ======================================================================
   Gemini 呼び出し
   ====================================================================== */
const INSTRUCTIONS = [
  "あなたは、災害時の困りごとを聞く相談窓口の担当です。相手には10代も含まれます。",
  "次の【参照資料】に書かれている範囲だけを根拠に、やさしく短く（日本語200字程度）答えてください。",
  "資料にない事実・数字・電話番号・団体名は決して作らないでください。",
  "資料は調査中のものを含み、確定情報ではありません。断定を避け、必要なら相談先につなぎます。",
  "相談者を評価したり、原因を相談者に求めたりしないでください。",
  "命の危険・被害進行中・自傷のような内容には助言を作らず、「まず下の相談先にすぐ連絡してください」と伝え、相談先を案内してください。",
  "回答の最後に必ず、相談先（電話番号）を1〜3件そえてください。"
];

async function askGemini(env, text, evidence, scope) {
  const system = INSTRUCTIONS.join("\n")
    + `\n\n相談先: ${DEFAULT_CONTACTS}`
    + (scope ? `\n想定している場面: ${scope}` : "")
    + "\n\n【参照資料】\n" + evidence;

  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: MAX_OUTPUT_TOKENS },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
    ]
  };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      { method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
        body: JSON.stringify(payload) });
    const data = await res.json();
    const out = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    if (out) return out;
  } catch (_) {}
  return "うまく言葉にできなくても大丈夫です。よければ、下の相談先にそのまま話してみてください。\n\n" + DEFAULT_CONTACTS;
}

/* ======================================================================
   共通
   ====================================================================== */
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
