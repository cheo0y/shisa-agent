// 로컬 뇌. SDK·HTTP·CLI를 부르지 않고, 넘겨받은 시각과 할 일 목록만으로 Thought를 만든다.
// 말투는 TONE(존댓말)을 따르고, 가끔 ~요·감정 표시는 voice()만 붙인다. 할 일을 새로 짓지 않는다.
import { localDate, localHhmm } from "./calendar.ts";
import { TONE, seedHash, voice, type Mood } from "./voice.ts";
import { character, type LocalLineKey } from "./characters.ts";
import { phrase } from "./phrases.ts";

export type LocalTodo = { title: string; priority?: number };
export type DayPart = "morning" | "lunch" | "afternoon" | "evening";

export type LocalThought = {
  bubble: string;
  reply_md: string;
  todos: [];
  done_todo_ids: [];
  proposals: [];
  greet?: DayPart; // 말풍선이 시간대 인사 그대로일 때 그 시간대(아침 인사 하루 한 번: core.ts)
};

// 모델 프롬프트와 같은 말투 한 줄. 로컬 대사는 이 톤으로 쓰고 양념은 voice()에 맡긴다.
export const LOCAL_TONE = TONE;

export const LINES = {
  morning: "좋은 아침이에요.",
  lunch: "점심 시간이에요.",
  leave: "{mins}분 뒤면 퇴근이에요. 오늘도 고생 많으셨어요, 안녕히 가세요.",
  afternoon: "좋은 오후예요.",
  evening: "좋은 저녁이에요.",
  remind: "오늘 꼭 할 일을 다시 일깨워 드려요.",
  praise: "최근에 끝낸 일을 칭찬드려요.",
  empty: "우선순위 1·3 열린 할 일은 비어 있어요.",
} as const;

// 지금 캐릭터의 정해진 말(characters.ts lines) — 없는 키는 아래 시사 말
export const SHISA_EXTRA = {
  emptyHead: "(비어 있어요)",
  praiseDone: "최근에 {titles}을 끝내셨어요. 잘하셨어요.",
  calThen: "그다음은 〈{title}〉, {when}이에요.",
} as const;
// 날씨 알리미(weather-say.ts): 출근 후·퇴근 20분 전·정한 시각·칩 「오늘 날씨?」. 앞에 날씨 이모지 하나는 코드가 붙인다
//  {place} 지역 · {summary} 날씨 낱말 · {now} 지금 기온 · {max}/{min} 최고·최저 · {rain} 비·눈 소식(weatherRain, 없으면 빈칸)
//  weatherRain·weatherLeaveRain: {when} 「오후 3시」 · {what} 비|눈 · {prob} 「60%」
export const WEATHER_LINES = {
  weatherMorning: "오늘 {place} {summary}, 지금 {now} · 최고 {max}/최저 {min}.{rain}",
  weatherLeave: "퇴근길 {place} {summary}, 지금 {now}예요. 조심히 들어가세요.",
  weatherLeaveRain: "퇴근길 {what} 와요, 우산! {when}쯤 {what} {prob}, {place} 지금 {now}예요.",
  weatherNow: "지금 {place} {summary}, {now} · 오늘 최고 {max}/최저 {min}.{rain}",
  weatherRain: " {when}쯤 {what} {prob}, 우산 챙겨요.",
  weatherNoPlace: "설정에서 지역을 고르면 알려 줄게요.",
  weatherFail: "날씨를 지금 못 가져왔어요. 잠시 뒤에 다시 물어봐 주세요.",
} as const;
export function localLine(key: LocalLineKey): string {
  const own = character().lines[key];
  if (own) return own;
  if (key in LINES) return LINES[key as keyof typeof LINES];
  if (key in SHISA_EXTRA) return SHISA_EXTRA[key as keyof typeof SHISA_EXTRA];
  if (key in WEATHER_LINES) return WEATHER_LINES[key as keyof typeof WEATHER_LINES];
  return QUICK_LINES[key as Exclude<keyof typeof QUICK_LINES, "cheer">];
}

const BUBBLE_MAX = 40;

// 이 맥의 시간대 기준 시(0~23). 이름은 예전 그대로(예전엔 Asia/Seoul 고정).
// 아침 05–12시, 점심 12–13시, 오후 13–18시, 그 밖(저녁·밤·새벽)은 저녁.
export function seoulHour(now: Date): number {
  return now.getHours();
}

export function dayPart(now: Date): DayPart {
  const h = seoulHour(now);
  if (h >= 5 && h < 12) return "morning";
  if (h === 12) return "lunch";
  if (h >= 13 && h < 18) return "afternoon";
  return "evening";
}

function seoulDay(now: Date): string {
  return localDate(now);
}

