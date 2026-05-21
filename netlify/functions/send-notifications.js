// Netlify Scheduled Function: send-notifications
// 매일 4시간 간격(KST 9시/13시/17시/21시)으로 모든 사용자에게 마감 알림을 보냅니다.
// 각 사용자별로 본인의 할일을 본인의 텔레그램 채팅방으로 발송합니다.

const { schedule } = require('@netlify/functions');
const { createClient } = require('@supabase/supabase-js');

async function sendForUser(supabase, telegramToken, profile, kstNow, todayLabel, timeLabel) {
  const chatId = profile.telegram_chat_id;
  if (!chatId) return { skipped: true, reason: 'no chat_id' };

  const todayStr = kstNow.toISOString().split('T')[0];

  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('status', 'pending')
    .eq('user_id', profile.id)
    .order('deadline', { ascending: true });

  if (error) {
    console.error(`User ${profile.id} task fetch failed:`, error);
    return { error: error.message };
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

  function addSection(title, list, withDiffLabel, withButtons) {
    if (list.length === 0) return;
    msg += `\n${title}\n`;
    list.forEach(t => {
      const diffSuffix = withDiffLabel && t.diff !== undefined
        ? (t.diff < 0 ? ` <i>(${-t.diff}일 지남)</i>` : ` <i>(D-${t.diff})</i>`)
        : '';
      const recur = recurEmoji(t.recurrence);
      msg += `• ${esc(t.title)}<i>${esc(recur)}</i>${diffSuffix}\n`;
      if (withButtons) {
        const btnLabel = `✅ ${t.title.length > 38 ? t.title.slice(0, 38) + '…' : t.title}`;
        buttons.push([{ text: btnLabel, callback_data: `done:${t.id}` }]);
      }
    });
  }

  addSection(`❗ <b>기한 초과 (${overdue.length})</b>`, overdue, true, false);
  addSection(`🚨 <b>오늘 마감 · D-DAY (${d0.length})</b>`, d0, false, true);
  addSection(`⏰ <b>내일 마감 · D-1 (${d1.length})</b>`, d1, false, false);
  addSection(`📅 <b>3일 후 마감 · D-3 (${d3.length})</b>`, d3, false, false);
  addSection(`📌 <b>이번 주 일정</b>`, upcoming, true, false);

  const total = overdue.length + d0.length + d1.length + d3.length + upcoming.length;
  if (total === 0) {
    msg += `\n🌿 임박한 일정이 없어요. 여유로운 시간이에요!`;
  } else if (buttons.length > 0) {
    msg += `\n<i>오늘 마감 항목은 아래 버튼으로 바로 완료 처리할 수 있어요.</i>`;
  }

  const payload = {
    chat_id: chatId,
    text: msg,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (buttons.length > 0) {
    payload.reply_markup = { inline_keyboard: buttons };
  }

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const tgJson = await tgRes.json();
    if (!tgJson.ok) {
      console.error(`User ${profile.id} Telegram error:`, tgJson);
      return { error: tgJson.description };
    }
    return { sent: true, tasks: tasks?.length || 0 };
  } catch (err) {
    console.error(`User ${profile.id} send failed:`, err);
    return { error: err.message };
  }
}

const handler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TELEGRAM_BOT_TOKEN) {
    console.error('Missing environment variables');
    return { statusCode: 500, body: 'Missing env vars' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayLabel = kstNow.toLocaleDateString('ko-KR', {
    timeZone: 'UTC',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  const timeLabel = kstNow.toLocaleTimeString('ko-KR', {
    timeZone: 'UTC',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  // 텔레그램 chat_id가 설정된 모든 사용자 조회
  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, email, telegram_chat_id')
    .not('telegram_chat_id', 'is', null);

  if (error) {
    console.error('Profiles fetch failed:', error);
    return { statusCode: 500, body: 'DB error' };
  }

  if (!profiles || profiles.length === 0) {
    console.log('No users with telegram_chat_id');
    return { statusCode: 200, body: 'no users' };
  }

  const results = [];
  for (const profile of profiles) {
    const result = await sendForUser(
      supabase, TELEGRAM_BOT_TOKEN, profile,
      kstNow, todayLabel, timeLabel
    );
    results.push({ user: profile.email, ...result });
  }

  console.log('Notification results:', results);
  return { statusCode: 200, body: JSON.stringify({ sent: results.length, results }) };
};

// 매일 KST 9시 / 13시 / 17시 / 21시 (4시간 간격)
exports.handler = schedule('0 0,4,8,12 * * *', handler);
