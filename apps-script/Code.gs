/**
 * NEQO FAB — お問い合わせ受信スクリプト
 *
 * LP のフォームから POST を受け取り、
 *   1. このスクリプトが紐づいたスプレッドシートに1行追記
 *   2. 通知先アドレスへメール送信
 * を行う。
 *
 * ■ 設置手順
 *   1. Google ドライブで新しいスプレッドシートを作る（名前は「NEQO FAB お問い合わせ」など）
 *   2. 拡張機能 → Apps Script を開き、このファイルの中身を貼り付けて保存
 *   3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *        次のユーザーとして実行 : 自分
 *        アクセスできるユーザー   : 全員          ← ここを「全員」にしないとLPから送れない
 *   4. 出てきた https://script.google.com/macros/s/....../exec を LP の ENDPOINT に貼る
 *
 * ■ 通知先アドレス
 *   既定ではこのスクリプトの持ち主（＝あなたのGoogleアカウント）に送る。
 *   別のアドレスに送りたいときだけ、プロジェクトの設定 → スクリプト プロパティ に
 *   NOTIFY_TO = 送りたいアドレス を追加する。
 *   ソースにアドレスを直接書かないのは、このファイルを公開リポジトリに置くため。
 */

var SHEET_NAME = 'お問い合わせ';
var HEADERS = ['受信日時', '相談の種類', 'お名前', '所属', 'メール', '電話', '気になる機材', 'ご相談内容'];

function doPost(e) {
  try {
    var d = (e && e.parameter) || {};

    // ハニーポット。人間には見えない項目なので、埋まっていたら bot とみなして黙って捨てる。
    // 捨てたことを相手に伝えないのが肝心（伝えると回避される）。
    if (d.hp) {
      return json({ ok: true });
    }

    var row = [
      new Date(),
      d.type || '',
      d.name || '',
      d.org || '',
      d.mail || '',
      d.tel || '',
      d.equipment || '',
      d.message || ''
    ];

    getSheet_().appendRow(row);

    // メールが飛ばなくても記録は残す。通知の失敗で受信そのものを落とさない。
    try {
      notify_(row);
    } catch (mailErr) {
      console.error('notify failed: ' + mailErr);
    }

    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err) });
  }
}

/** 動作確認用。ブラウザで /exec を開いたときにこれが返れば公開できている。 */
function doGet() {
  return json({ ok: true, service: 'NEQO FAB contact' });
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(8, 420); // ご相談内容は広めに
  }
  return sh;
}

function notify_(row) {
  var to = PropertiesService.getScriptProperties().getProperty('NOTIFY_TO')
        || Session.getEffectiveUser().getEmail();
  if (!to) return;

  var ts = row[0], type = row[1], name = row[2], org = row[3];
  var mail = row[4], tel = row[5], equipment = row[6], message = row[7];

  var body = [
    '新しいお問い合わせが届きました。',
    '',
    '受信日時 : ' + Utilities.formatDate(ts, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'),
    '相談の種類 : ' + type,
    'お名前 : ' + name,
    '所属 : ' + (org || '-'),
    'メール : ' + mail,
    '電話 : ' + (tel || '-'),
    '気になる機材 : ' + (equipment || '-'),
    '',
    '--- ご相談内容 ---',
    message,
    '',
    '------',
    'スプレッドシート : ' + SpreadsheetApp.getActiveSpreadsheet().getUrl()
  ].join('\n');

  var options = {
    to: to,
    subject: '【NEQO FAB】新しい相談 / ' + (name || 'お名前なし'),
    body: body
  };
  // そのまま返信すれば相談者に届くようにしておく
  if (mail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) {
    options.replyTo = mail;
  }
  MailApp.sendEmail(options);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
