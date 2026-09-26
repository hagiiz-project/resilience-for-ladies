# 00. 全体マップ（このアプリ構築スキームの共通知）

このファイルは、**「何と何が関連し、どのID・情報がどこに保管されているか」**を1枚に統合した地図です。個別の手順は各 `docs/` を参照。**新しいチームがゼロから同じ仕組みを組む**ときは、まずこれを読めば全体像がつかめます。

---

## 1. 構成要素（4つのサービス）

このアプリは、無料で使える4つの部品の組み合わせでできています。

| # | 部品 | 役割 | 費用 | 秘密情報を持つ？ |
|---|---|---|---|---|
| A | **GitHub（Pages）** | アプリ本体と知識ベースを公開・配信 | 無料 | 持たない（公開前提） |
| B | **Google スプレッドシート＋Apps Script** | 相談入力を1か所に自動集約 | 無料 | 持たない |
| C | **Cloudflare Worker** | Geminiを呼ぶ中継サーバー（鍵の金庫） | 無料枠 | **持つ（Gemini鍵）** |
| D | **Google Gemini（API）** | AIで回答を生成（RAG） | 予算内（≤3,000円/月） | 鍵はCが保管 |

> B・C・DはすべてAに“ぶら下がる”追加機能。**Aだけでもアプリは動きます**（監修文の応答＋端末内ログ）。

---

## 2. 関連図（どれとどれがつながっているか）

```
                 ┌─────────────────────────────────────────┐
                 │  A. GitHub Pages（公開・誰でも閲覧可）      │
                 │                                          │
   テスター ───▶ │  index.html  ──読む──▶ knowledge.json     │
                 │    │  │                    ▲               │
                 │    │  │                    │生成            │
                 │    │  │            content-template.docx   │
                 │    │  │            （+ build_..._docx.py）  │
                 └────┼──┼──────────────────────────────────┘
                      │  │
        LOG_ENDPOINT  │  │  AI_ENDPOINT
      （入力を送る）    │  │（"そのほか"等をAIに聞く）
                      ▼  ▼
   ┌──────────────────────┐   ┌──────────────────────────────┐
   │ B. Apps Script (/exec)│   │ C. Cloudflare Worker          │
   │   ▼                   │   │   GEMINI_KEY を金庫に保管      │
   │ Google スプレッドシート │   │   KB_URL で knowledge.json 参照│
   └──────────────────────┘   │        │                      │
                              │        ▼                      │
                              │   D. Gemini API                │
                              └──────────────────────────────┘
```

**つながりの要点（ここがズレると動きません）**
- `Worker の ALLOWED_ORIGIN` ＝ `GitHub Pages のURL（オリジン）`。一致必須。
- `Worker の KB_URL` ＝ `knowledge.json の公開URL`。一致必須。
- `index.html の AI_ENDPOINT` ＝ `Worker の公開URL`。
- `index.html の LOG_ENDPOINT` ＝ `Apps Script の /exec URL`。
- `GEMINI_KEY` は **Cの中だけ**。AやGitHubには絶対に置かない。

---

## 3. ID・URL・鍵の保管場所レジストリ（最重要）

「どのIDが・どこで発行され・どこに保管され・どこから参照されるか」の一覧です。

