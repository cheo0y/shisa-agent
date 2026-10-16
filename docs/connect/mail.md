# 메일 연결

메일은 로컬에 따로 모아 두지 않습니다. 브리핑이나 더블클릭 채팅 때 모델이 매핑된 읽기 도구(`search`·`read`)로 그때그때 "최근 24시간 동안 받은 메일 중 답장이나 조치가 필요한 것"을 봅니다.

| 모드 | 어떻게 읽나 |
|---|---|
| `api` | Gmail API를 구글 로그인(OAuth, `gmail.readonly` 스코프)으로 직접 읽습니다. 채팅의 cy 도구 `mail_search`·`mail_get`(Claude Code 뇌일 때). 브리핑에는 아직 안 들어갑니다 |
| `mcp` | Claude Code에 등록한 메일 MCP 서버(Claude Code 뇌일 때만 읽힙니다) |
| `off` | 브리핑에서 메일 단계가 빠집니다(기본) |

발송·삭제·라벨 변경 같은 쓰기 도구는 서버에 있어도 쓰이지 않습니다. 허용 목록에는 매핑한 읽기 도구만 들어가고, 쓰기 이름은 훅이 막습니다(`agent/src/guard.ts`).

## (a) api 모드: 설정 창에서 Gmail로 연결

MCP 서버 없이 시사 데몬이 Gmail API를 직접 읽습니다. 읽기 전용이라 스코프는 `https://www.googleapis.com/auth/gmail.readonly` 하나뿐이고, 발송·삭제·라벨 바꾸기는 하지 않습니다. 캘린더(ICS 주소)와는 따로 연결합니다.

1. [Google Cloud Console](https://console.cloud.google.com/) → 프로젝트 만들기 → **Gmail API** 사용 설정
2. OAuth 동의 화면 → 테스트 사용자에 내 이메일 추가
3. 사용자 인증 정보 → OAuth 클라이언트 ID 만들기 → 유형 **데스크톱 앱** → 클라이언트 ID와 보안 비밀을 복사합니다.
4. 설정 창 「연결 상태」 → 메일 줄의 **Gmail로 연결** → 클라이언트 ID·보안 비밀을 넣고 **연결** → 브라우저에서 계정을 고르고 허용합니다.

허용하면 토큰은 `~/.cy-agent/gmail-token.json`(권한 600)에 저장되고, `config.json`은 아래처럼 바뀝니다. 환경변수 `CY_AGENT_GOOGLE_CLIENT_ID`·`CY_AGENT_GOOGLE_CLIENT_SECRET`로 줘도 됩니다.

```json
{ "connectors": { "mail": { "mode": "api", "clientId": "….apps.googleusercontent.com", "clientSecret": "…" } } }
```

- 메일 줄의 **연결 해제**를 누르면 설정과 토큰 파일을 같이 지웁니다. 구글 쪽 권한은 Google 계정 → 보안 → 서드파티 액세스에서 뺄 수 있습니다.
- OAuth 앱이 "테스트" 상태면 토큰이 7일마다 만료될 수 있습니다. 그러면 **Gmail로 연결**을 다시 누르세요.

## (b) mcp 모드

### 프리셋 `gmail`: [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server)

> 이 저장소는 2025년 8월부터 보관(archived) 상태라 더 이상 고쳐지지 않습니다(2026-10 확인). 오래 쓰실 거라면 다른 Gmail MCP를 아래 "직접 채우기"로 붙이는 편이 낫습니다.

1. [Google Cloud Console](https://console.cloud.google.com/) → 프로젝트 만들기 → **Gmail API** 사용 설정
2. OAuth 동의 화면 → 테스트 사용자에 내 이메일 추가
3. API 및 서비스 → 사용자 인증 정보 → OAuth 클라이언트 ID 만들기 → 유형 **데스크톱 앱**(또는 웹 애플리케이션 + 리디렉션 URI `http://localhost:3000/oauth2callback`) → JSON 내려받기
4. 파일 이름을 `gcp-oauth.keys.json`으로 바꿔 `~/.gmail-mcp/`에 둡니다.
   ```bash
   mkdir -p ~/.gmail-mcp && mv ~/Downloads/client_secret_*.json ~/.gmail-mcp/gcp-oauth.keys.json
   ```
5. 인증합니다(브라우저가 열리고, 토큰은 `~/.gmail-mcp/`에 저장됩니다).
   ```bash
   npx @gongrzhe/server-gmail-autoauth-mcp auth
   ```
6. 등록:
   ```bash
   claude mcp add --scope user --transport stdio gmail -- npx -y @gongrzhe/server-gmail-autoauth-mcp
   ```
7. 설정:
   ```json
   { "connectors": { "mail": { "mode": "mcp", "preset": "gmail" } } }
   ```

매핑: `search` → `search_emails`, `read` → `read_email`.

### 프리셋 `ms-365`: [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server)

캘린더와 같은 서버를 함께 쓸 수 있습니다([calendar.md](calendar.md#프리셋-ms-365-softeriams-365-mcp-server)). 이미 등록했다면 1·2단계는 건너뛰세요.

```bash
npx -y @softeria/ms-365-mcp-server --login
claude mcp add --scope user --transport stdio ms365 -- npx -y @softeria/ms-365-mcp-server --read-only
# 회사·학교 계정이면 두 명령 끝에 --org-mode
```

```json
{ "connectors": { "mail": { "mode": "mcp", "preset": "ms-365" } } }
```

매핑: `search` → `list-mail-messages`, `read` → `get-mail-message`(출처: 저장소 `src/endpoints.json`).

### 다른 메일 MCP: 직접 채우기

```json
{ "connectors": { "mail": { "mode": "mcp", "server": "<등록한 이름>", "tools": { "search": "<메일 검색/목록 도구>", "read": "<메일 하나 읽기 도구>" } } } }
```

`tools`를 비우면 서버 전체가 허용되고, 가드가 읽기 이름(get·list·search·read …)만 통과시킵니다.
