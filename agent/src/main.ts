// 데몬 엔트리포인트: 버스 + Slack + 주기 작업(세션·Slack 수집, 프로필 학습, 브리핑)
import { installFileLog, stallLag } from "./log.ts";
import { loadConfig } from "./config.ts";
import { DEFAULT_TODAY_REMINDER } from "./daily-plan.ts";
import { localAsk, localLine } from "./local-mode.ts";
import { LEAVE_BEFORE_MIN, WorkAlerts, minsToLeave, workHoursOf } from "./work-hours.ts";
import { Weather, setWeatherPeek, weatherDue, weatherLine, weatherOf } from "./weather.ts";
import { failText as weatherFailText, noPlaceText as weatherNoPlaceText, weatherText } from "./weather-say.ts";
import { Store } from "./store.ts";
import { Bus, EXIT_PORT_TAKEN } from "./bus.ts";
import { runs } from "./runs.ts";
import { modelChoices } from "./models.ts";
import { codingChoice, setClaudeProbe } from "./coding.ts";
import { chatModels } from "./chat-models.ts";
import { Agent, LOCAL_GREET_ID } from "./core.ts";
import { suggestTitle } from "./chat.ts";
import { briefingDue } from "./briefing-sources.ts";
import { loadCommands, SlashCommands } from "./commands.ts";
import { createSlack } from "./slack/app.ts";
import { TodoCanvas, openDm } from "./slack/canvas.ts";
import { SlackIngester } from "./ingest/slack.ts";
import { learnFrom } from "./profile.ts";
import { runAfterSlackIngest } from "./todo-auto.ts";
import { checkProgress } from "./todo-progress.ts";
import { McpHealth, connectorServerUrls, healthNote } from "./mcp-health.ts";
import { Reactions, realMergeAsk } from "./reactions.ts";
import { HOME_DIR } from "./config.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { WAIT_SETUP, markFreshInstall, modelWorkAllowed, sessionsAllowed } from "./onboarding.ts";
import { execFile } from "node:child_process";
import { openSpec } from "./plat.ts";
import { CalendarSync, alertDetail, alertVars, probeIcs } from "./calendar-sync.ts";
import { withCalendarSync } from "./calendar-state.ts";
import { MailSync, withMailSync } from "./mail-sync.ts";
import { connectMail, removeMailAccount } from "./mail-connect.ts";
import { addCalendar, calendarCardRows, calendarList as calendarListOf } from "./calendar-connect.ts";
import { calendarPick } from "./manual-projects.ts";
import { CalendarView } from "./calendar-view.ts";
import { setCalendarRead } from "./calendar-ai.ts";
import { withRun, asRoutine } from "./runs.ts";
import { KgBackfill } from "./kg/backfill.ts";
import { refineIncremental } from "./kg/refine.ts";
import { connectorStatus, connectorsChanged, resolveConnectors } from "./connectors.ts";
import { phrase, phraseVoice, fillVars } from "./phrases.ts";
import { probeGh } from "./gh.ts";
import { CliSync } from "./cli-sync.ts";
import { AgentsNotifier, AGENT_LIMITS, agentsForThread, sessionsForThread, threadWorktrees } from "./thread-agents.ts";
import { worktreeRecords } from "./agent-worktrees.ts";
import { Settings } from "./settings.ts";
import { CharacterStore } from "./character-store.ts";
import { disconnectConnector } from "./disconnect.ts";
import { CHECK_IDS, Connections, lastRunOf, type CheckId } from "./connections.ts";
import { statusOf } from "./status.ts";
import { featureBrain, NEEDS_CLAUDE_MCP, NEEDS_CODER, withMcpBrain } from "./feature-brain.ts";
import { mergePr } from "./fixer.ts";
import { cleanupStaleCodexHomes } from "./codex-coder.ts";
import { askBtw } from "./btw.ts";
import { Focus, focusApi, focusDoneText } from "./focus.ts";
import { applyFocusOps, chipFocusTodo, focusAsk, isFocusAsk, setFocusPeek } from "./focus-ops.ts";
import { brainAuthFailed, brainCreditNeeded, onBrainAuthChange } from "./providers.ts";
import { briefingHours } from "./calendar.ts";
import { performance } from "node:perf_hooks";

installFileLog();
// 새 설치면 config.json 에 "onboarded": false 를 남긴다: 설치 마법사를 마칠 때까지 아무것도 읽지 않고 모델도 부르지 않는다(onboarding.ts)
try {
  if (markFreshInstall(join(HOME_DIR, "config.json"), process.env, existsSync(process.env.CY_AGENT_DB ?? join(HOME_DIR, "cy.db"))))
    console.log("[onboarding] 새 설치: 설치 마법사를 마칠 때까지 작업 기록·레포를 읽지 않고 모델도 부르지 않아요");
} catch (e: any) { console.warn("[onboarding] 설정 파일에 표시하지 못했어요:", e?.message ?? e); }
// 놓친 거부(예: 틀린 Slack 토큰으로 라이브러리가 뒤에서 던진 오류)로 늘 켜져 있어야 할 데몬이 죽지 않게: 경고만 남긴다
process.on("unhandledRejection", (e: any) => console.warn("[cy-agent] 처리 안 된 오류:", e?.data?.error ?? e?.message ?? e));

