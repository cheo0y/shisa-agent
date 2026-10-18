# 캘린더 연결

캘린더는 일정 알림(기본 10분 전에 캐릭터가 춤추면서 알려 줍니다. 설정 창 「일정 알림」에서 5·10·15·30분이나 직접 적은 분으로, 여러 번으로 바꾸거나 끌 수 있습니다)과 브리핑의 "오늘·내일 일정"에 쓰입니다. 30분마다 오늘·내일 일정을 다시 가져와 `~/.cy-agent/cy.db`에 둡니다.

| 모드 | 어떻게 읽나 | 추천 |
|---|---|---|
| `api` | 캘린더의 비공개 ICS 주소를 코드가 직접 읽습니다. MCP·OAuth·모델 없음, 비용 0 | **추천** |
| `mcp` | Claude Code에 등록한 캘린더 MCP(Claude Code 필요). 경량 모델이 일정 목록 도구를 한 번 부르고 결과를 정해진 모양으로 옮깁니다(동기화마다 약간의 비용) | ICS를 못 쓸 때 |
| `off` | 일정 알림 없음 | |

---

## (a) 추천: api 모드, 비공개 ICS 주소

> **ICS 주소는 비밀번호와 같습니다.** 주소만 있으면 누구든 일정 전체(제목·참석자·설명)를 볼 수 있습니다. 채팅·이슈·레포에 붙이지 말고 `~/.cy-agent/config.json`(권한 600)에만 두세요. 실수로 노출했다면 아래 "재설정"으로 새 주소를 만드세요.

### Google 캘린더: "iCal 형식의 비공개 주소"

