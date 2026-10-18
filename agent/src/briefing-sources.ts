// 정기 브리핑이 보는 바깥 출처(메일·일정·Slack·이슈)와 그 연결 상태.
//
// 출처는 커넥터(connectors.ts)가 정한다 — 기능마다 api(우리 코드가 직접: Slack 사용자 토큰·ICS) · mcp(사용자가 등록한 MCP 서버) · off.
//   1) 연결된 기능만 브리핑 지시에 넣는다. mcp 로 설정했지만 Claude Code 에 서버가 등록돼 있지 않으면(ready 에 없음)
//      「찾지 말고 건너뛰어라」로 — 모델이 없는 도구를 찾아다니지 않게.
//   2) 진행 말풍선은 그 출처의 **데이터 호출**(단계 글 "서버.도구" — brain.ts stepName)이 **성공해서 돌아왔을 때만**.
//      ToolSearch·맥락 도구(cy.*)·코드 읽기는 아무 말풍선도 안 띄운다.
//   3) 연결돼 있어도 그 호출이 실패하면(오류 결과·미연결 응답) 말풍선을 띄우지 않는다.
import { CAP_LABELS, CAPABILITIES, CONNECTORS, mcpTool, type Capability, type Connectors } from "./connectors.ts";
import { hasUserMcpServer } from "./mcp.ts";

export type SourceId = Capability;
const BUBBLE: Record<SourceId, string> = {
  slack: "슬랙 보는 중이에요…",
  mail: "메일 확인하는 중이에요…",
  calendar: "오늘 일정 보는 중이에요…",
  issues: "이슈 보는 중이에요…",
};
// 같은 서버를 여러 기능이 같이 쓰면(예: ms365 = 메일·일정) 도구 이름으로 가른다
const TOOL_HINT: Record<SourceId, RegExp> = {
  slack: /./,
  mail: /mail|message|inbox|email/i,
  calendar: /calendar|event|meeting|schedule/i,
  issues: /issue|pull|pr|search|list|read|me/i,
};

// 단계 글이 어느 출처의 데이터 호출인가. "서버.도구" 모양만(mcp__…·ToolSearch·cy.*·code.* 는 아님)
export function sourceOf(step: string, c: Connectors = CONNECTORS): { id: SourceId; bubble: string } | undefined {
  const m = /^([\w-]+)\.([\w.-]+)/.exec(step.trim());
  if (!m || m[1].startsWith("mcp__") || m[1] === "cy" || m[1] === "code" || m[1] === "gh") return undefined;
  const [, svc, tool] = m;
  const caps = CAPABILITIES.filter((cap) => { const x = c[cap]; return x.mode === "mcp" && x.server.toLowerCase() === svc.toLowerCase(); });
  const id = caps.length > 1 ? caps.find((cap) => TOOL_HINT[cap].test(tool)) : caps[0];
  return id ? { id, bubble: BUBBLE[id] } : undefined;
}

// 실제로 쓸 수 있는 기능: api 는 비밀값이 있을 때, mcp 는 서버가 Claude Code 에 등록돼 있을 때
export function readySources(c: Connectors = CONNECTORS, has: (server: string) => boolean = hasUserMcpServer): Set<SourceId> {
  const out = new Set<SourceId>();
  for (const cap of CAPABILITIES) {
    const x = c[cap];
    if (x.mode === "mcp" ? has(x.server) : x.mode === "api" ? (x.cap === "slack" ? !!x.userToken : x.cap === "calendar" ? x.calendars.some((e) => e.enabled) : false) : x.mode === "imap" ? x.accounts.some((a) => !!a.password) : false) out.add(cap);
  }
  return out;
}

// 진행 말풍선 글: 데이터 호출이 성공해서 돌아왔을 때만, 그 출처가 쓸 수 있을 때만(ready 가 null 이면 모른다 — 있다고 본다). 아니면 null
export function briefingMilestone(step: string, ok: boolean, c: Connectors = CONNECTORS, ready: ReadonlySet<SourceId> | null = null): string | null {
  if (!ok) return null;
  const src = sourceOf(step, c);
  if (!src) return null;
  if (ready && !ready.has(src.id)) return null;
  return src.bubble;
}