const cfg = loadConfig();
// 포트부터 잡는다: cy.db 를 열고 끊긴 턴을 닫기(closeDanglingTurns) 전에. 이미 데몬이 떠 있으면 그 데몬의 턴을 건드리지 않고 여기서 끝낸다.
// 처리기는 아래 bus.listen 이 붙인다(그 사이엔 await 이 없어 요청이 기다릴 일은 거의 없다)
const bus = new Bus();
try {
  await bus.bind(cfg.port);
} catch (e: any) {
  if (e?.code === "EADDRINUSE") {
    console.error(`[cy-agent] 포트 ${cfg.port} 를 이미 다른 데몬이나 프로그램이 쓰고 있어 이 데몬은 끝낼게요 (종료 코드 ${EXIT_PORT_TAKEN})`);
    process.exit(EXIT_PORT_TAKEN);
  }
  // Windows: Hyper-V·WSL·Docker 가 이 포트를 예약 범위에 넣으면 EADDRINUSE 가 아니라 EACCES 로 막힌다(아무도 안 쓰는데 못 연다)
  if (e?.code === "EACCES") console.error(`[cy-agent] 포트 ${cfg.port} 를 열 권한이 없어요.${process.platform === "win32" ? " 윈도우가 이 포트를 예약해 둔 것일 수 있어요(확인: netsh interface ipv4 show excludedportrange protocol=tcp)." : ""}`);
  throw e;
}
if (!modelWorkAllowed(cfg)) console.log("[onboarding] 설치 마법사를 마치기 전: 브리핑·정리 작업은 쉬어요");
console.log(`[onboarding] 작업 기록(Claude Code·Codex) 읽기: ${sessionsAllowed(cfg) ? "켬" : "끔"} · 레포 폴더 ${cfg.repoRoots.length}개`);
// 커넥터(connectors.ts): 기능별 데이터 원천. 연결 안 된 기능은 조용히 빠진다
const conns = cfg.connectors;
for (const c of connectorStatus(conns)) console.log(`[connectors] ${c.label}: ${c.mode}${c.ready ? "" : " (준비 안 됨)"} · ${c.detail}`);
console.log(`[brain] ${cfg.brain.provider}`);
{ // 뒤에서 하는 정리(끝난 할 일 판정·진행 확인·지식그래프·프로필 학습)를 누가 돌리나 — 시작할 때 한 줄
  const fb = featureBrain(cfg);
  console.log(`[features] 뒤에서 하는 정리: ${fb === "codex" ? "Codex" : fb === "claude-code" ? "Claude Code" : `안 돎 — ${NEEDS_CODER}`}${cfg.brain.provider !== "claude-code" ? ` · ${NEEDS_CLAUDE_MCP}` : ""}`);
}
// 읽기 전용 GitHub 도구: 설정이 안 정했으면 gh 로그인 여부로(비동기 — 시작을 막지 않는다)
if (cfg.github?.enabled === undefined) probeGh({ bin: cfg.github?.bin }).then((ok) => console.log(`[cy-agent] GitHub(gh) 읽기 도구 ${ok ? "켬" : "끔 — gh auth status 실패"}`));
const store = new Store(cfg.dbPath);
runs.attach(store.db); // 작업 세션 기록(세션 창)을 cy.db 에
bus.activity.bindRuns(runs); // 돌고 있는 run(대화 제외) → 캐릭터 "공부 중"
// 집중하기(포커스 타이머): 기록은 cy.db, 바뀌면 SSE focus · 그만하면 「N분 집중했어요」 말풍선. AI 없이도 돈다
const focus = new Focus(store);
focus.onChange = (v) => bus.focusChanged(v);
focus.onStop = (sec) => { if (sec > 0) bus.bubble({ id: "focus:done", text: focusDoneText(sec), kind: "done", ttlMs: 8000 }); };
focus.startTimer();
setFocusPeek(() => focus.view()); // 채팅 프롬프트의 「집중하기」 줄
// 일정 알림(설정 calendarAlert, 기본 10분 전): 오늘·내일 일정(커넥터 calendar: ICS·MCP, 읽기 전용). 30분마다·깨어날 때 다시 가져온다
const calendar = new CalendarSync(cfg, store, { wrapRun: (fn) => withRun({ kind: "calendar", title: "캘린더 동기화", model: cfg.models.light }, fn) });
calendar.onChange = () => bus.dashboardChanged();
// 캘린더 탭: 보는 기간을 ICS 에서 직접 읽는다(받은 글은 몇 분 들고 있다). MCP 는 동기화해 둔 회의만
const calendarView = new CalendarView({ conn: () => cfg.connectors.calendar, configPath: join(HOME_DIR, "config.json"), state: () => calendar.state(), meetings: (from, to) => calendar.between(from, to) });
// AI 도 같은 길로 다음 주·이번 달 일정을 읽는다(맥락 도구 calendar_events · 도구 없는 뇌의 일정 블록, calendar-ai.ts)
setCalendarRead((range) => calendarView.events(range), () => { const c = cfg.connectors.calendar; return c.mode === "api" && c.cap === "calendar" ? c.timeZone : "Asia/Seoul"; });
// 메일(앱 비밀번호 IMAP, 읽기 전용): 15분마다·브리핑 직전에 받은편지함을 가져와 브리핑·채팅 맥락에 넣는다(mail-sync.ts)
const mailSync = new MailSync(store, cfg.connectors.mail);
mailSync.onChange = () => bus.dashboardChanged();
// 터미널 Claude Code 에서 이어 간 대화 불러오기(세션 창 ↻·"Claude Code에서 열기" 뒤 지켜보기). 시작할 땐 아무것도 안 한다
const cliSync = new CliSync({ runs, db: store.db, store, onThread: (id) => bus.threads({ thread: store.thread(id) }), log: (m) => console.log(m) });
// 대화 속 서브에이전트·작업 세션 카드: 바뀌면 ≈1초 모아 SSE agents {threadId} → 패널이 다시 가져온다
new AgentsNotifier(runs, (threadId) => bus.agents(threadId));
let agent!: Agent;
let startGreetAt = 0; // 출근 인사를 띄운 때 — 이 뒤 10분 안의 로컬 브리핑 시간대 인사는 띄우지 않는다(날씨 「출근 후」도 이 뒤)
let slack = createSlack(cfg, () => agent);
// 채팅 슬래시 명령 목록: 처음 물을 때 SDK 에서(모델 턴 없이), 10분마다 새로
const commands = new SlashCommands(() => loadCommands());
agent = new Agent(cfg, store, bus, slack?.port, { retitle: suggestTitle, commands, mergePr, focusOps: (ops) => applyFocusOps(focus, ops, () => store.openTodos()), greetOk: (part) => (part === "morning" ? greetMorning() : Date.now() - startGreetAt > GREET_QUIET_MS),
  autoMergeOp: (op, slug) => settings.autoMergeOp(op, slug), beforeBriefing: () => (mailSync.enabled ? mailSync.sync() : Promise.resolve()) }); // 새 대화 제목: 가벼운 모델(답 뒤에 따로) · 자동 머지 레포는 설정 창과 같은 config.json 에
// 캐릭터 반응(그림 말풍선·진행 보고·머지 승인). 하루 한 번 규칙은 reactions.json 에 남는다
const reactions = new Reactions(bus, { logPath: join(HOME_DIR, "reactions.json"), lotsThreshold: Number(process.env.CY_LOTS_THRESHOLD) || 8 });
agent.setReactions(reactions, realMergeAsk(cfg));
agent.onBriefed = () => { setTimeout(() => safeWeather(), 3000).unref?.(); }; // 아침 브리핑이 끝나면 곧 「출근 후」 날씨

const safe = (name: string, fn: () => unknown) => async () => {
  try { await fn(); } catch (e: any) { console.error(`[cy-agent] ${name} 실패:`, e?.data?.error ?? e?.message ?? e); }
};
// 이전 데몬이 답하다 꺼진 턴(배포·재시작)을 닫는다 — 물음만 덩그러니 남지 않게
safe("close-dangling", () => { const k = agent.closeDanglingTurns(); if (k) console.log(`[chat] 끊긴 대화 ${k}개 닫음`); })();

