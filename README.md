ぼうさい女子会｜相談窓口アプリ（公開版）：RAGについては2パターンのうち1パターンでテスト。実装段階では要相談
避難所や日常での困りごとを、名前を書かずに相談できる窓口アプリです。回答は監修済みの文面から選んで返す「シナリオ型」で、10代が使う窓口として安全に倒しています。
このリポジトリは GitHub Pages にそのまま置けば動く 構成になっています。ビルド作業やサーバーは不要です。
---
このリポジトリの構成
```
soudan-app/
├─ index.html      … アプリ本体（これだけで動きます）
├─ knowledge.json  … 相談の「中身」＝知識ベース（文面・キーワード・窓口）
├─ content-template.docx … 原稿を書くための白紙の雛形（Word）。埋めたら knowledge.json に変換
├─ .nojekyll       … GitHub Pages 用のおまじない（消さないでください）
├─ docs/           … 説明・手順書（テスターには見せなくて構いません）
│   ├─ 01-design.md            … なぜこの作りにしたか（方式A/B/Cの比較）
│   ├─ 02-content-guide.md … Word/Googleドキュメント → knowledge.json
│   ├─ 03-logging-sheets.md … 入力を常時スプレッドシートに集める
│   ├─ 04-rag-budget.md   … AI（RAG）を足す場合の手順と月額の見積り
│   └─ 05-cloudflare-worker.md … Geminiを安全に呼ぶ中継サーバーの作り方
└─ tools/
    ├─ appscript_sheet_logger.gs … スプレッドシート記録用のスクリプト
    ├─ build_knowledge_from_docx.py … Word原稿→knowledge.json 変換
    └─ cloudflare-worker.js       … Geminiを安全に呼ぶ中継サーバーのコード
```
「アプリ」と「説明」は完全に分けました。 テスト協力者に渡すのは `index.html` と `knowledge.json` が置かれた公開URLだけです。`docs/` は運営・開発用です。
---
GitHub Pages で公開する手順
このフォルダの中身を、GitHub のリポジトリに丸ごとアップロードします。
リポジトリの Settings → Pages を開きます。
Source を「Deploy from a branch」、Branch を `main` /（フォルダは） `/ (root)` に設定して Save。
1〜2分後、`https://<ユーザー名>.github.io/<リポジトリ名>/` で開けます。このURLをテスターに配ります。
> `.nojekyll` を置いてあるので、GitHub 側の変換で `knowledge.json` などが無視される事故を防いでいます。
---
テスト協力者への案内（そのまま使える文面）
> このリンクを開くと、避難時の困りごとを相談できる窓口が開きます。
> 名前やメールは一切いりません。思いつく相談を自由に書いてみて、
> 「返ってきた言葉づかい・長さ・順番」「使いにくかったところ」を、
> 画面右上の **設定 → 感想・改善を送る** から教えてください。
> いつでも右上の **そっと閉じる**（またはキーボードの Esc）で、別の画面に移れます。
---
運営がまず設定する2か所
`index.html` の先頭にある `CONFIG` の中だけを触れば動きます。
```js
const CONFIG = {
  LOG_ENDPOINT: "",                       // ← 入力をスプレッドシートに集めるURL（docs/03）
  AI_ENDPOINT: "",                        // ← AI（Gemini）中継サーバーのURL（docs/05）。空ならAI不使用
  QUICK_EXIT_URL: "https://www.google.com/", // ← 「そっと閉じる」で飛ぶ先
  KNOWLEDGE_URL: "./knowledge.json"       // ← 通常はこのまま
};
```
入力を常時スプレッドシートへ → `docs/03-logging-sheets.md`
相談文面の差し替え（Word/ドキュメントから） → `docs/02-content-guide.md`
AI（RAG）を足したい／月額を抑えたい → `docs/04-rag-budget.md`
Geminiを安全に呼ぶ中継サーバーを作る → `docs/05-cloudflare-worker.md`
---
原稿（Word）は「白紙の雛形」として同梱してあります
`content-template.docx` は、監修原稿を書き込むための空のフォームです。中身を書いて `tools/build_knowledge_from_docx.py` で変換すると `knowledge.json` ができます。原稿ができるまでは、アプリは今入っている `knowledge.json`（仮データ）でそのまま動きます。 手順は `docs/02` を参照してください。
安全上の前提（重要）
このアプリは、性暴力・DV・体調など繊細な相談を、10代を含む利用者が使う前提で作られています。回答は必ず監修済み文面から返し、緊急の相談では画面から相談先が消えない設計にしています。AI（RAG）を足す場合も、この安全性を落とさない形を `docs/04` で説明しています。


RAG（検索拡張生成）とは「モデルの知識だけでなく、外部の資料を根拠に答えさせる」こと。実装には2流派あります。

(A) 全文投入型：資料を丸ごとプロンプトに入れて答えさせる。← 今の中継サーバーはこれ。knowledge.json（＝あなたのDocx由来の内容）を全部Geminiに渡し、その範囲で答えています。
(B) 検索型（いわゆる“RAGシステム”）：資料を細切れ（chunk）にして埋め込み検索で関連部分だけ取り出し、それをプロンプトに入れる。

**今は(A)で、すでにDocxの内容を根拠に答えています。**
(A)で十分な目安：知識ベースが数百chunk／数万トークン程度まで。多くの相談窓口Docxはここに収まります。
(B)が要るのは：Docxが超大規模（何百ページ）、または毎回の大きなプロンプトの費用・速度が気になってきたとき。そのときは Docx → chunk → 埋め込み → 近いものだけ取得 を足します（埋め込みは激安なので費用は変わらず小さいまま）。
