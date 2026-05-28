// Vercel Function: /api/sync-calendar
// 각 사용자의 Google Calendar iCal URL에서 일정을 가져와 tasks 테이블에 동기화합니다.
// 향후 30일 이내의 일정만 동기화. 반복 일정도 펼쳐서 각각 단발 일정으로 등록.
//
// 동작 규칙:
// - 새 일정 → tasks에 INSERT (source='gcal')
// - 기존 일정 (status='pending') → 새 정보로 UPDATE
// - 캘린더에서 사라진 일정 (status='pending') → DELETE
// - 이미 완료된 일정 (status='done') → 그대로 유지 (재생성 X)

const { createClient } = require('@supabase/supabase-js');
const ical = require('node-ical');

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 향후 며칠치 동기화할지
const SYNC_DAYS_AHEAD = 30;
const MAX_TITLE_LENGTH = 100;

async function syncUserCalendar(supabase, profile) {
  const url = profile.gcal_ical_url;
  if (!url) return { skipped: true, reason: 'no ical url' };

  let events;
  try {
    events = await ical.async.fromURL(url);
  } catch (err) {
    return { error: `iCal fetch failed: ${err.message}` };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endRange = new Date(today);
  endRange.setDate(endRange.getDate() + SYNC_DAYS_AHEAD);

  const newTasks = []; // 동기화할 항목 모음 (external_id 단위)
  const seen = new Set(); // external_id 중복 방지

  for (const key of Object.keys(events)) {
    const event = events[key];
    if (!event || event.type !== 'VEVENT') continue;
    if (!event.start) continue;

    const summary = (event.summary || '제목 없음').trim().slice(0, MAX_TITLE_LENGTH);
    const uid = event.uid || key;

    // 반복 일정 처리
    if (event.rrule) {
      let occurrences = [];
      try {
        occurrences = event.rrule.between(today, endRange, true);
      } catch (err) {
        console.error('rrule expand failed for', uid, err.message);
        continue;
      }

      // EXDATE 처리 (예외 처리된 반복 일정 제거)
      const exdateSet = new Set();
      if (event.exdate) {
        for (const exKey of Object.keys(event.exdate)) {
          const exDate = new Date(event.exdate[exKey]);
          exdateSet.add(toISODate(exDate));
        }
      }

      // RECURRENCE-ID (개별 수정된 회차 처리)
      const recurOverrides = event.recurrences || {};
      const overrideDates = new Set(Object.keys(recurOverrides));

      for (const occ of occurrences) {
        const occDateStr = toISODate(occ);
        if (exdateSet.has(occDateStr)) continue;

        // 개별 수정된 회차는 별도 처리되어야 하지만
        // 일단 같은 external_id로 처리 (수정된 내용 반영 시 어차피 update됨)
        const externalId = `${uid}_${occDateStr}`;
        if (seen.has(externalId)) continue;
        seen.add(externalId);

        // 개별 수정된 제목/날짜 적용
        let occTitle = summary;
        let occDeadline = occDateStr;
        if (overrideDates.has(occDateStr)) {
          const ov = recurOverrides[occDateStr];
          if (ov.summary) occTitle = ov.summary.trim().slice(0, MAX_TITLE_LENGTH);
          if (ov.start) occDeadline = toISODate(new Date(ov.start));
        }

        newTasks.push({
          user_id: profile.id,
          title: occTitle,
          deadline: occDeadline,
          status: 'pending',
          recurrence: 'once',
          source: 'gcal',
          external_id: externalId,
        });
      }
    } else {
      // 단발 일정
      const start = new Date(event.start);
      if (isNaN(start.getTime())) continue;
      // 시작 날짜의 자정 기준으로 비교
      const startDateOnly = new Date(start);
      startDateOnly.setHours(0, 0, 0, 0);
      if (startDateOnly < today || startDateOnly > endRange) continue;

      const externalId = uid;
      if (seen.has(externalId)) continue;
      seen.add(externalId);

      newTasks.push({
        user_id: profile.id,
        title: summary,
        deadline: toISODate(startDateOnly),
        status: 'pending',
        recurrence: 'once',
        source: 'gcal',
        external_id: externalId,
      });
    }
  }

  // 기존 gcal 태스크 조회
  const { data: existing, error: fetchErr } = await supabase
    .from('tasks')
    .select('id, external_id, status, deadline, title')
    .eq('user_id', profile.id)
    .eq('source', 'gcal');

  if (fetchErr) {
    return { error: `DB fetch failed: ${fetchErr.message}` };
  }

  const existingMap = new Map();
  for (const t of existing || []) {
    if (t.external_id) existingMap.set(t.external_id, t);
  }

  // 분류
  const toInsert = [];
  const toUpdate = [];
  const newExternalIds = new Set(newTasks.map(t => t.external_id));

  for (const newTask of newTasks) {
    const exist = existingMap.get(newTask.external_id);
    if (!exist) {
      toInsert.push(newTask);
    } else if (exist.status === 'pending') {
      // 변경된 경우만 업데이트
      if (exist.deadline !== newTask.deadline || exist.title !== newTask.title) {
        toUpdate.push({ id: exist.id, ...newTask });
      }
    }
    // 이미 done인 항목은 그대로 두기 (재활성화 X)
  }

  // 캘린더에서 사라진 pending 태스크 삭제
  const toDelete = (existing || []).filter(t =>
    t.status === 'pending' && !newExternalIds.has(t.external_id)
  );

  // 실행
  let inserted = 0, updated = 0, deleted = 0;

  if (toInsert.length > 0) {
    const { error } = await supabase.from('tasks').insert(toInsert);
    if (error) console.error('Insert failed:', error);
    else inserted = toInsert.length;
  }

  for (const u of toUpdate) {
    const { id, ...fields } = u;
    const { error } = await supabase.from('tasks').update(fields).eq('id', id);
    if (error) console.error('Update failed:', error);
    else updated++;
  }

  if (toDelete.length > 0) {
    const { error } = await supabase
      .from('tasks')
      .delete()
      .in('id', toDelete.map(t => t.id));
    if (error) console.error('Delete failed:', error);
    else deleted = toDelete.length;
  }

  return {
    inserted, updated, deleted,
    total_synced: newTasks.length,
  };
}

module.exports = async function handler(req, res) {
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

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, email, gcal_ical_url')
    .not('gcal_ical_url', 'is', null);

  if (error) {
    return res.status(500).json({ error: 'DB error: ' + error.message });
  }

  if (!profiles || profiles.length === 0) {
    return res.status(200).json({ message: 'no users with gcal_ical_url', users: 0 });
  }

  const results = [];
  for (const profile of profiles) {
    try {
      const result = await syncUserCalendar(supabase, profile);
      results.push({ user: profile.email, ...result });
    } catch (err) {
      results.push({ user: profile.email, error: err.message });
    }
  }

  return res.status(200).json({ users: results.length, results });
};