// 오늘 할 일 알림: 설정(todayReminder)대로, 모델 없이 정해진 말로(뇌가 없거나 local 이어도 뜬다)
// 아침 안내(ask)는 예전처럼 패널 '오늘 할 일'도 연다. 오버레이가 붙을 때(앱 첫 실행)와 1분마다 확인
function remindToday(opened = false) {
  const r = agent.dailyPlan().remind(cfg.todayReminder ?? DEFAULT_TODAY_REMINDER, { opened });
  if (!r) return;
  bus.bubble({
    id: `today:${r.plan.date}`,
    text: r.text,
    kind: "todo",
    ttlMs: r.carry ? 10 * 60e3 : 60e3, // 어제 남은 것 물음은 고를 때까지 조금 더 오래
    open: { section: "today" },
    ...(r.carry ? { carry: { n: r.carry.n } } : {}),
  });
  bus.dashboardChanged();
  if (r.kind === "ask") bus.openPanel("today");
}
// 근무 시간(work-hours.ts, 설정 창 「근무 시간」): 근무일에 하루 한 번씩. 기록은 lunch.json(점심·출근·퇴근 날짜)
//  - 출근 인사: 출근 시각 뒤 처음 확인할 때 아침 인사(local.morning, 영상 없음). 로컬 뇌 브리핑의 아침 인사와 같은 기록이라 두 번 안 뜬다
//  - 점심: 점심 시각부터 한 시간 안에 점심 영상(칸 lunch — 기본은 그 캐릭터의 일정 알림 영상) + 점심 인사
//  - 퇴근 10분 전: 일정 알림(plan) 영상 + 퇴근 인사(local.leave). plan 영상의 한마디는 일정용이라 쓰지 않는다
const workAlerts = new WorkAlerts(join(HOME_DIR, "lunch.json"));
const GREET_QUIET_MS = 10 * 60e3;
function workTick() {
  const wh = workHoursOf(cfg as unknown as Record<string, unknown>);
  const start = workAlerts.due("start", wh);
  if (start) { startGreetAt = Date.now(); bus.bubble({ id: LOCAL_GREET_ID, text: localLine("morning"), kind: "info", ttlMs: 60e3 }); }
  const busy = () => bus.activity.snapshot().danceClip === "plan"; // 일정 알림 춤 중이면 점심·퇴근은 다음 확인(1분 뒤)에
  const lunchDay = workAlerts.due("lunch", wh, busy());
  if (lunchDay) {
    const d = bus.activity.play(8000, "lunch"); // 영상 번호는 여기서(그 영상에 한마디가 있으면 그 말)
    bus.bubble({ id: `lunch:${lunchDay}`, text: d.say ?? localLine("lunch"), kind: "info", ttlMs: 60e3 });
  }
  const leaveDay = workAlerts.due("leave", wh, busy());
  if (leaveDay) {
    bus.activity.play(8000, "plan");
    const mins = minsToLeave(wh, new Date()) ?? LEAVE_BEFORE_MIN;
    bus.bubble({ id: `leave:${leaveDay}`, text: fillVars(localLine("leave"), { mins: String(mins) }), kind: "info", ttlMs: 60e3 });
  }
}
const safeWork = () => { try { workTick(); } catch (e: any) { console.warn("[work-hours] 알림:", e?.message ?? e); } safeWeather(); };
// 로컬 뇌 브리핑의 아침 인사가 오늘 첫 출근 인사가 되면 그때를 출근 인사 시각으로(날씨 「출근 후」가 그 뒤에)
function greetMorning(): boolean {
  if (!workAlerts.claim("start")) return false;
  startGreetAt = Date.now();
  return true;
}
// 날씨 알리미(weather.ts, 설정 창 「날씨」): 지역을 골랐을 때만. Open-Meteo 예보(45분 캐시)를 정해진 말로(AI 없이)
//  - 출근 후 브리핑 다음 · 퇴근 20분 전(퇴근 시간대 날씨, 비·눈이면 ☔ 우산!) · 사람이 정한 시각. 근무 요일에 하루 한 번씩(lunch.json)
//  - 예보를 못 가져오면 남기지 않고 다음 확인(1분 뒤 · 실패 뒤 5분은 다시 묻지 않는다) — 연결 상태 「날씨」 줄에 이유
const weather = new Weather(() => weatherOf(cfg.weather));
const startedAt = Date.now();
setWeatherPeek(() => { const p = weather.place, f = weather.cached(); return p && f ? weatherLine(p, f) : ""; }); // 채팅·브리핑 맥락 한 줄
let weatherBusy = false;
async function weatherTick() {
  if (weatherBusy) return;
  const wc = weatherOf(cfg.weather);
  const place = wc.place;
  if (!place) return;
  const wh = workHoursOf(cfg as unknown as Record<string, unknown>);
  const slot = weatherDue({
    cfg: wc, wh, now: new Date(), done: (k) => workAlerts.doneKey(k),
    greetedAt: startGreetAt || null, greetedToday: workAlerts.done("start"), startedAt,
    briefing: { running: agent.briefingBusy, doneAt: agent.briefedAt },
  });
  if (!slot) return;
  if (slot.kind === "leave" && bus.activity.snapshot().danceClip === "plan") return; // 일정 알림 춤 중이면 다음 확인에
  weatherBusy = true;
  try {
    const f = await weather.forecast();
    if (!f || !workAlerts.claimKey(slot.key)) return;
    const t = weatherText(slot.kind === "leave" ? "leave" : slot.kind === "morning" ? "morning" : "now", place, f, { workEnd: wh.workEnd });
    bus.bubble({ id: `weather:${slot.key}`, text: t.text, kind: t.rain ? "todo" : "info", ttlMs: 60e3 });
  } finally { weatherBusy = false; }
}
const safeWeather = () => { weatherTick().catch((e: any) => console.warn("[weather] 알림:", e?.message ?? e)); };
bus.onOverlay = () => { remindToday(true); safeWork(); };
setInterval(() => {
  try { remindToday(false); } catch (e: any) { console.warn("[today] 알림:", e?.message ?? e); }
  safeWork();
}, 60e3).unref?.();

