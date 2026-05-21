// Netlify Scheduled Function: send-notifications
// 매일 4시간 간격(KST 9시/13시/17시/21시)으로 텔레그램 단체방에 마감 알림을 보냅니다.
// 각 할일마다 "✅ 완료" 버튼이 붙어있어서 탭하면 바로 완료 처리됩니다.
// 반복 할일(매일/매주/매월)은 완료 시 자동으로 다음 일정으로 넘어갑니다.

const { schedule } = require('@netlify/functions');
const { createClient } = require('@supabase/supabase-js');

const handler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Missing environment variables');
    return { statusCode: 500, body: 'Missing env vars' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayStr = kstNow.toISOString().split('T')[0];
  const todayLabel = kstNow.toLocaleDateString('ko-KR', {
    timeZone: 'UTC',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  const timeLabel = kstNow.toLocaleTimeString('ko-KR', {
    timeZone: 'UTC',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('status', 'pending')
    .order('deadline', { ascending: true });

  if (error) {
    console.error(error);
    return { statusCode: 500, body: 'DB error' };
  }

  const overdue = [];
  const d0 = [];
  const d1 = [];
  const d3 = [];
  const upcoming = [];

  const today = new Date(todayStr + 'T00:00:00Z');
  for (const task of tasks || []) {
    const deadline = new Date(task.deadline + 'T00:00:00Z');
    const diff = Math.round((deadline - today) / 86400000);
    if (diff < 0) overdue.push({ ...task, diff });
    else if (diff === 0) d0.push(task);
    else if (diff === 1) d1.push(task);
    else if (diff === 3) d3.push(task);
    else if (diff >= 2 && diff <= 7) upcoming.push({ ...task, diff });
  }

  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const recurEmoji = (r) => {
    if (r === 'daily') return ' 🔄매일';
    if (r === 'weekly') return ' 🔄매주';
    if (r === 'monthly') return ' 🔄매월';
    return '';
  };

  let msg = `📋 <b>${esc(todayLabel)} ${esc(timeLabel)}</b>\n오늘의 할일 요약이에요.\n`;
  const buttons = [];

  function addSection(title, list, withDiffLabel = false) {
    if (list.length === 0) return;
    msg += `\n${title}\n`;
    list.forEach(t => {
      const diffSuffix = withDiffLabel && t.diff !== undefined
        ? (t.diff < 0 ? ` <i>(${-t.diff}일 지남)</i>` : ` <i>(D-${t.diff})</i>`)
        : '';
      const recur = recurEmoji(t.recurrence);
      msg += `• ${esc(t.title)}<i>${esc(recur)}</i>${diffSuffix}\n`;
      const btnLabel = `✅ ${t.title.length > 38 ? t.title.slice(0, 38) + '…' : t.title}`;
      buttons.push([{ text: btnLabel, callback_data: `done:${t.id}` }]);
    });
  }

  addSection(`❗ <b>기한 초과 (${overdue.length})</b>`, overdue, true);
  addSection(`🚨 <b>오늘 마감 · D-DAY (${d0.length})</b>`, d0);
  addSection(`⏰ <b>내일 마감 · D-1 (${d1.length})</b>`, d1);
  addSection(`📅 <b>3일 후 마감 · D-3 (${d3.length})</b>`, d3);
  addSection(`📌 <b>이번 주 일정</b>`, upcoming, true);

  if (buttons.length === 0) {
    msg += `\n🌿 임박한 일정이 없어요. 여유로운 시간이에요!`;
  } else {
    msg += `\n<i>버튼을 누르면 바로 완료 처리돼요. 반복 일정은 다음 회차로 자동 넘어가요.</i>`;
  }

  try {
    const payload = {
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (buttons.length > 0) {
      payload.reply_markup = { inline_keyboard: buttons };
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const tgJson = await tgRes.json();
    if (!tgJson.ok) {
      console.error('Telegram error:', tgJson);
      return { statusCode: 502, body: JSON.stringify(tgJson) };
    }
    console.log('Sent OK:', { tasks: tasks?.length, buttons: buttons.length });
    return { statusCode: 200, body: 'sent' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err.message };
  }
};

// 매일 KST 9시 / 13시 / 17시 / 21시 (4시간 간격)
exports.handler = schedule('0 0,4,8,12 * * *', handler);
