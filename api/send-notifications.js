// Vercel Function: /api/send-notifications
// 외부 cron 서비스(cron-job.org)가 4시간마다 이 URL을 호출하면 모든 사용자에게 알림을 발송합니다.
// 보안을 위해 CRON_SECRET 환경변수와 비교하여 무단 호출을 막습니다.

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

module.exports = async function handler(req, res) {
  // CRON_SECRET이 설정돼 있으면, 요청에 같은 값이 있는지 확인
  // cron-job.org에서는 Authorization 헤더로 보내거나 ?secret=xxx 쿼리로 보냄
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET) {
    const provided =
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
      req.query?.secret ||
      '';
    if (provided !== CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TELEGRAM_BOT_TOKEN) {
    console.error('Missing environment variables');
    return res.status(500).json({ error: 'Missing env vars' });
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

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, email, telegram_chat_id')
    .not('telegram_chat_id', 'is', null);

  if (error) {
    console.error('Profiles fetch failed:', error);
    return res.status(500).json({ error: 'DB error' });
  }

  if (!profiles || profiles.length === 0) {
    return res.status(200).json({ sent: 0, message: 'no users with telegram_chat_id' });
  }

  const results = [];
  for (const profile of profiles) {
    const result = await sendForUser(
      supabase, TELEGRAM_BOT_TOKEN, profile,
      kstNow, todayLabel, timeLabel
    );
    results.push({ user: profile.email, ...result });
  }

  return res.status(200).json({ sent: results.length, results });
};