// 설정 창: 모델·브리핑 출처(바로 반영 + config.json) · 연결 상태(읽기만). KG 상태는 아래에서 kgBackfill 이 생긴 뒤에 붙는다
// 뇌·이름·레포 폴더를 바꾸면 바로 반영되고(재시작 불필요) 데스크톱에 SSE status 로 알린다
// 커넥터는 시작 때 한 번 정한다(캘린더 동기화·Slack 수집·가드가 붙잡고 있다). 마법사·[연결 해제]가 바꾸면 다시 켜서 반영:
// launchd(install.sh, KeepAlive) 아래면 스스로 끄고 launchd 가 다시 켠다. 손으로 띄운 데몬은 바뀜만 알린다
// 캘린더만 바뀌었으면 다시 켜지 않고 바로 반영한다(원천을 바꾸고 곧바로 한 번 가져온다, applied). 다른 연결이 바뀌면 예전처럼
function reloadConnectors(): { changed: boolean; restarting: boolean; applied?: boolean } {
  const next = resolveConnectors();
  let applied = false;
  if (connectorsChanged({ ...cfg.connectors, calendar: next.calendar }, cfg.connectors)) {
    cfg.connectors.calendar = next.calendar;
    calendar.setConnector(next.calendar);
    applied = true;
    console.log(`[connectors] 캘린더 연결이 바뀜(${next.calendar.mode}), 바로 일정을 가져와요`);
    pushStatus();
    bus.dashboardChanged();
  }
  // 메일도 다시 켜지 않고 바로 반영한다(연결 확인·연결 해제 뒤)
  if (connectorsChanged({ ...cfg.connectors, mail: next.mail }, cfg.connectors)) {
    cfg.connectors.mail = next.mail;
    mailSync.setConnector(next.mail);
    applied = true;
    console.log(`[connectors] 메일 연결이 바뀜(${next.mail.mode})`);
    bus.dashboardChanged();
  }
  const changed = connectorsChanged(cfg.connectors, next);
  const restarting = changed && process.env.CY_AGENT_SUPERVISED === "1";
  if (changed) console.log(`[connectors] config.json 의 연결이 바뀜, ${restarting ? "다시 시작해요" : "데몬을 다시 켜야 다 반영돼요"}`);
  // Windows 에서 제게 SIGTERM 을 보내면 핸들러 없이 바로 끝나므로 핸들러를 직접 부른다
  if (restarting) setTimeout(() => (process.platform === "win32" ? void shutdown() : process.kill(process.pid, "SIGTERM")), 500);
  return { changed: changed || applied, restarting, ...(applied ? { applied } : {}) };
}
// 사용자 캐릭터·기본 캐릭터 대사 고친 것(~/.cy-agent/characters/): Settings 가 config.json character 를 고르기 전에 읽어 둔다
const characterStore = new CharacterStore(join(HOME_DIR, "characters"));
try { characterStore.load(); } catch (e: any) { console.warn("[characters] 사용자 캐릭터를 읽지 못했어요:", e?.message ?? e); }
characterStore.onChange = ({ removedCurrent }) => {
  // 지금 쓰던 캐릭터를 지움 → 시사로(config.json 도). put 이 state 를 다시 보낸다
  if (removedCurrent) settings.put({ character: "shisa" });
  bus.charactersChanged();
  bus.characterChanged(); // 이름·대사가 바뀐 지금 캐릭터도 바로
};
const settings = new Settings(cfg, { onChange: (keys) => {
  if (keys.some((k) => k === "brain" || k === "user" || k === "onboarded")) pushStatus();
  if (keys.includes("onboarded") && modelWorkAllowed(cfg)) setTimeout(() => onboardedNow(), 0); // 마법사를 막 마침 → 첫 정리
  else if (keys.includes("readSessions") && sessionsAllowed(cfg)) setTimeout(() => ingest(), 0);
  if (keys.includes("calendarAlert")) calendar.check(); // 알림 시각을 바로 다시 잡는다
  // 뇌를 바꿈(MCP 캘린더는 Claude Code 뇌로만 읽는다)·마법사를 마침 → 캘린더를 바로 한 번 다시 가져온다(이유·상태 줄도 그에 맞게)
  if (calendar.enabled && keys.some((k) => k === "brain" || k === "onboarded")) calendar.sync().catch(() => {});
  if (keys.includes("character")) bus.characterChanged(); // 앱 그림·영상을 바로 바꾼다
  if (keys.includes("weather")) { weather.reset(); if (weather.place) void weather.forecast(); } // 새 지역은 바로 한 번 가져온다
} });
let kgStatus: (() => { phase: string; reason?: string; step?: string }) | undefined;
const connections = new Connections(cfg, { lastRun: lastRunOf((o) => runs.listRuns(o)), kg: () => kgStatus?.(), calendar: () => calendar.state(), mail: () => mailSync.state(), weather: () => weather.state() });
// GET /status: 뇌가 claude-code 인데 로그인 확인 전이면 한 번 확인을 걸고(비동기) 끝나면 SSE status 로 알린다
const status = () => statusOf(cfg, { claude: () => connections.claudeLoggedIn() });
setClaudeProbe(() => connections.claudeLoggedIn()); // 코드 작업 AI 고르기·준비(coding.ts)
let claudeProbe: Promise<void> | undefined;
const probeClaude = () => (claudeProbe ??= connections.check("claude").then(() => pushStatus()));
function pushStatus() {
  if (cfg.brain.provider === "claude-code" && connections.claudeLoggedIn() === undefined) void probeClaude();
  bus.statusChanged(status());
}
onBrainAuthChange(() => pushStatus()); // API 키가 401·403 을 받음 ↔ 다시 됨 → 데스크톱에 바로
if (cfg.configError) console.error("[config] 안전 모드: 설정 파일을 고칠 때까지 아무것도 읽지 않고 로컬 뇌로 돌아요");