| ID / 情報 | 中身の例 | 発行元 | **保管場所** | 参照する場所 | 区分 |
|---|---|---|---|---|---|
| GitHub Pages URL | `https://team.github.io/soudan-app/` | GitHub（Settings→Pages） | GitHub（自動） | テスターに配布 / C の ALLOWED_ORIGIN・KB_URL | 公開 |
| knowledge.json URL | 上記 + `knowledge.json` | GitHub | GitHub repo | C の KB_URL / app の KNOWLEDGE_URL（相対） | 公開 |
| **LOG_ENDPOINT** | `https://script.google.com/macros/s/…/exec` | B（Apps Scriptデプロイ） | **index.html の CONFIG** | app の記録処理 | 公開可（書込専用） |
| 参加者ID | 参加者が自分で決める | 参加者（新規登録） | **端末内 localStorage** ＋ シート「参加者/ログ」 | ログ各行・属性紐づけ | 端末内/限定 |
| パスワード | 参加者が自分で決める | 参加者（新規登録） | **端末内にハッシュのみ**（シートには出さない） | ログイン照合 | 端末内 |
| **AI_ENDPOINT** | `https://soudan-relay.xxx.workers.dev` | C（Workerデプロイ） | **index.html の CONFIG** | app の送信処理 | 公開可 |
| **AI_MODE** | `fallback` / `safe` / `all` | 設定値 | **index.html の CONFIG** | app の分岐 | 公開 |
| QUICK_EXIT_URL | `https://www.google.com/` | 設定値 | index.html の CONFIG | app（そっと閉じる） | 公開 |
| ALLOWED_ORIGIN | `https://team.github.io` | =Pages URL | **cloudflare-worker.js** | C の CORS 判定 | 公開 |
| KB_URL | knowledge.json のURL | =上記 | **cloudflare-worker.js** | C の知識読込 | 公開 |
| MODEL | `gemini-2.0-flash` | Google AI Studio | cloudflare-worker.js | C の呼び出し | 公開 |
| **GEMINI_KEY** | `AIza…` | Google AI Studio | **Cの Secret（暗号化）のみ** | C が Gemini 呼出 | **★秘密★** |
| **SESSION_SECRET** | 長いランダム文字列 | 自分で生成 | **Cの Secret のみ** | C がトークン/チケット署名 | **★秘密★** |
| **ACCOUNTS** | ID→{ハッシュ,属性} のJSON | tools/make-accounts.mjs | **Cの Secret のみ** | C の /login 照合 | **★秘密★** |
| LOGIN_REQUIRED | `true`/`false` | 設定値 | index.html の CONFIG | app のログイン制御 | 公開 |
| 入口チケット | 短命の署名文字列 | C の /ticket | URLの `?t=`（一時的） | C の /login 検証 | 一時・公開 |
| 案内ページURL | 指定サイトのURL | 運営 | 指定サイト | テスターに配布 | 公開 |
| Google スプレッドシート | 「相談ログ」 | Google ドライブ | 運営Googleアカウント | B（Apps Script） | 限定共有 |
| Gemini 課金/予算上限 | 月$20で停止 等 | Google Cloud | Google Cloud | ― | 運営管理 |

> **秘密は Cloudflare の Secret に置く3つ（`GEMINI_KEY`・`SESSION_SECRET`・`ACCOUNTS`）だけ**。これらはコード・GitHub・チャット・メールに書かない。他は「公開されても実害が小さい」設計です（URLは書込/中継のみ、鍵が無ければ悪用しにくい）。ログインを使わない運用では秘密は `GEMINI_KEY` のみになります。

---

## 4. index.html の CONFIG（アプリ側の設定はここに集約）

アプリ側で触る設定は、`index.html` 先頭の `CONFIG` の**4か所だけ**です。

```js
const CONFIG = {
  LOG_ENDPOINT: "",      // B: 入力を集めるスプレッドシートの受け口URL（docs/03）
  AI_ENDPOINT:  "",      // C: AI中継サーバーのURL（docs/05）。空ならAI不使用
  AI_MODE:      "fallback", // AIの範囲：fallback / safe / all（docs/05）
  REQUIRE_ACCOUNT: true,    // 参加者登録(ID/パスワード/属性)を必須に（docs/06）
  LOGIN_REQUIRED: false,     // ログイン画面を出すか（docs/06）
  QUICK_EXIT_URL: "https://www.google.com/", // 「そっと閉じる」の飛び先
  KNOWLEDGE_URL: "./knowledge.json"          // 知識ベース（通常このまま）
};
```

---

## 5. ファイルの役割分担

