// 캘린더 일정 → 오늘 할 일(모델 없이, 결정적).
// 예전엔 브리핑 모델이 일정을 보고 골라 할 일로 넣었다: 고르는 일정이 매번 다르고, 제목을 번역하고("prepare slides for demo day" → "데모데이 슬라이드 준비"),
// key 를 지어내서(calendar:design-review-20261007) 같은 일정이 「calendar」·「직접 추가」로 두 번 들어가곤 했다.
// 이제 동기화가 끝날 때 오늘 일정마다 할 일 하나를 key `calendar:<일정 id>@<날짜>`로 넣고 오늘 할 일로 고른다.
//  - 제목은 일정 제목 그대로(번역·요약 없음). 일정이 끝나도 자동으로 끝내지 않는다(준비·작업 블록이 많아서 직접 체크).
//  - 같은 key 는 다시 넣지 않고, 사용자가 지운(휴지통·영구 삭제) key 는 되살리지 않는다(store.upsertTodo).
//    제목이 비슷한 다른 할 일과 합치거나 막는 규칙(findDuplicate)은 쓰지 않는다 — 반복 일정은 날마다 제목이 같아서 둘째 날부터 안 들어왔다.
//    대신 직접 넣었거나 예전 브리핑이 넣은 열린 할 일 중 제목이 같은 게 있으면 넣지 않는다(다른 날의 일정 할 일은 비교에서 뺀다).
//  - 오늘로 고르는 건 처음 넣을 때만 — 사용자가 오늘에서 뺀 건 다음 동기화가 다시 넣지 않는다.
//  - 날짜가 바뀌면 지난 날의 끝내지 않은 일정 할 일은 지우지 않고 「언젠가」(P4)로 내린다(날마다 「오늘 꼭」에 쌓이지 않게).
//    사용자가 우선순위를 직접 정했거나 ▶(진행 중)인 건 그대로 둔다.
import type { Store, Todo } from "./store.ts";
import type { CalEvent } from "./calendar-sync.ts";
import { localDate, localHhmm } from "./calendar.ts";
import { normTitle } from "./todo-match.ts";

export const calendarTodoKey = (eventId: string, day: string) => `calendar:${eventId}@${day}`;
// 동기화가 넣은 일정 할 일인가(calendarTodoKey 모양)
export const isSyncedCalendarTodo = (id: string) => /^calendar:.+@\d{4}-\d{2}-\d{2}$/.test(id);
const keyDay = (id: string) => id.slice(-10);

// 지난 날의 끝내지 않은 일정 할 일 → 「언젠가」(P4). 내린 개수
export function lowerPastCalendarTodos(store: Store, day: string): number {
  let n = 0;
  for (const t of store.openTodos()) {
    if (!isSyncedCalendarTodo(t.id) || keyDay(t.id) >= day || t.priority === 4) continue;
    if (t.userEdited?.includes("priority") || t.doing) continue;
    store.ruleUpdateTodo(t.id, { priority: 4 }, "auto");
    n++;
  }
  return n;
}

// 할 일로 넣을 오늘 일정: 취소·거절·시각이 이상한 일정만 뺀다(혼자 잡은 작업 블록·종일 일정도 넣는다). 같은 id 나 같은 시작·제목은 하나로
export function calendarTodoEvents(events: CalEvent[], day: string): CalEvent[] {
  const seen = new Set<string>();
  const out: CalEvent[] = [];
  for (const e of [...events].sort((a, b) => a.start.localeCompare(b.start))) {
    if (e.cancelled || /^(canceled|cancelled|취소됨|취소)\s*:/i.test(e.subject)) continue;
    if (e.response === "declined") continue;
    const s = Date.parse(e.start), en = Date.parse(e.end);
    if (!Number.isFinite(s) || !(en > s)) continue;
    if (localDate(new Date(s)) !== day) continue;
    const k1 = `id:${e.id}`, k2 = `at:${e.start}|${e.subject.trim()}`;
    if (seen.has(k1) || seen.has(k2)) continue;
    seen.add(k1); seen.add(k2);
    out.push(e);
  }
  return out;
}

// 오늘 일정을 할 일로 넣는다. 새로 넣은 할 일만 돌려준다
export function syncCalendarTodos(store: Store, events: CalEvent[], now: Date = new Date()): Todo[] {
  const day = localDate(now);
  const added: Todo[] = [];
  lowerPastCalendarTodos(store, day);
  const others = new Set(store.openTodos().filter((t) => !isSyncedCalendarTodo(t.id)).map((t) => normTitle(t.title)));
  for (const e of calendarTodoEvents(events, day)) {
    const id = calendarTodoKey(e.id, day);
    const title = e.subject.replace(/\s+/g, " ").trim().slice(0, 300) || "(제목 없는 일정)";
    if (!store.getTodo(id) && normTitle(title) && others.has(normTitle(title))) continue; // 같은 제목의 할 일이 이미 있다 — 사본을 만들지 않는다
    const when = e.allDay ? "종일 일정" : `${localHhmm(new Date(e.start))}~${localHhmm(new Date(e.end))} 일정`;
    const up = store.upsertTodo({
      id, title, source: "calendar", priority: 1, sourceRef: id,
      ...(e.webLink || e.joinUrl ? { link: e.webLink ?? e.joinUrl } : {}),
      description: e.location ? `${when} · ${e.location}` : when,
    }, "auto", { fuzzy: false });
    if (up !== "added") continue;
    const t = store.editTodo(id, { today: day });
    if (t) added.push(t);
  }
  return added;
}