await bus.listen(cfg.port, {
  approve: (id) => agent.approve(id),
  hold: (id) => agent.hold(id),
  briefing: () => agent.runBriefing(),
  refresh: () => refreshAll(),
  dashboard: async () => ({
    ...(await agent.dashboard()),
    meetings: calendar.enabled ? calendar.upcoming().map(({ webLink: _w, ...m }) => m) : [],
    connectors: withMailSync(withCalendarSync(withMcpBrain(cfg, connectorStatus(conns)), calendar.state()), mailSync.state()) // MCP 연결은 Claude Code 뇌일 때만 읽는다. 캘린더는 실제로 가져왔는지도
      // ICS 캘린더는 캘린더마다 줄(색·켜짐·결과): 개요 연결 카드가 그 자리에서 켜고 끈다
      .map((c) => (c.cap === "calendar" && c.mode === "api" ? { ...c, calendars: calendarCardRows(join(HOME_DIR, "config.json"), calendar.state()) } : c)),
  }),
  todoDone: (id) => agent.todoDone(id),
  todayCarry: (decision) => {
    const r = agent.dailyPlan().carry(decision);
    bus.clear(`today:${r.plan.date}`); // 아침 질문 말풍선은 걷는다(패널 안내도 사라진다)
    bus.dashboardChanged();
    return { moved: r.moved };
  },
  todoAdd: (t) => agent.addTodo(t),
  todoEdit: (id, patch) => agent.editTodo(id, patch),
  todoDelete: (id) => agent.deleteTodo(id),
  todoRestore: (id) => agent.restoreTodo(id),
  todoPurge: (id) => agent.purgeTodo(id),
  todoTrashEmpty: () => agent.emptyTrash(),
  todoRevert: (id) => agent.revertAutoTodo(id),
  todoDetail: (id) => agent.todoDetail(id),
  todoLastAsk: (id) => agent.lastAsk(id),
  todoReorder: (id, priority, beforeId) => agent.reorderTodo(id, priority, beforeId),
  projectHide: (id) => agent.hideProject(id),
  projectUnhide: (id) => agent.unhideProject(id),
  manualProjects: agent.manualProjectsApi(),
  projectExists: (id) => agent.projectExists(id),
  calendarPick: () => calendarPick(calendar),
  calendarEvents: (range) => calendarView.events(range),
  todoAsk: (id, text) => agent.askTodo(id, text),
  todoApply: (id, ops, rev, rule) => agent.applyAsk(id, ops, rev, rule),
  todoReject: (id, text, ops, rule) => agent.rejectAsk(id, text, ops, rule),
  todoRules: () => agent.todoRules(),
  todoLedger: (day) => agent.todoLedger(day),
  todoRuleEdit: (id, patch) => agent.editRule(id, patch),
  todoRuleDelete: (id) => agent.deleteRule(id),
  chat: (text, opts) => agent.chat(text, opts ?? {}),
  chatStop: (chatId) => agent.chatStop(chatId),
  chatNow: (chatId) => agent.chatNow(chatId),
  chatEdit: (threadId, n, text, o) => agent.chatEdit(threadId, n, text, o),
  chatEditQueued: (chatId, text) => agent.chatEditQueued(chatId, text),
  chatQueue: () => agent.chatQueue(),
  chatThreads: {
    list: (o) => agent.threads(o),
    create: (t) => agent.createThread(t),
    edit: (id, patch) => agent.editThread(id, patch),
    remove: (id) => agent.deleteThread(id),
    messages: (id, o) => agent.threadMessages(id, o),
  },
  todoExists: (id) => !!agent.getTodo(id),
  chatHistory: () => agent.chatHistory(50),
  attachments: {
    stage: (name, mime, bytes) => agent.stageAttachment(name, mime, bytes),
    file: (threadId, file) => agent.attachmentPath(threadId, file),
    open: (p) => { const o = openSpec(p); execFile(o.file, o.args, { windowsVerbatimArguments: o.verbatim, windowsHide: true }, () => {}); }, // 기본 앱으로(경로는 bus 가 첨부 폴더 안인지 확인한 것)
    claimRun: (runId, ids) => (runs.getRun(runId, Number.MAX_SAFE_INTEGER) ? agent.claimRunAttachments(runId, ids) : { error: "no such run" }),
  },
  profileFacts: () => agent.memories(),
  profileRemember: (text, category) => agent.remember(text, category),
  profileForget: (idOrText) => agent.forgetMemory(idOrText),
  mergeDecide: (id, decision) => agent.mergeDecide(id, decision),
  mergeAsk: (id, text) => agent.mergeAsk(id, text),
  runs,
  runContinue: (id, text, model) => agent.continueRun(id, text, model),
  runBtw: (id, text, model, att) => askBtw({ runs, cfg }, id, text, model, att), // /btw 곁질문 — run 에 끼어들지 않음
  runSync: (id, o) => (o.watch ? cliSync.watch(id) : cliSync.sync(id)),
  threadSync: (id) => cliSync.syncThread(id),
  runImport: (sid) => cliSync.importSession(sid),
  threadAgents: (id) => (store.thread(id) ? agentsForThread(runs, id, (t) => agent.bgAgents.get(t)) : undefined),
  agentStop: (toolUseId) => agent.bgAgents.stop(toolUseId),
  threadSessions: (id) => (store.thread(id) ? sessionsForThread(runs, id, (pid) => store.proposal(pid)?.created) : undefined),
  threadWorktrees: (id) => (store.thread(id) ? threadWorktrees({
    fixRuns: runs.runsInThread(id, AGENT_LIMITS.runs).filter((r) => r.kind === "fix"),
    bg: agent.bgAgents.list(id), subs: worktreeRecords.forThread(id),
    tokensOf: (runId, parent) => runs.tokensOf(runId, parent), askedAt: (pid) => store.proposal(pid)?.created,
  }) : undefined),
  models: () => { const c = codingChoice(cfg); return { choices: modelChoices(cfg, c.provider), defaults: { fix: c.model ?? "", chat: cfg.models.general } }; },
  chatModels: (fresh) => chatModels(cfg, { fresh }),
  commands: () => commands.list(),
  repos: () => agent.repos(),
  newTask: (repo, text) => agent.newTask(repo, text),
  actions: {
    list: (o) => agent.listActions(o),
    get: (id) => agent.getAction(id),
    confirm: (id, o) => agent.confirmAction(id, o ?? {}),
    cancel: (id) => agent.cancelAction(id),
  },
  permissions: {
    list: () => agent.listPermissions(),
    remove: (id) => agent.deletePermission(id),
  },
  settings: { get: () => settings.view(), put: (body) => settings.put(body) },
  characters: characterStore,
  // AI 없이 고르는 질문(캐릭터 더블클릭 칩): 오늘 할 일·열린 할 일·캘린더만 보고 정해진 말로
  // 응원해 줘·춤춰 줘: 답과 함께 그 캐릭터의 응원·춤 영상(앱이 캐릭터마다 고른다)
  weatherSearch: (q) => weather.search(q),
  localAsk: (id) => {
    // 「오늘 날씨?」: 지역을 안 골랐으면 설정 안내, 아니면 예보(캐시 45분)를 정해진 말로
    if (id === "weather") {
      const place = weather.place;
      if (!place) return { id, kind: "info", text: weatherNoPlaceText() };
      return weather.forecast().then((f) => {
        if (!f) { const st = weather.state(); return { id, kind: "info", text: weatherFailText(), ...(st.phase === "failed" ? { detail: st.reason } : {}) }; }
        const t = weatherText("now", place, f);
        return { id, kind: "info", text: t.text, detail: `${place.label} · 예보: Open-Meteo` };
      });
    }
    // 「집중 시작할래?」·「집중 그만할래?」: 할 일은 진행 중(▶)인 것 → 오늘 할 일 중 안 끝낸 첫 번째 → 없이
    if (isFocusAsk(id)) {
      return focusAsk(id, focus, () => chipFocusTodo(store.openTodos().filter((t) => t.doing === true), agent.dailyPlan().state().items));
    }
    const answer = localAsk(id, {
      today: () => agent.dailyPlan().state().items,
      open: () => store.openTodos(),
      calendar: () => ({ enabled: calendar.enabled, meetings: calendar.enabled ? calendar.upcoming() : [], state: calendar.state() }),
    });
    if (answer?.id !== "cheer" && answer?.id !== "dance") return answer;
    // 영상 번호는 데몬이 고른다(state.danceVariant). 그 영상에 전용 한마디가 있으면 답 글도 그 말로
    const d = bus.activity.play(8000, answer.id);
    return { ...answer, ...(d.say ? { text: d.say } : {}), variant: d.variant };
  },
  guidelines: agent.guidelinesApi(),
  focus: focusApi(focus),
  connections: { ids: CHECK_IDS, list: () => { if (weather.state().phase === "pending") void weather.forecast(); return connections.list(); }, recheck: async (id) => { const r = await connections.recheck(id as CheckId | undefined); bus.statusChanged(status()); return r; } },
  status: () => {
    if (connections.claudeLoggedIn() === undefined) void probeClaude(); // 코드 기능(Claude Code)도 이걸로 가른다
    return status();
  },
  connectorsReload: () => reloadConnectors(),
  // 캘린더 하나 더하기: 그 캘린더만 시험으로 읽고 되면 저장 → 다시 읽어 전체 동기화(reloadConnectors → calendar.setConnector)
  calendarAdd: (body) => addCalendar(body, {
    path: join(HOME_DIR, "config.json"), current: () => cfg.connectors.calendar,
    probe: (url) => {
      const conn = cfg.connectors.calendar;
      const tz = conn.mode === "api" && conn.cap === "calendar" ? conn.timeZone : "Asia/Seoul";
      return probeIcs(url, calendar.window(), { timeZone: tz });
    },
    apply: () => { reloadConnectors(); },
  }),
  calendarList: () => calendarListOf(join(HOME_DIR, "config.json"), calendar.state()),
  // 메일(앱 비밀번호) 계정 추가·바꾸기: 로그인해 보고 되면 저장 → 메모리도 바로(가져온 메일은 그대로 그 계정의 동기화 결과로)
  mailConnect: (body) => connectMail(body, {
    path: join(HOME_DIR, "config.json"), current: () => cfg.connectors.mail,
    apply: (conn, id, r) => {
      cfg.connectors.mail = conn;
      mailSync.accept(conn, id, r);
      console.log(`[connectors] 메일 계정 연결함(${conn.accounts.find((a) => a.id === id)?.preset ?? "?"}, ${r.items.length}통, 계정 ${conn.accounts.length}개)`); // 주소·비밀번호는 남기지 않는다
      pushStatus();
      bus.dashboardChanged();
    },
  }),
  // 메일 계정 하나 빼기: 그 계정 비밀번호·가져온 메일을 지운다. 마지막이면 메일 연결이 꺼진다
  mailRemove: (id) => removeMailAccount(id, {
    path: join(HOME_DIR, "config.json"),
    apply: (conn) => {
      cfg.connectors.mail = conn as typeof cfg.connectors.mail;
      mailSync.setConnector(conn);
      console.log(`[connectors] 메일 계정 하나 뺌(남은 계정 ${conn.mode === "imap" ? conn.accounts.length : 0}개)`);
      pushStatus();
      bus.dashboardChanged();
    },
  }),
  // [연결 해제]: 그 기능만 off(토큰·ICS 주소도 지움) → 다시 읽기 → 메모리도 바로 off
  connectorDisconnect: (cap) => disconnectConnector(cap, {
    path: join(HOME_DIR, "config.json"), cfg, reload: reloadConnectors,
    changed: () => {
      console.log(`[connectors] ${String(cap)} 연결 해제`);
      if (cap === "calendar") calendar.disable(); // 동기화·회의 알림을 바로 멈춘다
      if (cap === "mail") mailSync.disable(); // 가져온 메일도 지운다
      if (cap === "slack") try { slackIngester.transport = null; } catch { /* 아직 안 만들어졌으면 만들 때 off 를 읽는다 */ } // 다음 수집부터 안 한다
      pushStatus();
      bus.dashboardChanged();
    },
  }),
});
console.log(`[cy-agent] 버스 http://127.0.0.1:${cfg.port}`);
if (weather.place) { console.log(`[weather] 날씨 알리미 켬: ${weather.place.name}`); void weather.forecast(); } // 지역 이름만(좌표는 남기지 않는다)
// 지난 실행이 남긴 Codex 코드 작업용 임시 CODEX_HOME(인증 사본)을 지운다 — 포트를 잡은 뒤라 이 데몬 하나뿐이다
const staleCodexHomes = cleanupStaleCodexHomes();
if (staleCodexHomes.length) console.log(`[codex] 예전 임시 홈 ${staleCodexHomes.length}개 정리`);
// 캘린더는 버스가 뜨자마자 가져온다(작업 기록 읽기 등 긴 시작 일이 끝날 때까지 「연결됨」인데 일정이 빈 채로 두지 않는다)
// 일정 N분 전(설정 calendarAlert): 춤 + 말풍선(회의실·온라인 여부, 링크 버튼은 회의 링크, 없으면 캘린더 일정). 일정·분마다 한 번(DB에 남김)
const stopMail = mailSync.schedule(); // 연결돼 있으면 바로 한 번, 그다음 15분마다
const stopCalendar = asRoutine(calendar.schedule.bind(calendar))((m, text, mins) => {
  // 영상 번호는 데몬이 고른다. 그 영상에 전용 한마디가 있으면 일정 말풍선 글 대신(같은 자리표시 {mins}·{title}·{time}·{where})
  const d = bus.activity.play(8000, "plan");
  const detail = alertDetail(m);
  bus.bubble({ id: `meeting:${m.id}@${m.start}#${mins}`, text: d.say ? fillVars(d.say, alertVars(m, mins)) : text, kind: "todo", ttlMs: Math.max(60e3, Date.parse(m.start) - Date.now()), link: m.link ?? m.webLink, ...(detail ? { detail } : {}) });
}, (r) => console.log("[calendar]", JSON.stringify({ meetings: r.meetings, events: r.events, calls: r.calls, errors: r.errors, costUsd: r.costUsd, ...(r.reason ? { reason: r.reason } : {}) })));

