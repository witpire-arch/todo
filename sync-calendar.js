// Vercel Function: /api/sync-calendar
// 각 사용자의 Google Calendar iCal URL에서 일정을 가져와 tasks 테이블에 동기화합니다.
//
// 동작 규칙:
// - 단발 일정: 향후 30일 이내면 동기화
// - 반복 일정: 다가오는 "다음 1회"만 동기화 (지나면 다음 회차가 자동으로 들어옴)
// - 모든 시간은 한국 시간(KST, UTC+9) 기준으로 처리
// - 새 일정 → INSERT, 변경 → UPDATE, 사라진 pending → DELETE
// - 이미 완료(done)된 일정은 그대로 유지

const { createClient } = require('@supabase/supabase-js');
const ical = require('node-ical');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SYNC_DAYS_AHEAD = 30;
const MAX_TITLE_LENGTH = 100;

// UTC 기준 Date를 KST 벽시계 시각으로 변환 (getUTC* 로 읽으면 KST 시각)
function toKST(date) {
  return new Date(new Date(date).getTime() + KST_OFFSET_MS);
}

// KST 기준 날짜 문자열 (YYYY-MM-DD)
function toKSTDateStr(date) {
  const k = toKST(date);
  const y = k.getUTCFullYear();
  const m = String(k.getUTCMonth() + 1).padStart(2, '0');
  const d = String(k.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 그 날짜의 KST 자정을 UTC 인스턴트로 (비교용)
function kstMidnight(date) {
  const dateStr = toKSTDateStr(date);
  return new Date(`${dateStr}T00:00:00+09:00`);
}

// 시간 정보를 제목 앞에 붙임 ("17:00 영양제"), KST 기준
function formatTitleWithTime(title, event, startDate) {
  const isAllDay = event.start && event.start.dateOnly === true;
  if (isAllDay) return title;

  const d = new Date(startDate);
  if (isNaN(d.getTime())) return title;

  const k = toKST(d);
  const hh = k.getUTCHours();
  const mm = k.getUTCMinutes();
  if (hh === 0 && mm === 0) return title;

  const timeStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  if (title.startsWith(timeStr)) return title;
  return `${timeStr} ${title}`.slice(0, MAX_TITLE_LENGTH);
}

async function syncUserCalendar(supabase, profile) {
  const url = profile.gcal_ical_url;
  if (!url) return { skipped: true, reason: 'no ical url' };

  let events;
  try {
    events = await ical.async.fromURL(url);
  } catch (err) {
    return { error: `iCal fetch failed: ${err.message}` };
  }

  const now = new Date();
  const todayMidnight = kstMidnight(now);
  const endRange = new Date(todayMidnight.getTime() + SYNC_DAYS_AHEAD * 24 * 60 * 60 * 1000);

  const newTasks = [];
  const seen = new Set();

  for (const key of Object.keys(events)) {
    const event = events[key];
    if (!event || event.type !== 'VEVENT') continue;
    if (!event.start) continue;

    const summary = (event.summary || '제목 없음').trim().slice(0, MAX_TITLE_LENGTH);
    const uid = event.uid || key;

    // ===== 반복 일정: 다음 1회만 =====
    if (event.rrule) {
      const exdateSet = new Set();
      if (event.exdate) {
        for (const exKey of Object.keys(event.exdate)) {
          exdateSet.add(toKSTDateStr(new Date(event.exdate[exKey])));
        }
      }

      let nextOcc = null;
      try {
        const searchEnd = new Date(todayMidnight.getTime() + 365 * 24 * 60 * 60 * 1000);
        const occurrences = event.rrule.between(todayMidnight, searchEnd, true);
        for (const occ of occurrences) {
          const occDateStr = toKSTDateStr(occ);
          if (exdateSet.has(occDateStr)) continue;
          nextOcc = occ;
          break;
        }
      } catch (err) {
        console.error('rrule expand failed for', uid, err.message);
        continue;
      }

      if (!nextOcc) continue;

      const occDateStr = toKSTDateStr(nextOcc);
      const recurOverrides = event.recurrences || {};
      let occTitle = summary;
      let occStart = nextOcc;
      if (recurOverrides[occDateStr]) {
        const ov = recurOverrides[occDateStr];
        if (ov.summary) occTitle = ov.summary.trim().slice(0, MAX_TITLE_LENGTH);
        if (ov.start) occStart = new Date(ov.start);
      }

      const externalId = uid;
      if (seen.has(externalId)) continue;
      seen.add(externalId);

      newTasks.push({
        user_id: profile.id,
        title: formatTitleWithTime(occTitle, event, occStart),
        deadline: occDateStr,
        status: 'pending',
        recurrence: 'once',
        source: 'gcal',
        external_id: externalId,
      });
    } else {
      // ===== 단발 일정 =====
      const start = new Date(event.start);
      if (isNaN(start.getTime())) continue;

      const startMidnight = kstMidnight(start);
      if (startMidnight < todayMidnight || startMidnight > endRange) continue;

      const externalId = uid;
      if (seen.has(externalId)) continue;
      seen.add(externalId);

      newTasks.push({
        user_id: profile.id,
        title: formatTitleWithTime(summary, event, start),
        deadline: toKSTDateStr(start),
        status: 'pending',
        recurrence: 'once',
        source: 'gcal',
        external_id: externalId,
      });
    }
  }

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

  const toInsert = [];
  const toUpdate = [];
  const newExternalIds = new Set(newTasks.map(t => t.external_id));

  for (const newTask of newTasks) {
    const exist = existingMap.get(newTask.external_id);
    if (!exist) {
      toInsert.push(newTask);
    } else if (exist.status === 'pending') {
      if (exist.deadline !== newTask.deadline || exist.title !== newTask.title) {
        toUpdate.push({ id: exist.id, ...newTask });
      }
    }
  }

  const toDelete = (existing || []).filter(t =>
    t.status === 'pending' && !newExternalIds.has(t.external_id)
  );

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

  return { inserted, updated, deleted, total_synced: newTasks.length };
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