function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

function titles(list: LocalTodo[], priority?: number): string[] {
  return list
    .filter((t) => priority === undefined || t.priority === priority)
    .map((t) => cleanTitle(t.title))
    .filter(Boolean);
}

// 존댓말 문장에 voice() 양념만 붙인다
export function spoken(text: string, seed: string, mood: Mood = "happy"): string {
  void LOCAL_TONE;
  return voice(text, seed, { mood });
}

export function bubbleLine(text: string, seed: string, mood: Mood): string {
  const flavored = spoken(text, seed, mood);
  if (flavored.length <= BUBBLE_MAX && !flavored.includes("\n")) return flavored;
  if (text.length <= BUBBLE_MAX && !text.includes("\n")) return text;
  return text.slice(0, BUBBLE_MAX);
}

// 열린 할 일 중 우선순위 1·3 제목만. 둘 다 없으면 비어 있다고 말한다. 2·4는 넣지 않는다.
export function planReply(open: LocalTodo[]): string {
  const p1 = titles(open, 1);
  const p3 = titles(open, 3);
  if (!p1.length && !p3.length) return localLine("empty");
  const block = (heading: string, items: string[]) => [heading, ...(items.length ? items.map((t) => `- ${t}`) : [`- ${localLine("emptyHead")}`])];
  return [...block("## 우선순위 1", p1), "", ...block("## 우선순위 3", p3)].join("\n");
}

function praiseReply(done: LocalTodo[], seed: string): string {
  const doneTitles = titles(done);
  const base = doneTitles.length ? localLine("praiseDone").replace("{titles}", doneTitles.join(", ")) : localLine("praise");
  return spoken(base, `${seed}:praise`, "happy");
}

// 순수 함수. now·할 일 목록·seed만 본다. todos·done_todo_ids·proposals는 항상 빈 배열.
export function localThought(now: Date, open: LocalTodo[] = [], done: LocalTodo[] = [], seed = `local:${seoulDay(now)}`): LocalThought {
  const part = dayPart(now);
  const hasP1 = titles(open, 1).length > 0;
  const hasDone = titles(done).length > 0;
  const bubbleBase = localLine(hasP1 ? "remind" : hasDone ? "praise" : part);
  const bubbleMood: Mood = hasP1 ? "busy" : hasDone ? "happy" : "calm";
  const reply = [spoken(localLine(part), `${seed}:greet`, "calm"), "", planReply(open)];
  if (hasDone) reply.push("", praiseReply(done, seed));
  return {
    bubble: bubbleLine(bubbleBase, `${seed}:bubble`, bubbleMood),
    reply_md: reply.join("\n"),
    todos: [],
    done_todo_ids: [],
    proposals: [],
    ...(!hasP1 && !hasDone ? { greet: part } : {}),
  };
}

// ---- AI 없이 고르는 질문(캐릭터 더블클릭 → 칩). 모델 없이 오늘 할 일·할 일·캘린더만 보고 정해진 말로 답한다 ----
export const QUICK_ASKS = ["today", "next_todo", "next_event", "cheer", "dance"] as const;
export type QuickAskId = (typeof QUICK_ASKS)[number];
export const isQuickAsk = (v: unknown): v is QuickAskId => typeof v === "string" && (QUICK_ASKS as readonly string[]).includes(v);

export type QuickPlanItem = { title: string; done: boolean; priority?: number };
export type QuickMeeting = { subject: string; start: string; end: string; location?: string };
export type QuickFacts = {
  now: Date;
  today?: QuickPlanItem[]; // 오늘 할 일(열림·끝냄)
  open?: LocalTodo[]; // 열린 할 일(우선순위 순)
  calendar?: { enabled: boolean; meetings: QuickMeeting[]; state?: { phase: string; reason?: string } }; // state: 동기화 상태(calendar-state.ts)
};
// variant: 응원·춤 때 데몬이 고른 영상 번호(state.danceVariant 와 같다)
export type QuickAnswer = { id: QuickAskId; text: string; detail?: string; kind: "info" | "done"; open?: { section: "today" | "todos" | "setup"; id?: string }; variant?: number };

