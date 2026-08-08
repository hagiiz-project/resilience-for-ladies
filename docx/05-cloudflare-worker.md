# 05. 中継サーバー（Cloudflare Worker）で Gemini を安全に呼ぶ

AI（Gemini）で答える機能を足す手順です。**アプリの基本動作（監修文の応答・ログ収集）はこれ無しで動きます。** ここは「そのほか（キーワードで特定できない相談）」にAIで応じたいときの追加です。

## Cloudflare Worker とは（一言で）

アプリはGitHub Pages上にあり、**中身は誰でも読めます**。そこに Gemini のキーを書くと盗まれます。そこで **Cloudflare のサーバーに“受付係”のプログラム（Worker）をひとつ置き**、キーはその中の金庫（Secret）にしまいます。アプリは受付係に相談文を渡し、受付係だけが Gemini に取り次ぎます。**無料枠（1日10万リクエスト）**で動きます。

```
アプリ（公開・鍵なし） → 中継サーバー（鍵は金庫の中） → Gemini
```

## 前提

- `docs/04` の方針どおり、**AIは「そのほか」限定**で呼びます。緊急・繊細なテーマ（性暴力・DV等）は `keywords` で必ず監修文に当たり、AIには回りません。
- Gemini APIキーを取得済みであること（未取得なら先にキーを用意）。**実データを扱う段階では課金を有効化した有料利用**にしてください（無料枠は入力が学習に使われる場合があるため）。

---

## 手順

### 1. Cloudflare アカウントを作る
`dash.cloudflare.com` で無料アカウントを作成し、ログインします。クレジットカードは無料枠だけなら不要です。

### 2. Worker を作る
左メニュー **Workers & Pages → Create → Workers → Create Worker**。名前（例：`soudan-relay`）を付けて **Deploy**。まず「Hello World」が作られます。続いて **Edit code** を開きます。

### 3. コードを貼り付ける
エディタの中身を全部消し、`tools/cloudflare-worker.js` の中身を**丸ごと貼り付け**ます。上部の**3か所**を自分の値に直します。

```js
const ALLOWED_ORIGIN = "https://YOUR-NAME.github.io";                 // ← アプリの公開URL（オリジン）
const KB_URL         = "https://YOUR-NAME.github.io/soudan-app/knowledge.json"; // ← knowledge.json のURL
const MODEL          = "gemini-2.0-flash";                            // ← AI Studio の現行Flashモデル名
```

- `ALLOWED_ORIGIN` は末尾スラッシュ無しの「オリジン」だけ（例：`https://taro.github.io`）。
- `MODEL` は Google AI Studio のモデル一覧に出る現行ID（例：`gemini-2.0-flash`）に合わせます。表示が違う場合はその名前に。

右上の **Deploy** で保存・公開します。

### 4. APIキーを金庫（Secret）に入れる
Worker の **Settings → Variables and Secrets → Add**。

- 変数名：`GEMINI_KEY`
- 値：取得した Gemini APIキー（`AIza…`）
- **種別を「Secret（暗号化）」にして Save**。

> これでキーはコードにもGitHubにも現れず、Worker の中だけに隠れます。

### 5. Worker のURLを確認
Worker の概要ページに `https://soudan-relay.あなたのサブドメイン.workers.dev` のようなURLがあります。これが受付係の窓口です。

### 6. アプリにつなぐ
`index.html` を GitHub で開き、鉛筆で編集。先頭の `CONFIG` の `AI_ENDPOINT` に手順5のURLを貼り、Commit します。

```js
const CONFIG = {
  LOG_ENDPOINT: "...",
  AI_ENDPOINT: "https://soudan-relay.あなたのサブドメイン.workers.dev", // ← ここに貼る
  QUICK_EXIT_URL: "https://www.google.com/",
  KNOWLEDGE_URL: "./knowledge.json"
};
```

1〜2分でPagesに反映されます。**キーワードに当たらない相談を入力**すると、Geminiが監修資料に基づいた返答を返すようになります。

---

## 動作確認

- キーワードにある相談（例：「生理用品が足りない」）→ これまで通り**監修文**（AIは呼ばれません）。
- キーワードに無い相談（例：「ペットと避難したいけど不安」）→ **Geminiの返答**が返れば成功。
- 返答末尾に相談先が付いているか、資料にない番号を作っていないかを確認します。

---

## 費用を絶対に超えないための設定

見積り上は月数十〜数百円ですが、事故に備えて上限をかけます。

- **Google 側**：Google Cloud で **予算アラート/上限**（例：月$20）を設定。
- **Worker 側**：本コードは入力を800文字・出力を400トークンに制限済み。さらに厳密なレート制限が要る場合は Cloudflare の KV や Rate Limiting を追加できます（テスト段階では未設定でも可）。

---

## 安全上の設計（このコードに入れてあること）

- **監修資料の範囲だけで答える**（資料にない事実・番号・団体を作らせない）。
- **危機的な内容は助言を作らず、相談先へ**フォールバック。
- **回答末尾に必ず相談先**を表示。
- **AIは「そのほか」限定**。緊急・繊細テーマは監修文が確定で優先。
- 返答はアプリのログにも残るので、**運営が事後レビュー**できます（`docs/03`）。

> Cloudflare/Google の画面やモデル名は更新されることがあります。表示が異なる場合は、現在の「Worker作成」「Secret追加」「モデルID」に読み替えてください。最新仕様は各サービスの案内を優先してください。
