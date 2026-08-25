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
 *   STRIPE_SECRET_KEY  Stripe のシークレットキー。最初は必ず sk_test_... を設定する。
 *   STRIPE_MODE        test または live。未設定時は test。live は明示設定時だけ許可。
 *   送料はスマートレター／レターパックライトの全国一律料金をコード内で計算する。
 */

var TZ = 'Asia/Tokyo';
var SHEET_NAME = 'お問い合わせ';
var MEETING_MINUTES = 60;        // 1回の打ち合わせの長さ
var MEETING_BUFFER_MINUTES = 60; // Buffer before and after online meetings.
var MEETING_LIMIT_PER_DAY = 1;
var MEETING_LIMIT_PER_WEEK = 2;
var MEETING_LIMIT_PER_MONTH = 4;
var LEAD_DAYS = 1;               // 何日先から選べるか（1 = 翌日から）
var HORIZON_DAYS = 14;           // 何日先まで選べるか
var DOW_JP = ['日', '月', '火', '水', '木', '金', '土'];

var HEADERS = [
  '受信日時', '相談の種類', 'お名前', '所属', 'メール', '電話', '気になる機材', 'ご相談内容',
  '希望日時', 'ステータス', '承認トークン', 'カレンダーID',
  '注文ID', '材料量(g)', '単価', '個数', '決済状態', 'Stripe Session',
  '配送方法', '送料'
];
var COL = { // 1始まり。HEADERS と対応させること
  TS: 1, TYPE: 2, NAME: 3, ORG: 4, MAIL: 5, TEL: 6, EQUIP: 7, MSG: 8,
  SLOT: 9, STATUS: 10, TOKEN: 11, EVENT: 12,
  ORDER_ID: 13, GRAMS: 14, UNIT_PRICE: 15, QTY: 16, PAYMENT: 17, STRIPE_SESSION: 18,
  SHIP_METHOD: 19, SHIPPING: 20
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

  // 秘密鍵そのものはログへ出さず、設定の有無とモードの整合性だけ確認する。
  var props = PropertiesService.getScriptProperties();
  var stripeMode = String(props.getProperty('STRIPE_MODE') || 'test').toLowerCase();
  var stripeKey = String(props.getProperty('STRIPE_SECRET_KEY') || '');
  var stripeReady = (stripeMode === 'test' && stripeKey.indexOf('sk_test_') === 0) ||
    (stripeMode === 'live' && stripeKey.indexOf('sk_live_') === 0);
  out.push('Stripe : ' + (stripeReady ? '設定済み' : '未設定またはモード不一致') + '（' + stripeMode + '）');
  out.push('配送 : スマートレター 210円／レターパックライト 430円');

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

  if (action === 'paymentStatus') {
    try {
      return json(paymentStatus_(e.parameter.session_id || ''));
    } catch (err) {
      console.error('payment status failed: ' + err);
      return json({ ok: false, error: 'payment_status_failed' });
    }
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
    var bookingLock = null;

    if (slotIso) {
      slotStart = new Date(slotIso);
      if (isNaN(slotStart.getTime())) {
        return json({ ok: false, reason: 'bad_slot' });
      }
      // クライアントの申告は信用しない。いま本当に空いているか毎回サーバ側で確かめる。
      // フォームを開いてから送信するまでに埋まることがあるため。
      bookingLock = LockService.getScriptLock();
      bookingLock.waitLock(10000);
      if (!isSlotOpen_(slotStart)) {
        bookingLock.releaseLock();
        return json({ ok: false, reason: 'slot_taken' });
      }
      var meetingLimit = meetingLimitReason_(d.mail || '', slotStart);
      if (meetingLimit) {
        bookingLock.releaseLock();
        return json({ ok: false, reason: 'booking_limit', limit: meetingLimit });
      }
    }

    var sheet = getSheet_();
    var token = slotStart ? Utilities.getUuid() : '';
    var isOrder = (d.type === 'ぷくぷくキーホルダー注文');
    var wantsCheckout = isOrder && String(d.checkout || '') === '1';
    var quote = wantsCheckout ? calculateOrderQuote_(d) : null;
    var orderId = isOrder ? Utilities.getUuid() : '';
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
      '',
      orderId,
      quote ? quote.grams : '',
      quote ? quote.unitPriceYen : '',
      quote ? quote.qty : '',
      quote ? '決済待ち' : '',
      '',
      quote ? quote.shippingLabel : '',
      quote ? quote.shippingYen : ''
    ];
    sheet.appendRow(row);
    var rowIndex = sheet.getLastRow();
    if (bookingLock) bookingLock.releaseLock();

    // 注文記録を先に残してから、Stripe のホスト型決済画面を作る。
    // Stripe キーはスクリプトプロパティからだけ読み、ソースやブラウザへは返さない。
    var checkout = null;
    if (quote) {
      try {
        checkout = createCheckoutSession_(d, quote, orderId);
        sheet.getRange(rowIndex, COL.STRIPE_SESSION).setValue(checkout.id || '');
        row[COL.STRIPE_SESSION - 1] = checkout.id || '';
      } catch (checkoutErr) {
        sheet.getRange(rowIndex, COL.PAYMENT).setValue('決済作成エラー');
        row[COL.PAYMENT - 1] = '決済作成エラー';
        console.error('checkout create failed: ' + checkoutErr);
      }
    }

    // ぷくぷくキーホルダー注文なら、部品データ（STL）を管理者メールに添付し、
    // 注文者には完成予想図（PNG）を送る。失敗しても記録・受信は落とさない。
    var adminAttachments = [];
    try { adminAttachments = buildOrderAttachments_(d); } catch (e) { console.error('attach build failed: ' + e); }

    // メールが飛ばなくても記録は残す。通知の失敗で受信そのものを落とさない。
    try {
      notify_(row, slotStart, token, adminAttachments);
    } catch (mailErr) {
      console.error('notify failed: ' + mailErr);
    }

    // 注文者への自動返信（完成予想図つき）。任意項目なので失敗は無視。
    try {
      if (d.previewPng && (!quote || checkout)) {
        confirmOrder_(d.name || '', d.mail || '', d.previewPng, d.slug || '');
      }
    } catch (e) {
      console.error('order confirm mail failed: ' + e);
    }

    if (quote && !checkout) {
      return json({ ok: false, reason: 'checkout_unavailable', orderId: orderId });
    }
    return json({
      ok: true,
      scheduled: !!slotStart,
      orderId: orderId || undefined,
      checkoutUrl: checkout ? checkout.url : undefined,
      unitPriceYen: quote ? quote.unitPriceYen : undefined,
      shippingYen: quote ? quote.shippingYen : undefined,
      totalYen: quote ? quote.totalYen : undefined
    });
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

/** 同じメールアドレスによるオンライン相談の申込上限（日・月曜始まりの週・月）を調べる。 */
function meetingLimitReason_(mail, start) {
  var normalizedMail = String(mail || '').trim().toLowerCase();
  if (!normalizedMail) return 'day';

  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last < 2) return '';

  var targetYmd = jstYmd_(start);
  var dayMs = 24 * 3600 * 1000;
  var targetDay = jstAt_(targetYmd.y, targetYmd.m, targetYmd.d, 0).getTime();
  var targetWeek = targetDay - ((jstDow_(start) + 6) % 7) * dayMs;
  var dayCount = 0, weekCount = 0, monthCount = 0;
  var values = sh.getRange(2, COL.MAIL, last - 1, COL.STATUS - COL.MAIL + 1).getValues();

  values.forEach(function (row) {
    if (String(row[0] || '').trim().toLowerCase() !== normalizedMail) return;
    var status = String(row[COL.STATUS - COL.MAIL] || '');
    if (status !== '\u627f\u8a8d\u5f85\u3061' && status !== '\u78ba\u5b9a') return;
    var raw = row[COL.SLOT - COL.MAIL];
    if (!raw) return;
    var date = (raw instanceof Date) ? raw : new Date(String(raw).replace(/\//g, '-'));
    if (isNaN(date.getTime())) return;

    var ymd = jstYmd_(date);
    var rowDay = jstAt_(ymd.y, ymd.m, ymd.d, 0).getTime();
    var rowWeek = rowDay - ((jstDow_(date) + 6) % 7) * dayMs;
    if (rowDay === targetDay) dayCount++;
    if (rowWeek === targetWeek) weekCount++;
    if (ymd.y === targetYmd.y && ymd.m === targetYmd.m) monthCount++;
  });

  if (dayCount >= MEETING_LIMIT_PER_DAY) return 'day';
  if (weekCount >= MEETING_LIMIT_PER_WEEK) return 'week';
  if (monthCount >= MEETING_LIMIT_PER_MONTH) return 'month';
  return '';
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

function notify_(row, slotStart, token, attachments) {
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
  if (row[COL.ORDER_ID - 1]) {
    lines.push('注文ID : ' + row[COL.ORDER_ID - 1]);
    lines.push('材料量 : ' + row[COL.GRAMS - 1] + ' g');
    lines.push('単価 : ¥' + row[COL.UNIT_PRICE - 1] + ' × ' + row[COL.QTY - 1] + '個');
    lines.push('決済状態 : ' + row[COL.PAYMENT - 1]);
  }
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

  if (attachments && attachments.length) {
    lines.push('------');
    lines.push('▼ 製造データ（このメールに添付）');
    lines.push('・フチ（お皿）部品と文字部品を別々の STL で添付しています。');
    lines.push('・2色でそれぞれ出力し、重ねて組み合わせると完成します（同じ原点・同じ向き）。');
    lines.push('');
  }

  var options = {
    to: to,
    subject: '【NEQO FAB】' + (row[COL.ORDER_ID - 1] ? '新しい注文' : (slotStart ? '日程の承認依頼' : '新しい相談')) + ' / ' + (name || 'お名前なし'),
    body: lines.join('\n')
  };
  if (attachments && attachments.length) options.attachments = attachments;
  // そのまま返信すれば相談者に届くようにしておく
  if (mail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) options.replyTo = mail;
  MailApp.sendEmail(options);
}

// ============================================================
// ぷくぷくキーホルダー注文：添付データと注文者への自動返信
// ============================================================

var ORDER_PLA_DENSITY = 1.24;
var ORDER_MATERIAL_MARGIN = 1.08;
var ORDER_JOB_OVERHEAD_G = 0.35;
var ORDER_FLOOR_MM = 1.2;
var ORDER_WALL_MM = 1.4;
var ORDER_BASE_YEN = 700;
var ORDER_YEN_PER_GRAM = 50;
var ORDER_MINIMUM_YEN = 900;
var ORDER_ROUND_YEN = 100;
var CREATOR_URL = 'https://shikine.github.io/neqo-fab/creator/';

/** 全国一律の封筒料金（2026-08-25確認）。 */
function shippingQuote_(method, qty, bounds) {
  var key = String(method || 'light').trim();
  if (key === 'smart') {
    if (qty !== 1) throw new Error('smart_letter_quantity');
    var fitsA5 = bounds && ((bounds.width <= 235 && bounds.height <= 155) ||
      (bounds.width <= 155 && bounds.height <= 235));
    if (!fitsA5) throw new Error('smart_letter_size');
    return { key: key, label: 'スマートレター', yen: 210 };
  }
  if (key === 'light') return { key: key, label: 'レターパックライト', yen: 430 };
  throw new Error('bad_shipping_method');
}

/** data URL から base64 本体だけを取り出す。 */
function base64Body_(data) {
  var s = String(data || '');
  var comma = s.indexOf(',');
  return (s.slice(0, 5) === 'data:' && comma >= 0) ? s.slice(comma + 1) : s;
}

/** ブラウザが生成した binary STL の閉メッシュ体積と外寸を求める。 */
function stlMetricsMm_(data) {
  var b64 = base64Body_(data);
  if (!b64 || b64.length > 12 * 1024 * 1024) throw new Error('bad_stl_size');
  var signed = Utilities.base64Decode(b64);
  if (signed.length < 84) throw new Error('bad_stl_header');
  var u8 = new Uint8Array(signed.length);
  for (var i = 0; i < signed.length; i++) u8[i] = signed[i] & 255;
  var dv = new DataView(u8.buffer);
  var triangles = dv.getUint32(80, true);
  if (!triangles || 84 + triangles * 50 > u8.length) throw new Error('bad_stl_triangles');

  var sum = 0;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function f(off) { return dv.getFloat32(off, true); }
  for (var t = 0; t < triangles; t++) {
    var p = 84 + t * 50 + 12;
    var ax = f(p), ay = f(p + 4), az = f(p + 8);
    var bx = f(p + 12), by = f(p + 16), bz = f(p + 20);
    var cx = f(p + 24), cy = f(p + 28), cz = f(p + 32);
    minX = Math.min(minX, ax, bx, cx); maxX = Math.max(maxX, ax, bx, cx);
    minY = Math.min(minY, ay, by, cy); maxY = Math.max(maxY, ay, by, cy);
    sum += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  var volume = Math.abs(sum);
  if (!isFinite(volume) || volume <= 0) throw new Error('bad_stl_volume');
  return { volume: volume, width: maxX - minX, height: maxY - minY };
}

function stlVolumeMm3_(data) {
  return stlMetricsMm_(data).volume;
}

/** クライアントの申告価格を信用せず、送られた製造STLからサーバー側で再計算する。 */
function calculateOrderQuote_(d) {
  var qty = parseInt(d.qty, 10);
  if (!isFinite(qty) || qty < 1 || qty > 5) throw new Error('bad_quantity');
  var textMm3 = stlVolumeMm3_(d.lettersStl);
  var floorMetrics = stlMetricsMm_(d.floorStl);
  var floorMm3 = floorMetrics.volume;
  var rimMm3 = stlVolumeMm3_(d.rimStl);
  // 底と壁は重なっているため、スライサーで一体化される重複分を二重計上しない。
  var borderMm3 = floorMm3 + rimMm3 * (ORDER_WALL_MM / (ORDER_FLOOR_MM + ORDER_WALL_MM));
  var textG = textMm3 / 1000 * ORDER_PLA_DENSITY * ORDER_MATERIAL_MARGIN + ORDER_JOB_OVERHEAD_G;
  var borderG = borderMm3 / 1000 * ORDER_PLA_DENSITY * ORDER_MATERIAL_MARGIN + ORDER_JOB_OVERHEAD_G;
  var grams = textG + borderG;
  if (!isFinite(grams) || grams < 0.5 || grams > 250) throw new Error('bad_material_amount');

  var raw = Math.max(ORDER_MINIMUM_YEN, ORDER_BASE_YEN + grams * ORDER_YEN_PER_GRAM);
  var unit = Math.ceil(raw / ORDER_ROUND_YEN) * ORDER_ROUND_YEN;
  var shipping = shippingQuote_(d.shippingMethod, qty, floorMetrics);
  return {
    qty: qty,
    grams: Math.round(grams * 10) / 10,
    unitPriceYen: unit,
    shippingMethod: shipping.key,
    shippingLabel: shipping.label,
    shippingYen: shipping.yen,
    totalYen: unit * qty + shipping.yen
  };
}

function stripeConfig_() {
  var props = PropertiesService.getScriptProperties();
  var key = String(props.getProperty('STRIPE_SECRET_KEY') || '').trim();
  var mode = String(props.getProperty('STRIPE_MODE') || 'test').toLowerCase();
  if (mode !== 'test' && mode !== 'live') throw new Error('bad_stripe_mode');
  if (mode === 'test' && key.indexOf('sk_test_') !== 0) throw new Error('stripe_test_key_required');
  if (mode === 'live' && key.indexOf('sk_live_') !== 0) throw new Error('stripe_live_key_required');
  return { key: key, mode: mode };
}

function stripeRequest_(method, path, payload, idempotencyKey) {
  var cfg = stripeConfig_();
  var options = {
    method: method,
    headers: { Authorization: 'Bearer ' + cfg.key },
    muteHttpExceptions: true
  };
  if (payload) options.payload = payload;
  if (idempotencyKey) options.headers['Idempotency-Key'] = idempotencyKey;
  var res = UrlFetchApp.fetch('https://api.stripe.com' + path, options);
  var code = res.getResponseCode();
  var body;
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = {}; }
  if (code < 200 || code >= 300) {
    var msg = body && body.error && body.error.message ? body.error.message : ('Stripe HTTP ' + code);
    throw new Error(msg);
  }
  return body;
}

function createCheckoutSession_(d, quote, orderId) {
  var success = CREATOR_URL + '?payment=success&session_id={CHECKOUT_SESSION_ID}';
  var cancel = CREATOR_URL + '?payment=cancelled';
  var payload = {
    mode: 'payment',
    locale: 'ja',
    success_url: success,
    cancel_url: cancel,
    client_reference_id: orderId,
    customer_email: String(d.mail || '').slice(0, 800),
    'line_items[0][quantity]': quote.qty,
    'line_items[0][price_data][currency]': 'jpy',
    'line_items[0][price_data][unit_amount]': quote.unitPriceYen,
    'line_items[0][price_data][product_data][name]': 'ぷくぷくネームキーホルダー',
    'line_items[0][price_data][product_data][description]': String(d.slug || 'オーダー文字').slice(0, 120),
    'shipping_address_collection[allowed_countries][0]': 'JP',
    'metadata[order_id]': orderId,
    'metadata[grams]': String(quote.grams),
    'metadata[quantity]': String(quote.qty)
  };
  if (quote.shippingYen > 0) {
    payload['shipping_options[0][shipping_rate_data][type]'] = 'fixed_amount';
    payload['shipping_options[0][shipping_rate_data][display_name]'] = quote.shippingLabel;
    payload['shipping_options[0][shipping_rate_data][fixed_amount][amount]'] = quote.shippingYen;
    payload['shipping_options[0][shipping_rate_data][fixed_amount][currency]'] = 'jpy';
    payload['shipping_options[0][shipping_rate_data][metadata][shipping_method]'] = quote.shippingMethod;
  }
  payload['metadata[shipping_method]'] = quote.shippingMethod;
  return stripeRequest_('post', '/v1/checkout/sessions', payload, 'neqo-order-' + orderId);
}

/** 成功画面からSessionを再取得し、支払い済みなら注文シートを更新する。 */
function paymentStatus_(sessionId) {
  var id = String(sessionId || '');
  if (!/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(id) || id.length > 255) {
    return { ok: false, error: 'bad_session_id' };
  }
  var session = stripeRequest_('get', '/v1/checkout/sessions/' + encodeURIComponent(id));
  var paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  if (paid) markOrderPaid_(id);
  return {
    ok: true,
    paid: paid,
    paymentStatus: session.payment_status || '',
    orderId: session.client_reference_id || '',
    amountTotal: session.amount_total || 0,
    currency: session.currency || 'jpy'
  };
}

function markOrderPaid_(sessionId) {
  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last < 2) return;
  var values = sh.getRange(2, COL.STRIPE_SESSION, last - 1, 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0]) === sessionId) {
      sh.getRange(i + 2, COL.PAYMENT).setValue('支払済み');
      return;
    }
  }
}