// ── 할 일 캔버스: 데이터가 바뀔 때마다(디바운스·해시로 실제 호출은 변경 시에만)
const canvas = new TodoCanvas(store, { userId: cfg.slackUserId });
let dm: Promise<string> | undefined;
const syncCanvas = () => {
  const s = slack;
  if (!s) return;
  dm ??= openDm(s.app.client, cfg.slackUserId!).catch((e) => { dm = undefined; throw e; });
  dm.then((ch) => canvas.sync(s.app.client, ch)).catch((e) => console.warn("[canvas]", e?.data?.error ?? e?.message ?? e));
};
agent.onChange(syncCanvas);

if (slack) {
  // 토큰이 틀려도 데몬 전체가 죽지 않게: 경고만 남기고 말풍선으로 계속
  try {
    await slack.app.start();
    console.log("[cy-agent] Slack Socket Mode 연결");
    syncCanvas();
  } catch (e: any) {
    console.warn(`[cy-agent] Slack 연결 실패(${e?.data?.error ?? e?.message ?? e}) — 토큰을 확인해 주세요. 말풍선만 사용`);
    slack = undefined;
  }
} else {
  console.log("[cy-agent] Slack 토큰 없음 — 말풍선만 사용 (~/.cy-agent/config.json 참고)");
}

