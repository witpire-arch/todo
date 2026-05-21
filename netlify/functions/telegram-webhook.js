// Netlify Function: telegram-webhook
// 텔레그램에서 "✅ 완료" 버튼이 눌렸을 때 호출됩니다.
// - 일반 할일: status를 done으로 변경
// - 반복 할일(daily/weekly/monthly): deadline을 다음 회차로 이동 (status는 pending 유지)

const { createClient } = require('@supabase/supabase-js');

function addDays(date, n) {
  const r = new Date(date); r.setDate(r.getDate() + n); return r;
}
function addMonths(date, n) {
  const r = new Date(date); r.setMonth(r.getMonth() + n); return r;
}
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'ok' };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TELEGRAM_BOT_TOKEN) {
    console.error('Missing env vars');
    return { statusCode: 500, body: 'config error' };
  }

  let update;
  try {
    update = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'bad json' };
  }

  const cb = update.callback_query;
  if (!cb) {
    return { statusCode: 200, body: 'ignored' };
  }

  const data = cb.data || '';
  const callbackId = cb.id;
  const message = cb.message;

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
      return { statusCode: 200, body: 'no id' };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: existing, error: fetchErr } = await supabase
      .from('tasks')
      .select('id, title, status, recurrence, deadline')
      .eq('id', taskId)
      .maybeSingle();

    if (fetchErr || !existing) {
      console.error('Fetch failed:', fetchErr);
      await answer('이미 삭제된 할일이에요', true);
      return { statusCode: 200, body: 'not found' };
    }

    if (existing.status === 'done') {
      await answer(`이미 완료된 항목이에요: ${existing.title}`, false);
      return { statusCode: 200, body: 'already done' };
    }

    const recurrence = existing.recurrence || 'once';
    let newButtonLabel = '';
    let toastText = '';

    if (recurrence === 'once') {
      // 일반 할일 → done 처리
      const { error: updateErr } = await supabase
        .from('tasks').update({ status: 'done' }).eq('id', taskId);
      if (updateErr) {
        console.error('Update failed:', updateErr);
        await answer('완료 처리 실패. 다시 시도해주세요', true);
        return { statusCode: 500, body: 'update failed' };
      }
      newButtonLabel = `✓ ${existing.title} (완료)`;
      toastText = `✅ 완료 처리됐어요: ${existing.title}`;
    } else {
      // 반복 할일 → deadline 다음으로 이동
      const nextDeadline = advanceDeadline(existing.deadline, recurrence);
      const { error: updateErr } = await supabase
        .from('tasks').update({ deadline: nextDeadline }).eq('id', taskId);
      if (updateErr) {
        console.error('Update failed:', updateErr);
        await answer('완료 처리 실패. 다시 시도해주세요', true);
        return { statusCode: 500, body: 'update failed' };
      }
      const nextLabel = new Date(nextDeadline + 'T00:00:00').toLocaleDateString('ko-KR', {
        month: 'long', day: 'numeric',
      });
      newButtonLabel = `✓ ${existing.title} (다음: ${nextLabel})`;
      toastText = `✅ 완료! 다음 ${recurLabel(recurrence)} 일정: ${nextLabel}`;
    }

    await answer(toastText, false);

    // 원본 메시지의 해당 버튼만 회색 처리
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

    return { statusCode: 200, body: 'done' };
  }

  if (data === 'noop') {
    await answer('이미 처리된 항목이에요', false);
    return { statusCode: 200, body: 'noop' };
  }

  await answer('알 수 없는 명령이에요', false);
  return { statusCode: 200, body: 'unknown' };
};
