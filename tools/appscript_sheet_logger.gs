/**
 * ぼうさい女子会｜相談窓口アプリ ― スプレッドシート記録スクリプト
 *
 * これは Google スプレッドシートに紐づく Apps Script です。
 * アプリ（index.html）から送られてくる相談ログ・感想を、シートに1行ずつ追記します。
 *
 * 設置手順は docs/03-logging-sheets.md を参照してください。
 */

// ▼ここに、書き込み先スプレッドシートのIDを貼ってください（下の説明参照）▼
// スプレッドシートのURL: https://docs.google.com/spreadsheets/d/【ここがID】/edit
var SPREADSHEET_ID = 'https://docs.google.com/spreadsheets/d/1Lss3MYal0RuN0E0GJNOzxJC5WiYZ4lQ7kx_sQIZFmwo/edit?usp=sharing';
// ▲空のままだと、スクリプトに紐づくシートに書こうとします（紐づいていないと失敗します）▲

// 相談ログを書き込むシート名
var LOG_SHEET = 'ログ';
// 感想・改善を書き込むシート名
var FB_SHEET  = '感想';
// 参加者（ID↔属性）を書き込むシート名
var PT_SHEET  = '参加者';

// 書き込み先スプレッドシートを取得（IDがあればそれを最優先）
function getBook_() {
  if (SPREADSHEET_ID) return SpreadsheetApp.openById(SPREADSHEET_ID);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートに紐づいていません。SPREADSHEET_ID を設定してください。');
  return ss;
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = getBook_();

    if (data.kind === 'feedback') {
      var fb = getOrCreateSheet_(ss, FB_SHEET, ['受信日時', '感想・改善']);
      fb.appendRow([new Date(), String(data.text || '')]);
    } else if (data.kind === 'register') {
      // 参加者登録：ID＋属性のみ（パスワードは受け取りません）
      var pt = getOrCreateSheet_(ss, PT_SHEET,
        ['登録日時', '参加者ID', '性別', '年齢', '性格(MBTI)']);
      pt.appendRow([
        new Date(),
        String(data.id || ''),
        String(data.gender || ''),
        String(data.age || ''),
        String(data.mbti || '')
      ]);
    } else {
      // kind === 'log'（既定）
      var log = getOrCreateSheet_(ss, LOG_SHEET,
        ['受信日時', '参加者ID', '相談の種類', '年代設定', '返しの種類', '情報量', '本文']);
      log.appendRow([
        new Date(),
        String(data.user || ''),
        String(data.topic || ''),
        String(data.age || ''),
        String(data.style || ''),
        String(data.detail || ''),
        String(data.text || '')   // 「本文を残さない」設定のときは空文字が届きます
      ]);
    }
    return json_({ ok: true });
  } catch (err) {
    Logger.log('doPost error: ' + err);  // 「実行数」で理由を確認できます
    return json_({ ok: false, error: String(err) });
  }
}

// 動作確認用：ブラウザで /exec を開くと、書き込み先が掴めているか確認できます
function doGet() {
  try {
    var name = getBook_().getName();
    return json_({ ok: true, message: 'soudan logger is running', book: name });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// 手動テスト用：エディタでこの関数を実行すると、テスト行が書き込まれます
function testWrite() {
  var ss = getBook_();
  getOrCreateSheet_(ss, LOG_SHEET,
    ['受信日時', '参加者ID', '相談の種類', '年代設定', '返しの種類', '情報量', '本文'])
    .appendRow([new Date(), 'TEST', 'test', '', '', '', '手動テスト']);
  Logger.log('書き込み先: ' + ss.getName());
}

function getOrCreateSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(header);
    sh.setFrozenRows(1);
    return sh;
  }
  // 既存シートの見出しが古い（列が変わった）場合は、1行目を新しい見出しに直します。
  // これで、古い「ログ」シートにも「参加者ID」列の見出しが付きます。
  var cur = sh.getRange(1, 1, 1, header.length).getValues()[0];
  var differs = false;
  for (var i = 0; i < header.length; i++) {
    if (String(cur[i] || '') !== header[i]) { differs = true; break; }
  }
  if (differs) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
