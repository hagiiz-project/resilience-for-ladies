/**
 * ぼうさい女子会｜相談窓口アプリ ― スプレッドシート記録スクリプト
 *
 * これは Google スプレッドシートに紐づく Apps Script です。
 * アプリ（index.html）から送られてくる相談ログ・感想を、シートに1行ずつ追記します。
 *
 * 設置手順は docs/03-logging-sheets.md を参照してください。
 */

// 相談ログを書き込むシート名
var LOG_SHEET = 'ログ';
// 感想・改善を書き込むシート名
var FB_SHEET  = '感想';
// 参加者（ID↔属性）を書き込むシート名
var PT_SHEET  = '参加者';

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (data.kind === 'feedback') {
      var fb = getOrCreateSheet_(ss, FB_SHEET, ['受信日時', '感想・改善']);
      fb.appendRow([new Date(), String(data.text || '')]);
    } else if (data.kind === 'register') {
      // 参加者登録：ID＋属性のみ（パスワードは受け取りません）
      var pt = getOrCreateSheet_(ss, PT_SHEET,
        ['登録日時', '参加者ID', '性別', '年代', '性格(MBTI)']);
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
    return json_({ ok: false, error: String(err) });
  }
}

// 動作確認用（ブラウザで /exec を開くと OK が出ます）
function doGet() {
  return json_({ ok: true, message: 'soudan logger is running' });
}

function getOrCreateSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(header);
    sh.setFrozenRows(1);
  }
  return sh;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