// ── 주기 작업
const ingest = safe("ingest", () => { const n = agent.ingest(); if (n) console.log(`[cy-agent] 세션 ${n}개 반영`); });

// 커넥터 MCP 서버(주소가 있는 http 서버만) 도달 상태 — 끊기면 말풍선으로 알리고, 다시 붙으면 바로 훑어본다
const health = new McpHealth({ urls: () => connectorServerUrls(cfg.connectors) });

// 이벤트 루프 멈춤 감시: 동기 작업이 2초 넘게 데몬을 붙잡으면(패널이 '연결 안 됨'으로 보임) 로그로 남긴다.
// 단조 시계(performance.now) 기준. 맥이 잠들면 단조 시계는 거의 안 가고 벽시계만 크게 뛴다. 그건 멈춤이 아니다(log.ts stallLag)
let tickMono = performance.now(), tickWall = Date.now();
setInterval(() => {
  const mono = performance.now(), wall = Date.now();
  const lag = stallLag(mono - tickMono, wall - tickWall);
  if (lag > 2000) console.warn(`[stall] 데몬이 ${(lag / 1000).toFixed(1)}초 멈췄어요`);
  tickMono = mono; tickWall = wall;
}, 1000).unref();
let authSkipLogged = false;
const brief = asRoutine(safe("briefing", async () => {
  if (!modelWorkAllowed(cfg)) return; // 설치 마법사를 마치기 전(정기 브리핑은 말풍선도 없이 조용히)
  // API 키가 401·403 을 받았으면 정기 브리핑은 쉰다(실패 말풍선을 매번 띄우지 않게). 키를 바꾸면 지문이 달라져 다시 돈다
  if (brainAuthFailed(cfg) || brainCreditNeeded(cfg)) {
    if (!authSkipLogged) console.warn("[briefing] API 키가 맞지 않거나 크레딧이 없어 정기 브리핑을 쉬어요. 키를 바꾸거나 대화가 한 번 되면 다시 해요");
    authSkipLogged = true;
    return;
  }
  authSkipLogged = false;
  const h = await health.check().catch(() => health.last);
  if (h.state !== "ok") console.log("[briefing] 일부 MCP 서버에 연결이 안 돼요 —", healthNote(h)); // 쓸 수 있는 출처로만 브리핑한다
  await agent.runBriefing();
})); // 정기 작업(세션 창 "정기 작업" 묶음). 패널 "지금 브리핑"(bus briefing)은 사용자 작업
// 재시작·재연결 때: 마지막 브리핑이 briefingIntervalMin 안이면 건너뛴다(재시작마다 브리핑 → 같은 할 일이 되살아나던 것)
const briefIfDue = (why: string) => {
  if (briefingDue(store.latestBriefing(), cfg.briefingIntervalMin)) return brief();
  console.log(`[briefing] ${why} — 마지막 브리핑이 ${cfg.briefingIntervalMin}분 안이라 건너뜀`);
};

// Slack 수집: 커넥터 slack 이 api(사용자 토큰 Web API)일 때만. 이전 사이클이 돌고 있으면 run()이 바로 빠진다
const slackIngester = new SlackIngester(cfg, store);
const slackTick = asRoutine(safe("slack-ingest", async () => {
  if (!modelWorkAllowed(cfg)) return; // 설치 마법사를 마치기 전
  if (!slackIngester.transport) return; // slack 연결 안 됨(off·mcp) — 브리핑·채팅이 MCP로 실시간 조회
  // 진행 보고: 20초 안에 끝나는 평소 사이클은 조용히, 오래 걸리면 시작·결과만
  const prog = reactions.progress("slack-ingest", phrase("slack_prog"), { quietMs: 20e3 });
  const c = await slackIngester.run().catch((e) => { prog.fail("슬랙 훑다가 막혔어요"); throw e; });
  prog.done(c.messages ? phrase("slack_done", { n: c.messages }) : undefined);
  console.log("[slack-ingest]", JSON.stringify(c)); // 건수·비용만
  await safe("todo-auto", () => runAfterSlackIngest(agent, cfg, store))(); // 끝난 할 일 자동 완료(모델은 15분에 한 번)
  await safe("slack-todos", () => agent.slackTodosNow())(); // 새 DM·멘션은 바로 할 일로(정기 브리핑을 기다리지 않는다)
}));

// ↻ 새로고침(패널): 슬랙을 지금 다시 훑고 → 새 DM·멘션을 할 일로 → 브리핑(메일·일정·Jira 등)도 간격 상관없이 지금.
// 새 할 일은 「할 일 추가했어요」 말풍선(reactions.newTodos)으로 뜬다. 동시에 눌러도 한 번만
let refreshing: Promise<void> | undefined;
const refreshAll = () => (refreshing ??= (async () => {
  if (!modelWorkAllowed(cfg)) { bus.bubble({ id: "refresh", text: WAIT_SETUP, kind: "info", ttlMs: 10e3 }); return; }
  bus.bubble({ id: "refresh", text: phrase("refresh_prog"), kind: "info", ttlMs: 60e3 });
  const before = new Set(store.openTodos().map((t) => t.id));
  await slackTick();
  await agent.runBriefing();
  if (!store.openTodos().some((t) => !before.has(t.id))) bus.bubble({ id: "refresh", text: phrase("refresh_none"), kind: "info", ttlMs: 6e3 });
})().finally(() => { refreshing = undefined; }));

