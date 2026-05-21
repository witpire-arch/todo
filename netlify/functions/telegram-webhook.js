// Netlify Function: telegram-webhook
// 텔레그램에서 사용자가 봇 메시지의 "✅ 완료" 버튼을 누르면 호출됩니다.
// 해당 할일을 Supabase에서 done 상태로 변경하고 사용자에게 확인 토스트를 띄웁니다.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  // 텔레그램은 POST로만 호출함
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

  // callback_query만 처리 (버튼 누르는 이벤트)
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
          callback_query_id: callbackId,
          text,
          show_alert: showAlert,
        }),
      });
    } catch (e) {
      console.error('answerCallbackQuery failed:', e);
    }
  }

  // "done:<task_id>" 형식 처리
  if (data.startsWith('done:')) {
    const taskId = data.substring(5).trim();
    if (!taskId) {
      await answer('할일 ID가 없어요', true);
      return { statusCode: 200, body: 'no id' };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 할일 정보 먼저 조회 (이미 완료된 건지 확인용)
    const { data: existing, error: fetchErr } = await supabase
      .from('tasks').select('id, title, status').eq('id', taskId).maybeSingle();

    if (fetchErr || !existing) {
      console.error('Fetch failed:', fetchErr);
      await answer('이미 삭제된 할일이에요', true);
      return { statusCode: 200, body: 'not found' };
    }

    if (existing.status === 'done') {
      await answer(`이미 완료된 항목이에요: ${existing.title}`, false);
      return { statusCode: 200, body: 'already done' };
    }

    // 완료 처리
    const { error: updateErr } = await supabase
      .from('tasks').update({ status: 'done' }).eq('id', taskId);

    if (updateErr) {
      console.error('Update failed:', updateErr);
      await answer('완료 처리 실패. 다시 시도해주세요', true);
      return { statusCode: 500, body: 'update failed' };
    }

    // 성공 응답 (토스트로 표시됨)
    await answer(`✅ 완료 처리됐어요: ${existing.title}`, false);

    // 원본 메시지에서 해당 버튼을 회색 처리 (선택)
    if (message && message.reply_markup) {
      try {
        const keyboard = message.reply_markup.inline_keyboard || [];
        const newKeyboard = keyboard.map(row =>
          row.map(btn => {
            if (btn.callback_data === data) {
              return { text: `✓ ${existing.title} (완료)`, callback_data: 'noop' };
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
        // 버튼 업데이트 실패해도 완료 처리는 됐으니 무시
      }
    }

    return { statusCode: 200, body: 'done' };
  }

  // 알 수 없는 callback
  await answer('알 수 없는 명령이에요', false);
  return { statusCode: 200, body: 'unknown' };
};
