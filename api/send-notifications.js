// Vercel Function: /api/send-notifications
// 외부 cron 서비스(cron-job.org)가 4시간마다 이 URL을 호출하면 알림을 발송합니다.
//  - 개인 할일(team_id 없음) → 각자 개인 텔레그램으로
//  - 팀 할일(team_id 있음)   → 그 팀의 단톡방(teams.telegram_chat_id)으로
// 보안을 위해 CRON_SECRET 환경변수와 비교하여 무단 호출을 막습니다.

const { createClient } = require('@supabase/supabase-js');

const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const recurEmoji = (r) => {
  if (r === 'daily') return ' 🔄매일';
  if (r === 'weekly') return ' 🔄매주';
  if (r === 'monthly') return ' 🔄매월';
  return '';
};

// 할일 목록 → 마감 임박도로 분류해서 메시지(+버튼) 생성
function composeDigest(tasks, todayStr, headerLine, useButtons) {
  const overdue = [], d0 = [], d1 = [], d3 = [], upcoming = [];
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

  let msg = headerLine;
  const buttons = [];

  function addSection(title, list, withDiffLabel, withBtns) {
    if (list.length === 0) return;
    msg += `\n${title}\n`;
    list.forEach(t => {
      const diffSuffix = withDiffLabel && t.diff !== undefined
        ? (t.diff < 0 ? ` <i>(${-t.diff}일 지남)</i>` : ` <i>(D-${t.diff})</i>`)
        : '';
      const recur = recurEmoji(t.recurrence);
      msg += `• ${esc(t.title)}<i>${esc(recur)}</i>${diffSuffix}\n`;
      if (withBtns && useButtons) {
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

  const urgent = overdue.length + d0.length + d1.length;
  if (urgent > 0 && buttons.length > 0) {
    msg += `\n<i>오늘 마감 항목은 아래 버튼으로 바로 완료 처리할 수 있어요.</i>`;
  }

  return { msg, buttons, urgent, total: tasks?.length || 0 };
}

async function sendTelegram(token, chatId, msg, buttons) {
  const payload = {
    chat_id: chatId,
    text: msg,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (buttons && buttons.length > 0) {
    payload.reply_markup = { inline_keyboard: buttons };
  }
  const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const tgJson = await tgRes.json();
  if (!tgJson.ok) throw new Error(tgJson.description || 'telegram error');
}

// 개인 알림: team_id 없는(개인) 할일만
async function sendForUser(supabase, token, profile, todayStr, headerLine) {
  const chatId = profile.telegram_chat_id;
  if (!chatId) return { skipped: true, reason: 'no chat_id' };

  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('status', 'pending')
    .eq('user_id', profile.id)
    .is('team_id', null)               // 개인 할일만 (팀 할일은 단톡방으로)
    .order('deadline', { ascending: true });

  if (error) {
    console.error(`User ${profile.id} task fetch failed:`, error);
    return { error: error.message };
  }

  const { msg, buttons, urgent, total } = composeDigest(tasks, todayStr, headerLine, true);
  if (urgent === 0) return { skipped: true, reason: 'no urgent tasks' };

  try {
    await sendTelegram(token, chatId, msg, buttons);
    return { sent: true, tasks: total };
  } catch (err) {
    console.error(`User ${profile.id} send failed:`, err);
    return { error: err.message };
  }
}

// 팀 알림: 그 팀의 할일을 팀 단톡방으로 (완료 버튼 포함)
async function sendForTeam(supabase, token, team, todayStr, todayLabel) {
  const chatId = team.telegram_chat_id;
  if (!chatId) return { skipped: true, reason: 'no chat_id' };

  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('status', 'pending')
    .eq('team_id', team.id)
    .order('deadline', { ascending: true });

  if (error) {
    console.error(`Team ${team.id} task fetch failed:`, error);
    return { error: error.message };
  }

  const headerLine = `👥 <b>${esc(team.name)}</b> · ${esc(todayLabel)}\n팀 할일 요약이에요.\n`;
  const { msg, buttons, urgent, total } = composeDigest(tasks, todayStr, headerLine, true);
  if (urgent === 0) return { skipped: true, reason: 'no urgent tasks' };

  try {
    await sendTelegram(token, chatId, msg, buttons);
    return { sent: true, tasks: total };
  } catch (err) {
    console.error(`Team ${team.id} send failed:`, err);
    return { error: err.message };
  }
}

module.exports = async function handler(req, res) {
  // CRON_SECRET이 설정돼 있으면, 요청에 같은 값이 있는지 확인
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

  // 알림 발송 전에 캘린더 자동 동기화 (별도 cron 불필요). 실패해도 알림은 계속.
  try {
    const baseUrl = `https://${req.headers.host || 'todo-rust-sigma-55.vercel.app'}`;
    const syncUrl = CRON_SECRET
      ? `${baseUrl}/api/sync-calendar?secret=${encodeURIComponent(CRON_SECRET)}`
      : `${baseUrl}/api/sync-calendar`;
    const syncRes = await fetch(syncUrl);
    if (syncRes.ok) {
      console.log('Calendar sync done:', await syncRes.json());
    } else {
      console.warn('Calendar sync failed with status:', syncRes.status);
    }
  } catch (err) {
    console.warn('Calendar sync error (continuing with notifications):', err.message);
  }

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
  const userHeader = `📋 <b>${esc(todayLabel)} ${esc(timeLabel)}</b>\n오늘의 할일 요약이에요.\n`;

  // ===== 1) 개인 알림 =====
  const { data: profiles, error: pErr } = await supabase
    .from('profiles')
    .select('id, email, telegram_chat_id')
    .not('telegram_chat_id', 'is', null);

  if (pErr) {
    console.error('Profiles fetch failed:', pErr);
    return res.status(500).json({ error: 'DB error' });
  }

  const userResults = [];
  for (const profile of profiles || []) {
    const r = await sendForUser(supabase, TELEGRAM_BOT_TOKEN, profile, todayStr, userHeader);
    userResults.push({ user: profile.email, ...r });
  }

  // ===== 2) 팀 알림 =====
  const { data: teams, error: tErr } = await supabase
    .from('teams')
    .select('id, name, telegram_chat_id')
    .not('telegram_chat_id', 'is', null);

  if (tErr) console.error('Teams fetch failed:', tErr);

  const teamResults = [];
  for (const team of teams || []) {
    const r = await sendForTeam(supabase, TELEGRAM_BOT_TOKEN, team, todayStr, todayLabel);
    teamResults.push({ team: team.name, ...r });
  }

  return res.status(200).json({
    users: userResults.length,
    teams: teamResults.length,
    userResults,
    teamResults,
  });
};