export const QUICK_LINES = {
  todayEmpty: "오늘 할 일이 아직 비어 있어요. 오늘 할 일 탭에 적어 주시면 같이 챙길게요.",
  todayPick: "오늘 꼭 할 일은 아직 없어요. 할 일 {n}개가 기다리고 있어요.",
  todayAll: "오늘 할 일 {total}개 다 끝냈어요! 정말 잘하셨어요.",
  todayNone: "오늘 할 일 {total}개 중 아직 끝낸 건 없어요. 하나만 먼저 해 봐요.",
  todaySome: "오늘 할 일 {total}개 중 {done}개 끝냈어요. 남은 건 {rest}예요.",
  todoEmpty: "지금 보이는 할 일이 없어요. 쉬어 가는 날도 필요해요.",
  todoTop: "지금은 '{title}'부터 해 보면 좋겠어요.",
  calOff: "캘린더를 연결하면 다음 일정도 알려 드릴게요. 설정의 더 연결하기에서 할 수 있어요.",
  calNone: "오늘과 내일은 잡힌 일정이 없어요. 여유 있게 보내요.",
  calLoading: "캘린더는 연결됐어요. 지금 일정을 가져오는 중이라 잠시 뒤에 다시 물어봐 주세요.",
  calFail: "캘린더는 연결됐는데 일정을 가져오지 못했어요. 까닭은 아래에 적어 둘게요.",
  calNow: "지금 〈{title}〉 일정 중이에요. {end}에 끝나요{where}.",
  calNext: "다음 일정은 〈{title}〉, {when}이에요{where}.",
  // 말로 집중하기(focus-ops.ts — 더블클릭 칩 「집중 시작할래?」·채팅 「집중 시작해 줘」)
  focusStart: "좋아요, 지금부터 같이 집중해요. 옆에서 조용히 응원할게요!",
  focusStartTodo: "'{title}' 집중 시작해요. 하나씩 차근차근 해 봐요!",
  focusAlready: "이미 {mins}분째 집중하고 있어요. 이대로 쭉 가 봐요.",
  focusStop: "{duration} 집중했어요. 잠깐 쉬어 가요!",
  focusIdle: "지금은 집중하고 있지 않아요.",
  cheer: [
    "오늘도 잘하고 있어요. 제가 옆에서 응원할게요!",
    "천천히 해도 괜찮아요. 하나씩 하면 다 돼요.",
    "벌써 여기까지 왔어요. 조금만 더 힘내요!",
    "잠깐 숨 고르고 물 한 잔 마셔요. 그다음에 같이 해 봐요.",
    "오늘 한 일도 충분히 대단해요. 수고 많으셨어요.",
  ],
} as const;

// 화면에 보이는 우선순위 이름(데스크톱 todos.js PRIORITIES 와 같다)
export const PRIO_LABEL: Record<number, string> = { 1: "오늘 꼭", 2: "이번 주", 3: "천천히", 4: "언젠가" };
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (all, k: string) => (k in v ? String(v[k]) : all));
const quote = (t: string) => `'${cleanTitle(t).slice(0, 30)}'`;

function hhmmKst(iso: string): string {
  return localHhmm(new Date(iso)); // 로컬
}

// "10분 뒤(14:30)" · "오늘 14:30" · "내일 09:00" · "10월 20일 09:00"
function whenText(iso: string, now: Date): string {
  const at = new Date(iso);
  const mins = Math.round((at.getTime() - now.getTime()) / 60e3);
  const hm = hhmmKst(iso);
  if (mins >= 0 && mins < 60) return `${Math.max(1, mins)}분 뒤(${hm})`;
  const day = seoulDay(at);
  const today = seoulDay(now);
  if (day === today) return `오늘 ${hm}`;
  if (day === seoulDay(new Date(now.getTime() + 864e5))) return `내일 ${hm}`;
  const [, m, d] = day.split("-").map(Number);
  return `${m}월 ${d}일 ${hm}`;
}

function answerToday(f: QuickFacts, seed: string): QuickAnswer {
  const items = (f.today ?? []).filter((x) => cleanTitle(x.title));
  if (!items.length) {
    const n = (f.open ?? []).length;
    return { id: "today", kind: "info", text: spoken(n ? fill(localLine("todayPick"), { n }) : localLine("todayEmpty"), seed, "calm"), open: { section: "today" } };
  }
  const total = items.length;
  const done = items.filter((x) => x.done).length;
  if (done === total) return { id: "today", kind: "done", text: spoken(fill(localLine("todayAll"), { total }), seed, "happy"), open: { section: "today" } };
  const left = items.filter((x) => !x.done);
  if (!done) return { id: "today", kind: "info", text: spoken(fill(localLine("todayNone"), { total }), seed, "busy"), detail: left.slice(0, 5).map((x) => `- ${cleanTitle(x.title)}`).join("\n"), open: { section: "today" } };
  const rest = left.slice(0, 2).map((x) => quote(x.title)).join(", ") + (left.length > 2 ? ` 외 ${left.length - 2}개` : "");
  return { id: "today", kind: "info", text: spoken(fill(localLine("todaySome"), { total, done, rest }), seed, "happy"), open: { section: "today" } };
}

