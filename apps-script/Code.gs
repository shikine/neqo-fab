/**
 * NEQO FAB — お問い合わせ＋日程調整スクリプト
 *
 * LP のフォームから受け取り、
 *   1. スプレッドシートに1行追記
 *   2. 通知先アドレスへメール送信
 * を行う。日程が選ばれていた場合は、承認リンク付きのメールを送り、
 * 承認された時点で Google カレンダーに Meet 付きの予定を作る。
 *
 * ■ 設置手順
 *   1. Google ドライブで新しいスプレッドシートを作る
 *   2. 拡張機能 → Apps Script を開き、このファイルの中身を貼り付けて保存
 *   3. プロジェクトの設定で「appsscript.json マニフェスト ファイルをエディタで表示する」をON
 *      リポジトリの apps-script/appsscript.json の内容を、エディタ側の appsscript.json に貼り付けて保存
 *      （リポジトリに置いただけでは Apps Script プロジェクトへ自動反映されない）
 *   4. ★ サービス（左メニューの「＋」）から「Google Calendar API」を追加する
 *        識別子は Calendar のまま。これが無いと Meet リンクを作れない。
 *   5. エディタから checkSetup を実行し、カレンダー権限を含む承認画面を完了する
 *   6. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *        次のユーザーとして実行 : 自分
 *        アクセスできるユーザー   : 全員          ← 「全員」以外だとLPから送れない
 *   7. 出てきた .../exec を LP の ENDPOINT に貼る
 *
 *   既に設置済みでマニフェストやCalendar APIを後から足した場合は、デプロイを「編集」して
 *   バージョンを「新バージョン」にし直すこと。権限の再承認を求められる。
 *
 * ■ スクリプト プロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   ソースに書かずにここへ入れる。このファイルを公開リポジトリに置くため。
 *
 *   NOTIFY_TO    承認依頼の宛先。未設定ならスクリプトの持ち主に送る。
 *   CALENDAR_ID  予定を入れるカレンダーのID。未設定なら既定のカレンダー。
 *                空き時間の判定も、このカレンダーだけを見る。
 *                IDの調べ方: Googleカレンダー → 対象カレンダーの「設定と共有」
 *                → 「カレンダーの統合」の中の「カレンダーID」
 *                （例: abc...@group.calendar.google.com）
 */

var TZ = 'Asia/Tokyo';
var SHEET_NAME = 'お問い合わせ';
var MEETING_MINUTES = 60;        // 1回の打ち合わせの長さ
var MEETING_BUFFER_MINUTES = 60; // Buffer before and after online meetings.
var LEAD_DAYS = 1;               // 何日先から選べるか（1 = 翌日から）
var HORIZON_DAYS = 14;           // 何日先まで選べるか
var DOW_JP = ['日', '月', '火', '水', '木', '金', '土'];

var HEADERS = [
  '受信日時', '相談の種類', 'お名前', '所属', 'メール', '電話', '気になる機材', 'ご相談内容',
  '希望日時', 'ステータス', '承認トークン', 'カレンダーID'
];
var COL = { // 1始まり。HEADERS と対応させること
  TS: 1, TYPE: 2, NAME: 3, ORG: 4, MAIL: 5, TEL: 6, EQUIP: 7, MSG: 8,
  SLOT: 9, STATUS: 10, TOKEN: 11, EVENT: 12
};

// ============================================================
// 設置の確認
// ============================================================

/**
 * エディタでこの関数を選んで「実行」する。
 *   1回目 : 権限の承認画面が出るので許可する（カレンダーを読むため）
 *   2回目 : 設定がそろっているかが実行ログに出る
 * 予定は作らないので、何度実行しても副作用はない。
 */