/** data URL または生 base64 を Blob に。失敗時は null。 */
function decodeToBlob_(data, mime, filename) {
  if (!data) return null;
  var b64 = String(data);
  var comma = b64.indexOf(',');
  if (b64.slice(0, 5) === 'data:' && comma >= 0) b64 = b64.slice(comma + 1);
  try {
    var bytes = Utilities.base64Decode(b64);
    return Utilities.newBlob(bytes, mime, filename);
  } catch (e) {
    console.error('decode failed for ' + filename + ': ' + e);
    return null;
  }
}

/** 管理者メールに添付する部品STL（＋確認用PNG）の配列を作る。 */
function buildOrderAttachments_(d) {
  var out = [];
  var slug = sanitizeSlug_(d.slug) || 'keychain';
  var border = decodeToBlob_(d.borderStl, 'model/stl', slug + '_border.stl');
  var letters = decodeToBlob_(d.lettersStl, 'model/stl', slug + '_letters.stl');
  var png = decodeToBlob_(d.previewPng, 'image/png', slug + '_preview.png');
  if (border) out.push(border);
  if (letters) out.push(letters);
  if (png) out.push(png);
  return out;
}

/** 注文者への自動返信（完成予想図PNGを添付）。 */
function confirmOrder_(name, mail, previewPng, slug) {
  if (!mail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return;
  var png = decodeToBlob_(previewPng, 'image/png', (sanitizeSlug_(slug) || 'keychain') + '_preview.png');
  var replyTo = PropertiesService.getScriptProperties().getProperty('NOTIFY_TO')
             || Session.getEffectiveUser().getEmail();
  var body = [
    (name ? name + ' 様' : 'ご注文ありがとうございます'),
    '',
    'ぷくぷくネームキーホルダーの注文データを受け付けました。',
    '完成予想図を添付しています。',
    '',
    '続いて表示されるStripe画面で、商品代と送料をご確認のうえお支払いください。',
    'Stripeでの決済が完了した時点で注文確定となります。',
    '決済を中断した場合や領収メールが届かない場合は、二重に操作せずご連絡ください。',
    '',
    'ご不明な点は、このメールにそのままご返信ください。',
    '',
    '— NEQO FAB（長野県富士見町）'
  ].join('\n');
  var options = { name: 'NEQO FAB', body: body };
  if (png) options.attachments = [png];
  if (replyTo) options.replyTo = replyTo;
  MailApp.sendEmail(mail, '【NEQO FAB】注文データを受け付けました（決済前）', body, options);
}

/** ファイル名用に危険な文字を除去。 */
function sanitizeSlug_(s) {
  if (!s) return '';
  // 日本語・英数字に加え、ハングル字母／完成形音節も保存名に残す。
  return String(s).replace(
    /[^\w぀-ヿ一-龯\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF\uFFA0-\uFFDC-]/g,
    '').slice(0, 24);
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