| ファイル | 属する部品 | 役割 | 触る頻度 |
|---|---|---|---|
| `index.html` | A | アプリ本体（UI＋ロジック＋CONFIG） | 設定時のみ |
| `knowledge.json` | A | 相談の中身（文面・キーワード・窓口） | 原稿更新時 |
| `content-template.docx` | A | 原稿を書く白紙の雛形（Word） | 原稿作成時 |
| `.nojekyll` | A | GitHub Pages 用のおまじない | 触らない |
| `tools/build_knowledge_from_docx.py` | A | Word原稿 → knowledge.json 変換 | 原稿更新時 |
| `tools/appscript_sheet_logger.gs` | B | スプレッドシート記録スクリプト | 設置時のみ |
| `tools/cloudflare-worker.js` | C | 中継サーバー（認証＋AI）のコード | 設置時のみ |
| `tools/make-accounts.mjs` | C | テスト用アカウント表(ACCOUNTS)を生成 | アカウント作成時 |
| `tools/launcher-example.html` | ― | 指定サイト用の案内ページ例（❸ 入口） | 設置時のみ |
| `docs/01〜05`, `00`(本書) | ― | 設計・手順・全体像 | 随時参照 |

---

## 6. 新しいチームがゼロから組む順番（再現手順）

各ステップの詳細は右の docs に。**上から順**にやれば完成します。

1. **リポジトリ作成＆公開**（GitHub）→ `README.md`。この時点でアプリは動く（監修文＋端末内ログ）。
2. **原稿を作る**：`content-template.docx` を埋め、`build_knowledge_from_docx.py` で `knowledge.json` を生成 → `docs/02`。
3. **入力の集約**（任意）：Apps Scriptで受け口を作り、`LOG_ENDPOINT` に設定 → `docs/03`。
4. **予算とAI準備**（AIを使う場合）：Gemini APIキー取得＋予算上限 → `docs/04`。
5. **AI中継サーバー**（AIを使う場合）：Cloudflare Workerを設置、`GEMINI_KEY` をSecret登録、`AI_ENDPOINT` に設定 → `docs/05`。
6. **ログイン/入口制限**（任意）：SESSION_SECRET と ACCOUNTS を作りWorkerに登録、`LOGIN_REQUIRED:true`、案内ページ設置 → `docs/06`。
7. **テスト**：`AI_MODE:"all"` でAI挙動を検証 → 本番前に `"safe"` か `"fallback"` に戻す → `docs/05`。

---

## 7. 安全・プライバシーの原則（このスキームの前提）

- **秘密は Gemini鍵のみ**。Cloudflareの Secret にだけ置く。
- **匿名運用**：ログイン無し。ユーザー名・メール・IPは取得しない（DV・性暴力相談で特定を招かないため）。
- **本文の扱いは選択制**：アプリの「本文を残さない」で、種類だけ集計も可能。
- **緊急・繊細テーマは監修文を確定**：`AI_MODE` を `all` で本番運用しない。
- **費用の上限**：Google Cloud で予算上限をかけ、Workerは入力/出力を制限済み。
- **実データはGemini有料利用**（無料枠は学習に使われる場合があるため）。
- **参加者アカウントは端末内照合**（パスワードは平文で保存せず、シートにも出さない。ID＋属性のみ集約）→ docs/06。

---

## 8. チェックリスト（設置が正しいかの最終確認）

- [ ] `GEMINI_KEY` は Cloudflare の Secret にのみ存在し、GitHub上のどこにも無い
- [ ] Worker の `ALLOWED_ORIGIN` が Pages URL（オリジン）と一致
- [ ] Worker の `KB_URL` が knowledge.json の公開URLと一致
- [ ] `AI_ENDPOINT` = Worker URL、`LOG_ENDPOINT` = Apps Script /exec URL
- [ ] `MODEL` が AI Studio の現行モデルIDと一致
- [ ] スプレッドシートに相談が1行入ることを確認
- [ ] 緊急テーマ（性暴力・DV等）で監修文＋相談先が出ることを確認
- [ ] Google Cloud に予算上限を設定
- [ ] 本番の `AI_MODE` は `fallback` または `safe`

---

> このスキームの再利用時は、`knowledge.json`（相談の中身）と各URL・鍵を差し替えるだけで、別テーマの匿名相談窓口にも転用できます。