function checkSetup() {
  var out = [];

  out.push('CALENDAR_ID : ' + calendarId_());
  try {
    out.push('カレンダー : 「' + calendar_().getName() + '」を読めました');
  } catch (e) {
    out.push('カレンダー : NG → ' + e);
  }

  // 詳細サービスが追加されているか。API は呼ばずに存在確認だけする。
  if (typeof Calendar === 'undefined' || !Calendar.Events) {
    out.push('Calendar API サービス : 未追加 → エディタ左「サービス」の＋から Google Calendar API を追加');
  } else {
    out.push('Calendar API サービス : 追加済み');
  }

  try {
    var days = buildSlots_();
    var total = days.reduce(function (a, d) { return a + d.times.length; }, 0);
    out.push('空き枠 : ' + days.length + '日ぶん / 合計' + total + '枠');
    if (days.length) {
      out.push('  最初の日 : ' + days[0].label + ' → ' +
        days[0].times.map(function (t) { return t.t; }).join(' '));
    } else {
      out.push('  （0件。カレンダーが埋まっているか、受付時間の設定を確認）');
    }
  } catch (e) {
    out.push('空き枠 : NG → ' + e);
  }

  out.push('通知先 : ' +
    (PropertiesService.getScriptProperties().getProperty('NOTIFY_TO') || Session.getEffectiveUser().getEmail()));

  var msg = out.join('\n');
  console.log(msg);
  return msg;
}

// ============================================================
// エントリポイント
// ============================================================

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';

  if (action === 'slots') {
    // LP が「日程も決めたい」を開いたときに叩く。空き枠の一覧を返す。
    try {
      return json({ ok: true, tz: TZ, minutes: MEETING_MINUTES, days: buildSlots_() });
    } catch (err) {
      console.error(err);
      return json({ ok: false, error: String(err) });
    }
  }

  if (action === 'approve' || action === 'decline') {
    return handleDecision_(e, action);
  }

  return json({ ok: true, service: 'NEQO FAB contact' });
}

function doPost(e) {
  try {
    var d = (e && e.parameter) || {};

    // ハニーポット。人間には見えない項目なので、埋まっていたら bot とみなして黙って捨てる。
    // 捨てたことを相手に伝えないのが肝心（伝えると回避される）。
    if (d.hp) return json({ ok: true });

    var slotIso = (d.slot || '').trim();
    var slotStart = null;

    if (slotIso) {
      slotStart = new Date(slotIso);
      if (isNaN(slotStart.getTime())) {
        return json({ ok: false, reason: 'bad_slot' });
      }
      // クライアントの申告は信用しない。いま本当に空いているか毎回サーバ側で確かめる。
      // フォームを開いてから送信するまでに埋まることがあるため。
      if (!isSlotOpen_(slotStart)) {
        return json({ ok: false, reason: 'slot_taken' });
      }
    }

    var sheet = getSheet_();
    var token = slotStart ? Utilities.getUuid() : '';
    var row = [
      new Date(),
      d.type || '',
      d.name || '',
      d.org || '',
      d.mail || '',
      d.tel || '',
      d.equipment || '',
      d.message || '',
      slotStart ? Utilities.formatDate(slotStart, TZ, 'yyyy/MM/dd HH:mm') : '',
      slotStart ? '承認待ち' : '',
      token,
      ''
    ];
    sheet.appendRow(row);

    // メールが飛ばなくても記録は残す。通知の失敗で受信そのものを落とさない。
    try {
      notify_(row, slotStart, token);
    } catch (mailErr) {
      console.error('notify failed: ' + mailErr);
    }

    return json({ ok: true, scheduled: !!slotStart });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err) });
  }
}

// ============================================================
// 空き枠の計算
// ============================================================

/** JST の曜日 0=日 .. 6=土 */
function jstDow_(date) {
  return new Date(date.getTime() + 9 * 3600 * 1000).getUTCDay();
}

/** JST の年月日 */
function jstYmd_(date) {
  var s = new Date(date.getTime() + 9 * 3600 * 1000);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate() };
}