function answerTodo(f: QuickFacts, seed: string): QuickAnswer {
  const open = (f.open ?? []).filter((t) => cleanTitle(t.title) && (t.priority ?? 2) <= 3);
  if (!open.length) return { id: "next_todo", kind: "info", text: spoken(localLine("todoEmpty"), seed, "calm"), open: { section: "todos" } };
  const sorted = [...open].sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2)); // 같은 우선순위는 받은 순서 그대로
  const top = sorted.slice(0, 3);
  return {
    id: "next_todo",
    kind: "info",
    text: spoken(fill(localLine("todoTop"), { title: cleanTitle(top[0].title).slice(0, 30) }), seed, "busy"),
    detail: top.map((t) => `- ${PRIO_LABEL[t.priority ?? 2] ?? PRIO_LABEL[2]} ${cleanTitle(t.title)}`).join("\n") + (sorted.length > 3 ? `\n- 그 밖에 ${sorted.length - 3}개` : ""),
    open: { section: "todos" },
  };
}

function answerEvent(f: QuickFacts, seed: string): QuickAnswer {
  const cal = f.calendar;
  if (!cal?.enabled) return { id: "next_event", kind: "info", text: spoken(localLine("calOff"), seed, "calm"), open: { section: "setup", id: "extras" } };
  const now = f.now.getTime();
  const list = cal.meetings
    .filter((m) => Number.isFinite(Date.parse(m.start)) && Number.isFinite(Date.parse(m.end)) && Date.parse(m.end) > now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (!list.length) {
    // 연결됐는데 아직 못 가져왔거나 실패했으면 「일정 없음」이라고 하지 않는다
    if (cal.state?.phase === "pending") return { id: "next_event", kind: "info", text: spoken(localLine("calLoading"), seed, "calm") };
    if (cal.state?.phase === "failed") return { id: "next_event", kind: "info", text: spoken(localLine("calFail"), seed, "calm"), ...(cal.state.reason ? { detail: cal.state.reason } : {}), open: { section: "setup", id: "extras" } };
    return { id: "next_event", kind: "info", text: spoken(localLine("calNone"), seed, "calm") };
  }
  const m = list[0];
  const where = m.location ? ` · 📍 ${cleanTitle(m.location).slice(0, 30)}` : "";
  const title = cleanTitle(m.subject).slice(0, 40) || "제목 없음";
  if (Date.parse(m.start) <= now) {
    const next = list.find((x) => Date.parse(x.start) > now);
    return {
      id: "next_event", kind: "info", text: fill(localLine("calNow"), { title, end: hhmmKst(m.end), where }),
      ...(next ? { detail: fill(localLine("calThen"), { title: cleanTitle(next.subject).slice(0, 40), when: whenText(next.start, f.now) }) } : {}),
    };
  }
  return { id: "next_event", kind: "info", text: fill(localLine("calNext"), { title, when: whenText(m.start, f.now), where }) };
}

// 순수 함수. 같은 seed 면 같은 답(응원 문구 고르기·말투 양념)
export function quickAnswer(id: QuickAskId, f: QuickFacts, seed = `quick:${seoulDay(f.now)}:${seoulHour(f.now)}`): QuickAnswer {
  const s = `${seed}:${id}`;
  if (id === "today") return answerToday(f, s);
  if (id === "next_todo") return answerTodo(f, s);
  if (id === "next_event") return answerEvent(f, s);
  if (id === "dance") return { id: "dance", kind: "done", text: phrase("dance", {}, (seedHash(s) % 1000) / 1000) }; // 춤 한마디(문구 dance) — 영상은 데몬이 튼다
  const lines = character().cheer ?? QUICK_LINES.cheer;
  return { id: "cheer", kind: "done", text: spoken(lines[seedHash(s) % lines.length], s, "happy") };
}

// POST /local/ask 처리: 모르는 id 면 undefined(400). 데이터는 부를 때마다 새로 읽는다
export type QuickSources = { now?: () => Date; today: () => QuickPlanItem[]; open: () => LocalTodo[]; calendar: () => QuickFacts["calendar"] };
export function localAsk(id: unknown, src: QuickSources): QuickAnswer | undefined {
  if (!isQuickAsk(id)) return undefined;
  const now = src.now?.() ?? new Date();
  const facts: QuickFacts = { now };
  if (id === "today") { facts.today = src.today(); facts.open = src.open(); }
  if (id === "next_todo") facts.open = src.open();
  if (id === "next_event") facts.calendar = src.calendar();
  // 응원·춤은 누를 때마다 다른 줄(같은 시간대에도)
  return quickAnswer(id, facts, id === "cheer" || id === "dance" ? `quick:${now.getTime()}:${Math.random()}` : undefined);
}