// 도구 결과가 실패인가: SDK 의 is_error, 또는 서버가 글로 돌려준 미연결·권한·오류 응답(앞부분만 본다)
export function failedResult(isError: boolean | undefined, text: string): boolean {
  if (isError) return true;
  const head = text.slice(0, 400);
  return /^\s*\{?\s*"?(error|isError)"?\s*[:=]\s*(true|"|\{)/i.test(head)
    || /(not connected|isn't connected|is not connected|연결되지 않|미연결|연결이 필요|unauthori[sz]ed|forbidden|권한이 없)/i.test(head);
}

export const BRIEFING_HEAD = "정기 브리핑.";
// 같은 일을 새 key 로 다시 올려 휴지통에 넣은 일이 되살아나던 것 — 데몬도 결정적으로 막지만(store.ts upsertTodo) 모델에게도 분명히
export const TODO_KEY_RULE = "todos 의 key: 위 \"현재 열린 할 일\"·\"백로그\"와 같은 일이면 그 id 를 key 로 그대로 쓴다(새 key·비슷한 제목으로 하나 더 만들지 않는다). \"최근 끝낸 할 일\"·\"지우거나 끝낸 할 일\"(할 일 일지)에 있는 일은 key·제목을 바꿔서라도 다시 올리지 않는다 — 사용자가 지웠거나 끝낸 것이다. 새로 생긴 일만 새 key 로.";

// 재시작마다 바로 브리핑하지 않게: 마지막 브리핑(저장된 at)이 intervalMin 안이면 아직 아니다
export function briefingDue(last: { at: string } | null | undefined, intervalMin: number, now = Date.now()): boolean {
  const at = last ? Date.parse(last.at) : NaN;
  return !Number.isFinite(at) || now - at >= intervalMin * 60e3;
}

// 브리핑 지시 한 줄의 앞머리(settings.ts excludeBriefingSources 가 이걸로 출처를 알아본다)
export const STEP_HEAD: Record<SourceId | "sessions", string> = {
  calendar: "캘린더:", mail: "메일:", slack: "slack:", issues: "이슈:", sessions: "위 최근 세션",
};

// 정기 브리핑 지시. 연결된 기능만 번호를 매긴다. ready: 실제로 쓸 수 있는 기능(null = 모름 — 설정된 건 다 시킨다)
export function briefingTask(c: Connectors | null = CONNECTORS, ready: ReadonlySet<SourceId> | null = null): string {
  const conns = c ?? CONNECTORS;
  const steps: string[] = [];
  const skipped: string[] = [];
  const tool = (x: { server: string; tools: Record<string, string> }, ...roles: string[]) =>
    roles.map((r) => x.tools[r]).filter(Boolean).map((t) => mcpTool(x.server, t)).join(", ") || mcpTool(x.server, "*");
  const usable = (cap: SourceId) => {
    if (conns[cap].mode === "off") return false;
    if (ready && !ready.has(cap) && conns[cap].mode === "mcp") { skipped.push(CAP_LABELS[cap]); return false; }
    return true;
  };
  const cal = conns.calendar, mail = conns.mail, slack = conns.slack, issues = conns.issues;
  if (usable("calendar")) {
    if (cal.mode === "mcp") steps.push(`${STEP_HEAD.calendar} 오늘·내일 일정(${tool(cal, "listEvents")})`);
    else steps.push(`${STEP_HEAD.calendar} 위 "오늘·내일 일정"(로컬 캐시)에서 준비가 필요한 회의`);
  }
  if (usable("mail") && mail.mode === "mcp") steps.push(`${STEP_HEAD.mail} 최근 24시간 받은 메일 중 답장/조치가 필요한 것(${tool(mail, "search", "read")})`);
  else if (usable("mail") && mail.mode === "imap") steps.push(`${STEP_HEAD.mail} 위 "최근 받은 메일"(데몬이 받은편지함에서 읽기 전용으로 가져온 것 — 메일 도구는 없다)에서 답장이나 조치가 필요한 것만 할 일로. 광고·뉴스레터·자동 알림(「광고·뉴스레터·자동 발송으로 보임」·noreply 보낸 사람·단순 공지)은 뺀다. source 는 "mail", source_ref 는 그 줄의 ref, link 는 그 줄의 링크(있으면)`);
  if (usable("slack")) {
    if (slack.mode === "api") steps.push(`${STEP_HEAD.slack} 위 "아직 답 안 한 Slack DM·멘션" 확정 목록(로컬 수집)만 기준으로 한다 — 실시간 Slack 도구는 없다`);
    else if (slack.mode === "mcp") steps.push(`${STEP_HEAD.slack} 위 "아직 답 안 한 Slack DM·멘션" 확정 목록이 있으면 그걸 기준으로 하고, 없을 때만 최근 24시간 나를 멘션한 메시지·DM 중 답 안 한 것(${tool(slack, "search", "history", "replies")})`);
  }
  if (usable("issues") && issues.mode === "mcp") steps.push(`${STEP_HEAD.issues} 나에게 할당된 열린 이슈·리뷰 요청(${tool(issues, "search", "list", "searchPrs")})`);
  steps.push(`${STEP_HEAD.sessions} 맥락: 하다 만 작업, 세션에서 미뤄둔 것`);
  steps.push("오늘 할 일(= 우선순위 1 오늘 꼭)이 비어 있고 오늘 안에 꼭 해야 하는 회의 준비·할 일이 있으면 plan_ops로 채워도 된다(서버에 올리지 않는 로컬)");
  const skip = skipped.length
    ? `\n${skipped.join("·")}는 MCP 서버가 연결돼 있지 않다 — 찾거나(도구 목록 검색 포함) 부르지 말고 건너뛴다. reply_md 에도 언급하지 않는다.`
    : "";
  return `${BRIEFING_HEAD} 다음을 확인해서 사용자가 지금 챙겨야 할 것을 정리해:
${steps.map((s, i) => `${i + 1}) ${s}`).join("\n")}${skip}
기존 할 일 중 끝난 게 확인되면 done_todo_ids에 넣어.
${TODO_KEY_RULE}
reply_md는 우선순위별로 묶고 각 항목에 링크를 달아.
우선순위: 1=오늘 꼭, 2=이번 주, 3=참고(곧 볼 것), 4=언젠가·백로그. 1(오늘 꼭)은 그대로 사용자의 「오늘 할 일」 목록이 된다. 오늘 안에 해야 하는 것(오늘 마감·오늘 회의 전 준비·오늘 답해야 하는 요청)만 1로 넣고, 급해 보여도 오늘 꼭이 아니면 2로 넣어. 기한이 딱히 없고 중요도도 낮은 것(언젠가 해도 되는 정리·아이디어·참석 여부만 정하면 되는 공지성 행사 등)은 3이 아니라 4로 넣어. 4는 reply_md에서 강조하지 말고 맨 끝에 한 줄로만.
위 "할 일 규칙"이 있으면 새 할 일에 그대로 따른다(데몬도 다시 적용한다).`;
}