/** JST の壁時計時刻から Date を作る */
function jstAt_(y, m, d, h) {
  return new Date(Date.UTC(y, m - 1, d, h - 9, 0, 0));
}

/**
 * その曜日に開始できる時刻（時）の一覧。
 *   平日: 6-7 / 10-15 / 22-24 を除く → 7,8,9 と 15..21
 *   土日: 10-18                         → 10..17
 * 深夜 0-6 はどちらも除外している（指定には無かったが、深夜に予約が入る事故を防ぐため）。
 * ここを変えれば受付時間が変わる。
 */
function allowedHours_(dow) {
  var hours = [], h;
  var weekend = (dow === 0 || dow === 6);
  if (weekend) {
    for (h = 10; h < 18; h++) hours.push(h);
  } else {
    for (h = 7; h < 10; h++) hours.push(h);
    for (h = 15; h < 22; h++) hours.push(h);
  }
  return hours;
}

/** 予定を入れる／空きを見るカレンダーのID。未設定なら既定のカレンダー。 */
function calendarId_() {
  return PropertiesService.getScriptProperties().getProperty('CALENDAR_ID') || 'primary';
}

function calendar_() {
  var id = calendarId_();
  if (id === 'primary') return CalendarApp.getDefaultCalendar();
  var cal = CalendarApp.getCalendarById(id);
  if (!cal) {
    throw new Error('CALENDAR_ID のカレンダーが見つかりません: ' + id +
      '（IDが正しいか、このアカウントからアクセスできるか確認してください）');
  }
  return cal;
}

/** カレンダー上でふさがっている区間（終日予定は除く）。範囲ぶんまとめて取る。 */
function busyRanges_(from, to) {
  return calendar_().getEvents(from, to)
    .filter(function (ev) {
      if (ev.isAllDayEvent()) return false;                 // 終日予定は打ち合わせを妨げない扱い
      var s = ev.getMyStatus && ev.getMyStatus();
      if (s === CalendarApp.GuestStatus.NO) return false;    // 自分が欠席と答えた予定は無視
      return true;
    })
    .map(function (ev) { return { s: ev.getStartTime().getTime(), e: ev.getEndTime().getTime() }; });
}

function overlaps_(startMs, endMs, ranges) {
  for (var i = 0; i < ranges.length; i++) {
    if (startMs < ranges[i].e && endMs > ranges[i].s) return true;
  }
  return false;
}

/** 予約できる範囲（翌日0時 〜 HORIZON_DAYS 日後の終わり） */
function window_() {
  var now = new Date();
  var t = jstYmd_(now);
  var from = jstAt_(t.y, t.m, t.d, 0);
  from = new Date(from.getTime() + LEAD_DAYS * 24 * 3600 * 1000);
  var to = new Date(from.getTime() + HORIZON_DAYS * 24 * 3600 * 1000);
  return { from: from, to: to };
}

