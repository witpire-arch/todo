// Vercel Function: /api/telegram-webhook
// 텔레그램에서 봇으로 들어오는 이벤트를 처리합니다.
// - 메시지 "/id" 또는 "/start": 해당 채팅의 Chat ID를 회신
// - 콜백 쿼리 "done:<task_id>": 할일 완료 처리 (반복 일정은 다음 회차로)

const { createClient } = require('@supabase/supabase-js');

function addDays(date, n) { const r = new Date(date); r.setDate(r.getDate() + n); return r; }
function addMonths(date, n) { const r = new Date(date); r.setMonth(r.getMonth() + n); return r; }
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function advanceDeadline(deadlineStr, recurrence) {
  const d = new Date(deadlineStr + 'T00:00:00');
  if (recurrence === 'daily') return toISODate(addDays(d, 1));
  if (recurrence === 'weekly') return toISODate(addDays(d, 7));
  if (recurrence === 'monthly') return toISODate(addMonths(d, 1));
  return deadlineStr;
}
function recurLabel(r) {
  if (r === 'daily') return '매일';
  if (r === 'weekly') return '매주';
  if (r === 'monthly') return '매월';
  return '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('ok');
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TELEGRAM_BOT_TOKEN) {
    console.error('Missing env vars');
    return res.status(500).send('config error');
  }

  // Vercel은 req.body가 자동 파싱됨
  const update = req.body || {};

  // ===== 일반 메시지 처리 (/id, /start) =====
  if (update.message) {
    const msg = update.message;
    const text = (msg.text || '').trim().toLowerCase();
    if (text === '/id' || text === '/start' || text === '/start@mindcare12000_bot' || text === '/id@mindcare12000_bot') {
      const chatId = msg.chat.id;
      const chatTitle = msg.chat.title || '개인 채팅';
      const replyText = `안녕하세요! 👋\n\n이 채팅의 <b>Chat ID</b>는:\n<code>${chatId}</code>\n\n위 ID를 복사해서 웹페이지(MindCare Tasks)의 <b>⚙ 설정</b>에 붙여넣으세요.\n\n채팅방 이름: <b>${chatTitle}</b>`;
      try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: replyText,
            parse_mode: 'HTML',
          }),
        });
      } catch (e) {
        console.error('Failed to send id reply:', e);
      }
      return res.status(200).send('id sent');
    }
    return res.status(200).send('msg ignored');
  }

  // ===== 콜백 쿼리 처리 (버튼 클릭) =====
  const cb = update.callback_query;
  if (!cb) return res.status(200).send('ignored');

  const data = cb.data || '';
  const callbackId = cb.id;
  const message = cb.message;
  const chatId = message?.chat?.id;

  async function answer(text, showAlert = false) {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackId, text, show_alert: showAlert,
        }),
      });
    } catch (e) { console.error('answerCallbackQuery failed:', e); }
  }

  if (data.startsWith('done:')) {
    const taskId = data.substring(5).trim();
    if (!taskId) {
      await answer('할일 ID가 없어요', true);
      return res.status(200).send('no id');
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: existing, error: fetchErr } = await supabase
      .from('tasks')
      .select('id, title, status, recurrence, deadline, user_id')
      .eq('id', taskId)
      .maybeSingle();

    if (fetchErr || !existing) {
      console.error('Fetch failed:', fetchErr);
      await answer('이미 삭제된 할일이에요', true);
      return res.status(200).send('not found');
    }

    // 권한 확인
    const { data: profile } = await supabase
      .from('profiles').select('id').eq('telegram_chat_id', String(chatId)).maybeSingle();

    if (!profile || profile.id !== existing.user_id) {
      await answer('이 할일에 대한 권한이 없어요', true);
      return res.status(200).send('unauthorized');
    }

    if (existing.status === 'done') {
      await answer(`이미 완료된 항목이에요: ${existing.title}`, false);
      return res.status(200).send('already done');
    }

    const recurrence = existing.recurrence || 'once';
    let newButtonLabel = '';
    let toastText = '';

    if (recurrence === 'once') {
      const { error: updateErr } = await supabase
        .from('tasks').update({ status: 'done' }).eq('id', taskId);
      if (updateErr) {
        console.error('Update failed:', updateErr);
        await answer('완료 처리 실패. 다시 시도해주세요', true);
        return res.status(500).send('update failed');
      }
      newButtonLabel = `✓ ${existing.title} (완료)`;
      toastText = `✅ 완료 처리됐어요: ${existing.title}`;
    } else {
      const nextDeadline = advanceDeadline(existing.deadline, recurrence);
      const { error: updateErr } = await supabase
        .from('tasks').update({ deadline: nextDeadline }).eq('id', taskId);
      if (updateErr) {
        console.error('Update failed:', updateErr);
        await answer('완료 처리 실패. 다시 시도해주세요', true);
        return res.status(500).send('update failed');
      }
      const nextLabel = new Date(nextDeadline + 'T00:00:00').toLocaleDateString('ko-KR', {
        month: 'long', day: 'numeric',
      });
      newButtonLabel = `✓ ${existing.title} (다음: ${nextLabel})`;
      toastText = `✅ 완료! 다음 ${recurLabel(recurrence)} 일정: ${nextLabel}`;
    }

    await answer(toastText, false);

    if (message && message.reply_markup) {
      try {
        const keyboard = message.reply_markup.inline_keyboard || [];
        const newKeyboard = keyboard.map(row =>
          row.map(btn => {
            if (btn.callback_data === data) {
              return { text: newButtonLabel, callback_data: 'noop' };
            }
            return btn;
          })
        );
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: message.chat.id,
            message_id: message.message_id,
            reply_markup: { inline_keyboard: newKeyboard },
          }),
        });
      } catch (e) {
        console.error('editMessageReplyMarkup failed:', e);
      }
    }

    return res.status(200).send('done');
  }

  if (data === 'noop') {
    await answer('이미 처리된 항목이에요', false);
    return res.status(200).send('noop');
  }

  await answer('알 수 없는 명령이에요', false);
  return res.status(200).send('unknown');
};