출처: [Google 캘린더 고객센터: 다른 캘린더 애플리케이션과 공유](https://support.google.com/calendar/answer/37648?hl=ko) (2026-10 확인)

1. 컴퓨터 브라우저에서 Google Calendar를 엽니다(앱이 아니라 웹).
2. 오른쪽 위 톱니바퀴 → **설정**
3. 왼쪽 **내 캘린더의 설정** 아래에서 읽어 올 캘린더(보통 내 이름)를 클릭
4. **캘린더 통합**으로 내려갑니다.
5. **iCal 형식의 비공개 주소** 칸의 복사 버튼을 누르면 `https://calendar.google.com/calendar/ical/…/private-…/basic.ics` 꼴의 주소가 복사됩니다.
6. 노출됐다면 같은 칸의 **재설정**으로 새 주소를 만듭니다(예전 주소는 끊깁니다).

회사·학교 Google 계정은 관리자가 공유 설정을 바꿔 둬서 이 칸이 안 보일 수 있습니다. 그럴 때는 관리자에게 문의하거나 (b) mcp 모드를 쓰세요.

### Outlook(Microsoft 365 · Outlook.com): 캘린더 게시

출처: [Microsoft 지원: 웹용 Outlook에서 일정 공유](https://support.microsoft.com/ko-kr/office/7ecef8ae-139c-40d9-bae2-a23977ee58d5) (2026-10 확인). 한국어 UI에서는 Calendar가 "일정"으로 나옵니다.

1. 웹용 Outlook(outlook.office.com 또는 outlook.live.com) → 왼쪽 **일정**
2. 오른쪽 위 톱니바퀴(**설정**) → **일정** → **공유 일정**
3. **일정 게시** 아래에서 캘린더(보통 "일정")를 고르고, 공개 수준은 **모든 세부 정보 볼 수 있음**(영문 UI "Can view all details")으로 고릅니다.
   - "다른 용무 중일 때만 볼 수 있음"으로 게시하면 제목이 빠지고 "바쁨"만 보입니다. 회의 알림 자체는 오지만 제목과 회의 링크가 없습니다.
4. **게시**를 누르면 아래에 HTML 링크와 **ICS 링크**가 생깁니다. **ICS 링크**를 복사하세요.
5. 노출됐다면 같은 화면에서 **게시 취소** 후 다시 게시하면 새 주소가 나옵니다.

- 클래식 웹용 Outlook은 설정 → 일정 → **일정 게시** 경로이고, 고른 뒤 **저장**을 누릅니다.
- 정확한 메뉴 이름(특히 공개 수준 항목 이름)은 Microsoft 문서에 다 나와 있지 않아서 실제 화면과 조금 다를 수 있습니다.
- 회사 계정은 관리자가 외부 게시를 막아 둔 경우가 많습니다(게시 메뉴가 없거나 "조직 내부만"으로만 됩니다). 그럴 때는 (b)의 `ms-365` 프리셋을 쓰세요.

### 설정

**설치 마법사로 하기(쉬움)**: 패널 「설치」 → 「더 연결하기」 → 「구글 캘린더」 또는 「Outlook 캘린더」를 누르고 안내를 따라 주소를 복사합니다. 마지막 화면의 **＋ 캘린더 추가**에 별칭(예: 회사, 개인, 가족)과 복사한 주소를 넣고 **연결**을 누르면, 시사가 그 캘린더를 한 번 읽어 보고 되면 `connectors.calendar`에 저장한 뒤 바로 일정을 가져옵니다. 못 읽으면 저장하지 않고 이유(예: 「공개 주소」를 넣었어요)를 보여 줍니다. 데몬을 다시 켤 필요는 없습니다. 시사가 꺼져 있으면 확인할 수 없어서 연결하지 않습니다.

**캘린더 여러 개**: 캘린더는 몇 개든 더할 수 있습니다. 연결한 뒤에도 **＋ 캘린더 추가**가 남아 있어서 계속 더할 수 있고, 이미 붙인 주소는 「이미 연결된 캘린더예요」로 막습니다. 별칭은 비워도 됩니다. 비우면 캘린더 이름(ICS 의 `X-WR-CALNAME`)을, 그것도 없으면 「캘린더 N」을 별칭으로 씁니다.

목록에는 줄마다 별칭, 주소 대신 캘린더 id 앞부분과 도메인(예: `gild…@gmail.com`), 오늘·내일 일정 수나 못 가져온 이유가 보입니다. 줄마다 다음을 할 수 있습니다.

- **켜짐** 체크를 끄면 그 캘린더는 저장은 그대로 두고 가져오지 않습니다. 그 캘린더 일정은 바로 일정 알림·AI 맥락·「일정에서 가져오기」에서 빠지고, 다시 켜면 바로 다시 가져옵니다. 연결 상태 줄에는 「꺼 둠」으로 보입니다.
- **✎**로 별칭을 고칩니다.
- **빼기**로 그 캘린더만 뺍니다. 마지막 하나를 빼면 캘린더 **연결 해제**와 같습니다.

이 목록은 시사 설정 파일에 저장된 값을 그대로 읽습니다. 그래서 목록으로 돌아갔다가 다시 들어오거나, 설정 창 「연결 상태」의 캘린더 줄 아래에서 봐도 같은 목록이 보입니다. 「더 연결할까요?」의 캘린더 카드에는 「저장됨 · 캘린더 N개」가 붙습니다.

별칭은 연결 상태 줄(「회사: 일정 5개 / 개인: 못 가져옴」), 일정 알림 말풍선(「· 🗓 회사」), AI 맥락, 「일정에서 가져오기」 목록에 쓰입니다. 캘린더 하나가 못 가져와도 다른 캘린더 일정은 새로 가져오고, 못 가져온 캘린더 일정은 예전 것을 둡니다. 여러 캘린더에 같은 일정이 들어 있어도(같은 UID·시작 시각) 회의 알림은 한 번만 울립니다.

**직접 넣기**:

```json
{
  "connectors": {
    "calendar": {
      "mode": "api",
      "calendars": [
        { "name": "회사", "url": "https://calendar.google.com/calendar/ical/.../basic.ics" },
        { "name": "개인", "url": "https://outlook.office365.com/owa/calendar/.../calendar.ics", "enabled": false }
      ],
      "timeZone": "Asia/Seoul",
      "email": "gildong@example.com"
    }
  }
}
```

| 키 | 설명 |
|---|---|
| `calendars` | 캘린더마다 `{ id?, name, url, enabled? }`. `name` 은 별칭, `url` 은 비공개 ICS 주소(`webcal://`도 됩니다. https로 바꿔 읽음), `enabled: false` 면 저장만 두고 가져오지 않습니다(기본 켜짐). `id` 는 비워 두면 주소로 만듭니다 |
| `icsUrl` / `icsUrls` | 예전 모양(주소 하나 또는 배열, 별칭 없음). 그대로 읽히고, 화면에서 고치면 `calendars` 로 옮겨 씁니다 |
| `timeZone` | 떠 있는 시각(시간대 없는 일정) 해석과 하루 경계에 씁니다. 기본 `Asia/Seoul` |
| `email` | 내 캘린더 이메일. 있으면 참석자 목록에서 내 응답(수락·거절·미정)과 주최자 여부를 보고, 거절한 회의는 알리지 않습니다. 비워 두면 전부 "응답 없음"으로 치고 알립니다 |

환경변수 `CY_AGENT_CALENDAR_ICS_URL`(공백으로 여러 개)을 주면 파일의 주소 대신 그 값을 씁니다(별칭 없이, 모두 켜짐).

주소는 비밀번호와 같아서 설정 응답·데몬 로그·「도움 보내기」에는 넣지 않습니다. 화면과 `GET /connectors/calendar`에도 id·별칭·결과만 나갑니다.

### 확인

```bash
./ops/install.sh     # 또는: launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon
grep -E '\[connectors\] 캘린더|\[calendar\]' ~/.cy-agent/logs/com.cy-agent.daemon.log | tail
# [connectors] 캘린더: api · ICS 캘린더 1개
# [calendar] {"meetings":3,"events":4,"calls":1,"errors":0,"costUsd":0}
# [calendar] ICS 실패: ICS HTTP 404      ← 주소가 틀렸거나 재설정됨 (주소 자체는 로그에 남기지 않음)
```

주소가 맞는지 직접 보려면 아래처럼 확인할 수 있습니다(터미널 기록에 남으니 끝나면 지워도 좋습니다).

```bash
curl -s "<ICS 주소>" | head -3      # BEGIN:VCALENDAR 로 시작하면 정상
```

### ICS 모드가 다루는 것과 안 다루는 것 (`agent/src/ics.ts`)

- **다룸**: 줄 접기·이스케이프, TZID(IANA 이름·Windows 시간대 이름·VTIMEZONE 고정 오프셋), UTC·떠 있는 시각, 종일 일정, 반복 일정 기본(RRULE의 FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY(서수 포함), BYMONTHDAY, BYMONTH), EXDATE, 바뀌거나 취소된 회차(RECURRENCE-ID), 취소(STATUS:CANCELLED), 한가함 표시(TRANSP:TRANSPARENT), 참석자 응답(PARTSTAT), 회의 링크(Meet·Zoom·Teams)
- **안 다룸**: RDATE, BYSETPOS, BYWEEKNO·BYYEARDAY, VTIMEZONE의 서머타임 규칙(IANA 이름으로 바꿀 수 없는 시간대는 표준시 오프셋 하나로 봅니다)
- 게시 주소는 Google·Microsoft 쪽 캐시 때문에 바뀐 내용이 몇 분에서 몇 시간까지 늦게 반영될 수 있습니다. 방금 잡은 회의는 알림이 늦을 수 있습니다.

---

## (b) mcp 모드: 캘린더 MCP 서버

경량 모델이 매핑된 `listEvents` 도구 하나만 부르고, 결과를 시사의 일정 모양으로 옮깁니다(다른 도구는 훅이 막습니다). 동기화(30분)마다 작은 모델 비용이 듭니다.

### 프리셋 `google-calendar`: [nspady/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp) (npm `@cocal/google-calendar-mcp`)

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 만들고 **Google Calendar API**를 사용 설정합니다.
2. OAuth 동의 화면(대상) → 테스트 사용자에 내 이메일 추가
3. 사용자 인증 정보 → OAuth 클라이언트 ID 만들기. 애플리케이션 유형은 꼭 **데스크톱 앱**으로 고릅니다(README에서도 따로 강조합니다). JSON을 내려받아 예를 들어 `~/.config/google-calendar-mcp/gcp-oauth.keys.json`에 둡니다.
4. 인증:
   ```bash
   GOOGLE_OAUTH_CREDENTIALS=~/.config/google-calendar-mcp/gcp-oauth.keys.json npx -y @cocal/google-calendar-mcp auth
   ```
5. 등록:
   ```bash
   claude mcp add --scope user -e GOOGLE_OAUTH_CREDENTIALS=$HOME/.config/google-calendar-mcp/gcp-oauth.keys.json \
     --transport stdio google-calendar -- npx -y @cocal/google-calendar-mcp
   ```
6. 설정:
   ```json
   { "connectors": { "calendar": { "mode": "mcp", "preset": "google-calendar" } } }
   ```

매핑: `listEvents` → `list-events`, `search` → `search-events`.
주의: OAuth 앱이 "테스트" 상태면 **토큰이 7일마다 만료**됩니다(README). 만료되면 4번을 다시 하면 됩니다.

### 프리셋 `ms-365`: [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server)

```bash
npx -y @softeria/ms-365-mcp-server --login        # 터미널에 뜨는 URL·코드로 로그인
claude mcp add --scope user --transport stdio ms365 -- npx -y @softeria/ms-365-mcp-server --read-only
```

- 회사·학교(Entra ID) 계정이라면 두 명령 모두 끝에 `--org-mode`를 붙입니다(README: "조직 모드는 처음부터 켜야 한다"). 테넌트 정책에 따라 관리자 동의가 필요할 수 있습니다.
- `--read-only`는 쓰기 도구를 아예 끕니다.

```json
{ "connectors": { "calendar": { "mode": "mcp", "preset": "ms-365" } } }
```

매핑: `listEvents` → `get-calendar-view`(출처: 저장소 `src/endpoints.json`). 같은 서버를 메일에도 쓸 수 있습니다([mail.md](mail.md)).

### 다른 캘린더 MCP: 직접 채우기

```json
{ "connectors": { "calendar": { "mode": "mcp", "server": "<등록한 이름>", "tools": { "listEvents": "<기간으로 일정 목록을 주는 도구>" } } } }
```

`listEvents`가 없으면 동기화가 실패로 끝납니다(쓰기처럼 보이는 이름도 거부합니다). `/mcp`에서 도구 이름을 확인해 적어 주세요.