/** LP に渡す空き枠。日付ごとにまとめる。 */
function buildSlots_() {
  var w = window_();
  var busy = busyRanges_(w.from, w.to);
  var pending = pendingSlotMs_();   // 承認待ちの枠も埋まっている扱いにする
  var days = [];

  for (var cur = w.from.getTime(); cur < w.to.getTime(); cur += 24 * 3600 * 1000) {
    var day = new Date(cur);
    var ymd = jstYmd_(day);
    var dow = jstDow_(day);
    var times = [];

    allowedHours_(dow).forEach(function (h) {
      var s = jstAt_(ymd.y, ymd.m, ymd.d, h);
      var e = new Date(s.getTime() + MEETING_MINUTES * 60 * 1000);
      if (s.getTime() <= Date.now()) return;
      var bufferMs = MEETING_BUFFER_MINUTES * 60 * 1000;
      if (overlaps_(s.getTime() - bufferMs, e.getTime() + bufferMs, busy)) return;
      if (pending.some(function (pendingStart) {
        return Math.abs(pendingStart - s.getTime()) < (MEETING_MINUTES + MEETING_BUFFER_MINUTES) * 60 * 1000;
      })) return;
      times.push({
        v: Utilities.formatDate(s, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
        t: Utilities.formatDate(s, TZ, 'HH:mm')
      });
    });

    if (times.length) {
      days.push({
        d: Utilities.formatDate(day, TZ, 'yyyy-MM-dd'),
        label: ymd.m + '月' + ymd.d + '日(' + DOW_JP[dow] + ')',
        times: times
      });
    }
  }
  return days;
}

/** 承認待ちで押さえられている開始時刻（ミリ秒）の一覧 */
function pendingSlotMs_() {
  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, COL.SLOT, last - 1, 2).getValues(); // 希望日時・ステータス
  var out = [];
  values.forEach(function (r) {
    if (r[1] !== '承認待ち' || !r[0]) return;
    var d = (r[0] instanceof Date) ? r[0] : new Date(String(r[0]).replace(/\//g, '-'));
    if (!isNaN(d.getTime())) out.push(d.getTime());
  });
  return out;
}

/** その1枠がいま押さえられるか */
function isSlotOpen_(start) {
  var end = new Date(start.getTime() + MEETING_MINUTES * 60 * 1000);
  var w = window_();
  if (start.getTime() < w.from.getTime() || start.getTime() >= w.to.getTime()) return false;

  var ymd = jstYmd_(start);
  var hourJst = new Date(start.getTime() + 9 * 3600 * 1000).getUTCHours();
  if (allowedHours_(jstDow_(start)).indexOf(hourJst) < 0) return false;
  // 正時ちょうどでない指定は受けない
  if (start.getTime() !== jstAt_(ymd.y, ymd.m, ymd.d, hourJst).getTime()) return false;

  var bufferMs = MEETING_BUFFER_MINUTES * 60 * 1000;
  if (overlaps_(start.getTime() - bufferMs, end.getTime() + bufferMs, busyRanges_(
    new Date(start.getTime() - bufferMs), new Date(end.getTime() + bufferMs)
  ))) return false;
  if (pendingSlotMs_().some(function (pendingStart) {
    return Math.abs(pendingStart - start.getTime()) < (MEETING_MINUTES + MEETING_BUFFER_MINUTES) * 60 * 1000;
  })) return false;
  return true;
}

// ============================================================
// 承認 / 見送り
// ============================================================

function handleDecision_(e, action) {
  var token = (e.parameter.token || '').trim();
  if (!token) return page_('リンクが正しくありません', 'トークンがありません。');

  var sh = getSheet_();
  var last = sh.getLastRow();
  var rowIdx = -1;
  for (var r = 2; r <= last; r++) {
    if (String(sh.getRange(r, COL.TOKEN).getValue()) === token) { rowIdx = r; break; }
  }
  if (rowIdx < 0) return page_('見つかりませんでした', 'この依頼は既に処理済みか、リンクが古い可能性があります。');

  var status = String(sh.getRange(rowIdx, COL.STATUS).getValue());
  if (status !== '承認待ち') {
    return page_('処理済みです', 'この依頼は既に「' + status + '」になっています。');
  }

  var name = String(sh.getRange(rowIdx, COL.NAME).getValue());
  var mail = String(sh.getRange(rowIdx, COL.MAIL).getValue());
  var msg = String(sh.getRange(rowIdx, COL.MSG).getValue());
  var slotRaw = sh.getRange(rowIdx, COL.SLOT).getValue();
  var start = (slotRaw instanceof Date) ? slotRaw : new Date(String(slotRaw).replace(/\//g, '-'));

  if (action === 'decline') {
    sh.getRange(rowIdx, COL.STATUS).setValue('見送り');
    sh.getRange(rowIdx, COL.TOKEN).setValue('');   // 使い捨て
    return page_('見送りにしました', name + ' 様の希望日時を見送りとして記録しました。メールで調整のご連絡をお願いします。');
  }

  // 承認。念のためもう一度カレンダーを見る（承認までの間に予定が入ることがある）
  var end = new Date(start.getTime() + MEETING_MINUTES * 60 * 1000);
  var bufferMs = MEETING_BUFFER_MINUTES * 60 * 1000;
  if (overlaps_(start.getTime() - bufferMs, end.getTime() + bufferMs, busyRanges_(
    new Date(start.getTime() - bufferMs), new Date(end.getTime() + bufferMs)
  ))) {
    return page_('この時間には既に予定があります',
      'カレンダーに別の予定が入っています。予定を整理してからもう一度リンクを開くか、メールで日程を調整してください。');
  }

  var meetUrl = '';
  var eventId = '';
  try {
    var created = Calendar.Events.insert({
      summary: '【NEQO FAB】相談 / ' + (name || 'お名前なし'),
      description: 'LPのフォームから申し込まれた相談です。\n\n' + msg,
      start: { dateTime: Utilities.formatDate(start, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"), timeZone: TZ },
      end: { dateTime: Utilities.formatDate(end, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"), timeZone: TZ },
      attendees: mail ? [{ email: mail }] : [],
      // 申込者（ゲスト）側では動かせないようにする。
      // 予定の正本はスプレッドシートなので、相手に日時を書き換えられると食い違う。
      // なお、カレンダーの所有者自身の編集・削除は Google の仕様上ここでは止められない
      // （API の locked は読み取り専用）。所有者の操作を検知したい場合は別途トリガーが要る。
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: false,
      conferenceData: {
        createRequest: {
          requestId: Utilities.getUuid(),
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    }, calendarId_(), { conferenceDataVersion: 1, sendUpdates: 'all' });
    meetUrl = created.hangoutLink || '';
    eventId = created.id || '';
  } catch (err) {
    console.error(err);
    return page_('カレンダーに登録できませんでした',
      'Google Calendar API のサービスが追加されているか、CALENDAR_ID が正しいかを確認してください。\n\n詳細: ' + err);
  }

  sh.getRange(rowIdx, COL.STATUS).setValue('確定');
  sh.getRange(rowIdx, COL.TOKEN).setValue('');   // 使い捨て
  sh.getRange(rowIdx, COL.EVENT).setValue(eventId);

  // 申込者にも確定を伝える（カレンダー招待とは別に、文章で残す）
  if (mail) {
    try {
      MailApp.sendEmail({
        to: mail,
        subject: '【NEQO FAB】ご相談の日時が確定しました',
        body: [
          (name || 'ご担当者') + ' 様',
          '',
          'ご相談の日時が確定しました。当日はオンラインでお話しします。',
          '',
          '日時 : ' + Utilities.formatDate(start, TZ, 'yyyy年M月d日(') + DOW_JP[jstDow_(start)] + ') ' +
            Utilities.formatDate(start, TZ, 'HH:mm') + '〜' + Utilities.formatDate(end, TZ, 'HH:mm'),
          'Meet : ' + (meetUrl || '（カレンダーの招待をご覧ください）'),
          '',
          'カレンダーの招待もお送りしています。ご都合が変わった場合は、このメールにご返信ください。',
          '',
          'NEQO FAB（ねこふぁぶ）／ 長野県諏訪郡富士見町'
        ].join('\n')
      });
    } catch (err) {
      console.error('confirm mail failed: ' + err);
    }
  }

  return page_('確定しました',
    Utilities.formatDate(start, TZ, 'M月d日 HH:mm') + ' で登録しました。' +
    '相手にも招待と確認メールを送っています。' + (meetUrl ? '\nMeet: ' + meetUrl : ''));
}

// ============================================================
// 通知メール
// ============================================================

function notify_(row, slotStart, token) {
  var to = PropertiesService.getScriptProperties().getProperty('NOTIFY_TO')
        || Session.getEffectiveUser().getEmail();
  if (!to) return;

  var ts = row[COL.TS - 1], type = row[COL.TYPE - 1], name = row[COL.NAME - 1];
  var org = row[COL.ORG - 1], mail = row[COL.MAIL - 1], tel = row[COL.TEL - 1];
  var equipment = row[COL.EQUIP - 1], message = row[COL.MSG - 1];

  var lines = [
    '新しいお問い合わせが届きました。',
    '',
    '受信日時 : ' + Utilities.formatDate(ts, TZ, 'yyyy/MM/dd HH:mm'),
    '相談の種類 : ' + type,
    'お名前 : ' + name,
    'メール : ' + mail
  ];
  // 所属・電話・機材はフォームから外したが、過去データのために列は残してある。
  // 値が入っているときだけ出す（空の「-」が並ぶと読みにくいので）。
  if (org) lines.push('所属 : ' + org);
  if (tel) lines.push('電話 : ' + tel);
  if (equipment) lines.push('気になる機材 : ' + equipment);
  lines.push('');
  lines.push('--- ご相談内容 ---');
  lines.push(message);
  lines.push('');

  if (slotStart) {
    var end = new Date(slotStart.getTime() + MEETING_MINUTES * 60 * 1000);
    var base = ScriptApp.getService().getUrl();
    lines.push('------');
    lines.push('▼ 希望日時（承認待ち）');
    lines.push(Utilities.formatDate(slotStart, TZ, 'yyyy年M月d日(') + DOW_JP[jstDow_(slotStart)] + ') ' +
      Utilities.formatDate(slotStart, TZ, 'HH:mm') + '〜' + Utilities.formatDate(end, TZ, 'HH:mm') +
      '（' + MEETING_MINUTES + '分・Google Meet）');
    lines.push('');
    lines.push('承認する（カレンダーに登録し、相手に招待を送ります）:');
    lines.push(base + '?action=approve&token=' + encodeURIComponent(token));
    lines.push('');
    lines.push('見送る（記録だけ残します。日程はこのメールに返信して調整してください）:');
    lines.push(base + '?action=decline&token=' + encodeURIComponent(token));
    lines.push('');
    lines.push('※ このリンクは1回だけ有効です。承認するまで、この枠は他の人から選べません。');
    lines.push('');
  }

  lines.push('------');
  lines.push('スプレッドシート : ' + SpreadsheetApp.getActiveSpreadsheet().getUrl());

  var options = {
    to: to,
    subject: '【NEQO FAB】' + (slotStart ? '日程の承認依頼' : '新しい相談') + ' / ' + (name || 'お名前なし'),
    body: lines.join('\n')
  };
  // そのまま返信すれば相談者に届くようにしておく
  if (mail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) options.replyTo = mail;
  MailApp.sendEmail(options);
}

// ============================================================
// 小道具
// ============================================================

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(COL.MSG, 420);
  } else if (sh.getLastColumn() < HEADERS.length) {
    // 日程の列を後から足した場合の移行。既存の行はそのまま残る。
    var from = sh.getLastColumn() + 1;
    var add = HEADERS.slice(from - 1);
    sh.getRange(1, from, 1, add.length).setValues([add]).setFontWeight('bold');
  }
  return sh;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 承認リンクを開いたときに出す画面 */
function page_(title, body) {
  var html =
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font-family:-apple-system,Segoe UI,Hiragino Kaku Gothic ProN,sans-serif;' +
    'max-width:34em;margin:14vh auto;padding:0 24px;line-height:1.8;color:#22271F">' +
    '<div style="font-size:11px;letter-spacing:.12em;color:#47603F">NEQO FAB</div>' +
    '<h1 style="font-size:20px;margin:6px 0 12px">' + escapeHtml_(title) + '</h1>' +
    '<p style="font-size:14px;white-space:pre-wrap;margin:0">' + escapeHtml_(body) + '</p>' +
    '</div>';
  return HtmlService.createHtmlOutput(html);
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