// 프로필 학습: 동시에 두 번 돌지 않게. 새 근거가 없으면 모델을 부르지 않는다
let learning: Promise<unknown> | undefined;
const learn = (rounds = 1) => asRoutine(safe("profile", async () => {
  if (learning || !modelWorkAllowed(cfg)) return;
  const prog = reactions.progress("profile", phrase("profile_prog"), { quietMs: 15e3 });
  learning = (async () => {
    let added = 0;
    for (let i = 0; i < rounds; i++) {
      const r = (await learnFrom(cfg, store)) as any;
      added += Number(r.added) || 0;
      if (!r.evidence) break;
    }
    prog.done(added ? phrase("profile_done", { n: added }) : undefined);
  })().catch((e) => { prog.done(); throw e; }).finally(() => { learning = undefined; });
  await learning;
}));

// 할 일 진행 확인: 작업 세션·작업 run 을 읽고 끝난 일은 자동 완료(되돌릴 수 있음), 하는 중인 일엔 어디까지 됐는지 한 줄.
// 새 세션·run 이 없으면 모델을 안 부른다. 시작 3분 뒤 한 번, 그다음 progressCheckMin 마다(0 이면 끔)
const progressTick = asRoutine(safe("todo-progress", async () => {
  if (!modelWorkAllowed(cfg)) return;
  agent.ingest(); // 방금 끝난 세션까지
  await checkProgress(cfg, store, agent);
}));
if ((cfg.progressCheckMin ?? 5) > 0) {
  setTimeout(progressTick, 3 * 60e3).unref();
  setInterval(progressTick, (cfg.progressCheckMin ?? 5) * 60e3).unref();
}

// 확인 카드: 30분 지난 대기는 만료(카드·Slack·말풍선이 바뀐다)
setInterval(safe("actions-expire", () => agent.expireActions()), 60e3).unref();

// 휴지통에 30일 넘게 있던 할 일은 영구 삭제(시작할 때 + 하루 한 번)
const purgeTrash = safe("trash", () => { const n = agent.purgeOldTrash(); if (n) console.log(`[cy-agent] 휴지통 오래된 할 일 ${n}개 영구 삭제`); });
await purgeTrash();
setInterval(purgeTrash, 24 * 60 * 60e3).unref();

await ingest();
bus.bubble({ text: phraseVoice("hello", {}, `hello:${new Date().toISOString().slice(0, 10)}`, { mood: "excited" }), kind: "info", ttlMs: 8e3 });
setInterval(ingest, cfg.ingestIntervalMin * 60e3);
await health.check().catch(() => {}); // 첫 Slack 수집 전에 연결 상태부터
slackTick();
setInterval(slackTick, cfg.slackIngestIntervalMin * 60e3);
learn(5)(); // 시작 시 밀린 근거 조금 따라잡기
setInterval(learn(), 60 * 60e3);

// 지식그래프: 매시간 새 청크만 haiku 추출 → 영향받은 엔티티만 sonnet 다듬기(Slack 원문은 정기 수집이 채운다)
const kgBackfill = new KgBackfill(cfg, store);
kgStatus = () => kgBackfill.status();
let kgBusy = false;
const kgHourly = asRoutine(safe("kg-hourly", async () => {
  if (kgBusy || !modelWorkAllowed(cfg)) return;
  kgBusy = true;
  try {
    await withRun({ kind: "kg", title: "지식그래프 갱신" }, async () => {
      const inc = await kgBackfill.incremental({ budgetUsd: 1 });
      const ref = await refineIncremental(cfg, store, { budgetUsd: 0.5 });
      console.log("[kg-hourly]", JSON.stringify({ chunks: inc.chunks, extractUsd: inc.costUsd, refineUsd: ref.costUsd, stopped: ref.stopped }));
    });
  } finally { kgBusy = false; }
}));
setInterval(kgHourly, 60 * 60e3);

// 연결 상태가 바뀔 때만 한 번씩 알린다. 다시 연결되면 바로 훑어본다
let mcpState = "ok";
const healthTick = asRoutine(safe("mcp-health", async () => {
  const h = await health.check();
  const g = h.state;
  if (g === mcpState) return;
  const prev = mcpState;
  mcpState = g;
  console.log("[mcp-health]", JSON.stringify(h.servers));
  if (g !== "ok") {
    bus.bubble({ id: "mcp-health", text: healthNote(h) ?? "MCP 서버에 연결이 안 돼요. 잠시 뒤에 다시 볼게요", kind: "error", ttlMs: 30e3 });
  } else if (prev !== "ok") {
    bus.bubble({ id: "mcp-health", text: phrase("mcp_back"), kind: "info", ttlMs: 10e3 });
    slackTick();
    briefIfDue("다시 연결됨");
  }
}));
healthTick();
setInterval(healthTick, 2 * 60e3);
// 평일 업무시간(이 맥의 시간대로 9~19시)에만 정기 브리핑
setInterval(() => { if (briefingHours(new Date())) brief(); }, cfg.briefingIntervalMin * 60e3);
setTimeout(() => briefIfDue("시작"), 5e3);

// 설치 마법사를 막 마쳤을 때(PUT /settings onboarded: true): 시작할 때 하던 첫 정리를 지금 한 번
function onboardedNow() {
  console.log(`[onboarding] 설치 마법사를 마침: 작업 기록 ${sessionsAllowed(cfg) ? "읽기 켬" : "읽기 끔"} · 레포 폴더 ${cfg.repoRoots.length}개 · 뇌 ${cfg.brain.provider}`);
  void ingest();
  slackTick();
  learn(5)();
  briefIfDue("설치 마법사를 마침");
  if (calendar.enabled) calendar.sync().catch(() => {});
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  bus.stopping = true; // GET /status stopping: true — 새로 뜬 앱이 이 데몬이 곧 사라질 걸 안다
  stopCalendar();
  stopMail();
  try { focus.checkpoint(); } catch { /* 꺼지는 중 */ }
  await canvas.flush().catch(() => {});
  bus.close();
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown());
// Windows 는 SIGTERM 을 보내면(child.kill) 핸들러 없이 바로 죽는다 — 앱이 IPC 로 띄웠으면 "shutdown" 메시지·연결 끊김으로 깔끔히 끈다
if (process.platform === "win32" && process.send) {
  process.on("message", (m) => { if (m === "shutdown" || (m as { type?: unknown } | null)?.type === "shutdown") void shutdown(); });
  process.on("disconnect", () => void shutdown());
}
