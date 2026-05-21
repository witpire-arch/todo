// Netlify Scheduled Function: send-notifications
// 매일 오전 9시(KST = 00:00 UTC)에 텔레그램 단체방으로 마감 알림을 보냅니다.
// netlify.toml의 schedule 설정과 함께 동작합니다.

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

  // KST 오늘 날짜
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayStr = kstNow.toISOString().split('T')[0];
  const todayLabel = kstNow.toLocaleDateString('ko-KR', {
    timeZone: 'UTC', // KST 보정한 시각을 그대로 표시
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  // 전체 미완료 할일 조회
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('status', 'pending')
    .order('deadline', { ascending: true });

  if (error) {
    console.error(error);
    return { statusCode: 500, body: 'DB error' };
  }

  // 그룹화
  const overdue = [];
  const d0 = [];
  const d1 = [];
  const d3 = [];
  const upcoming = []; // 4~7일

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

  // 메시지 작성 (Telegram MarkdownV2는 이스케이프가 까다로워서 HTML 모드 사용)
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  let msg = `📋 <b>${esc(todayLabel)}</b>\n오늘의 할일 요약입니다.\n`;

  if (overdue.length > 0) {
    msg += `\n❗ <b>기한 초과 (${overdue.length})</b>\n`;
    overdue.forEach(t => msg += `• ${esc(t.title)} <i>(${-t.diff}일 지남)</i>\n`);
  }
  if (d0.length > 0) {
    msg += `\n🚨 <b>오늘 마감 · D-DAY (${d0.length})</b>\n`;
    d0.forEach(t => msg += `• ${esc(t.title)}\n`);
  }
  if (d1.length > 0) {
    msg += `\n⏰ <b>내일 마감 · D-1 (${d1.length})</b>\n`;
    d1.forEach(t => msg += `• ${esc(t.title)}\n`);
  }
  if (d3.length > 0) {
    msg += `\n📅 <b>3일 후 마감 · D-3 (${d3.length})</b>\n`;
    d3.forEach(t => msg += `• ${esc(t.title)}\n`);
  }
  if (upcoming.length > 0) {
    msg += `\n📌 <b>이번 주 일정</b>\n`;
    upcoming.forEach(t => msg += `• ${esc(t.title)} <i>(D-${t.diff})</i>\n`);
  }

  const nothingUrgent =
    overdue.length === 0 && d0.length === 0 && d1.length === 0 && d3.length === 0 && upcoming.length === 0;
  if (nothingUrgent) {
    msg += `\n🌿 오늘은 임박한 일정이 없어요. 여유로운 하루 되세요!`;
  }

  // 텔레그램 발송
  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const tgJson = await tgRes.json();
    if (!tgJson.ok) {
      console.error('Telegram error:', tgJson);
      return { statusCode: 502, body: JSON.stringify(tgJson) };
    }
    console.log('Sent OK:', { tasks: tasks?.length, overdue: overdue.length, d0: d0.length });
    return { statusCode: 200, body: 'sent' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err.message };
  }
};

// 매일 KST 9시 = UTC 0시
exports.handler = schedule('0 0 * * *', handler);
