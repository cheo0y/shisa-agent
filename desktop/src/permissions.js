// 도구 권한 규칙([항상 허용]으로 저장한 것) — 순수 로직. 패널 개요의 "권한" 칸이 쓴다.
import { t as tr } from './i18n.js';
const ID = /^[\w-]{1,64}$/;
const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');

export const okRuleId = (id) => typeof id === 'string' && ID.test(id);

// 데몬 GET /permissions 의 rules → 화면 줄. 잘못된 건 버림
export function normalizePermissionRules(list) {
  return (Array.isArray(list) ? list : []).filter((r) => r && okRuleId(r.id) && typeof r.tool === 'string').map((r) => ({
    id: r.id,
    tool: str(r.tool, 120),
    scope: str(r.scope, 500),
    label: str(r.label) || str(r.tool, 120),
    get kind() { return kindOf(this.tool); }, // 이름은 그때 언어로
    created: str(r.created, 40),
    lastUsed: str(r.lastUsed, 40),
    hits: Number.isInteger(r.hits) && r.hits >= 0 ? r.hits : 0,
  }));
}

// 줄 앞 표시: 연결한 도구(MCP) · 셸 · 파일 편집 · 파일 읽기 · 그 밖
export function kindOf(tool) {
  if (/^mcp__/.test(String(tool))) return { icon: '🔧', name: tr('panel.perm_mcp') };
  if (tool === 'Bash') return { icon: '🖥️', name: tr('panel.perm_bash') };
  if (tool === 'Edit') return { icon: '✏️', name: tr('panel.perm_edit') };
  if (tool === 'Read') return { icon: '📂', name: tr('panel.perm_read') };
  return { icon: '⚙️', name: tr('panel.perm_tool') };
}

// "3번 썼어요 · 마지막 10/12" 같은 보조 줄
export function ruleUsage(r) {
  if (!r.hits) return tr('panel.perm_unused');
  const d = r.lastUsed ? new Date(r.lastUsed) : null;
  const when = d && !Number.isNaN(d.getTime()) ? tr('panel.perm_last', { m: d.getMonth() + 1, d: d.getDate() }) : '';
  return tr('panel.perm_hits', { n: r.hits, when });
}

// 지우기 낙관 반영: 지우는 중인 id 를 빼고 보여준다
export function withoutPending(rules, removing) {
  return rules.filter((r) => !removing.has(r.id));
}
