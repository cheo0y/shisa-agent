// AI를 안 붙였을 때 시사가 하는 정해진 말. 버튼마다 말이 여러 개라서, 누를 때마다 돌려 가며 쓴다.
// 줄바꿈(\n)과 **굵게**는 채팅 말풍선(마크다운)에서 그대로 보인다.
// {next} {open} {done} {total} {rest} 는 그때 숫자·제목으로 바뀐다.
// 고른 캐릭터가 시사가 아니면 그 캐릭터 말(character-canned.js)이 기본이다. 사용자가 고친 말은 캐릭터와 상관없이 그대로.
import { CHARACTER_CANNED } from './character-canned.js';
import { t } from './i18n.js';

export const CANNED = [
  { id: 'today', label: '오늘 할 일 얼마나 했어요?' },
  { id: 'next', label: '다음엔 뭐 할까요?' },
  { id: 'tired', label: '힘이 안 나요' },
  { id: 'done', label: '오늘 할 일 다 끝냈어요' },
  { id: 'rest', label: '좀 쉬어도 될까요?' },
  { id: 'cheer', label: '응원해 주세요' },
  { id: 'dance', label: '춤춰 줘' },
  { id: 'hello', label: '안녕!' },
  { id: 'who', label: '넌 누구야?' },
  { id: 'what', label: '뭘 할 수 있어요?' },
  { id: 'where', label: '어디서 뭘 봐요?' },
  { id: 'ai', label: '자유롭게 대화하고 싶어요' },
];

// 줄 길이·줄 수 제한은 두지 않는다(사용자가 쓴 글은 막거나 자르지 않는다)

export const CANNED_CATALOG = [
  { key: 'today:e', button: 'today', hint: '할 일 없음', lines: [
    '오늘은 적어 둔 할 일이 **아직 없어요.**\n하나 생기면 같이 봐요.',
    '할 일이 **비어 있어~요.**\n오늘은 가볍게 시작해도 좋아요.',
    '오늘은 **조용한 날**이에요.\n할 일이 생기면 알려 줘요. (스이시~사)',
    '지금 보이는 할 일이 **없어요.**\n쉬어 가는 날도 필요해요.',
  ] },
  { key: 'today:n', button: 'today', hint: '시작 전', lines: [
    '오늘 할 일 **{total}개** 중에 끝낸 건 **아직 없어요.**\n하나만 먼저 해 봐요.',
    '남은 일이 **{open}개** 있어~요.\n가장 쉬운 것부터 시작해요.',
    '아직 시작 전이에요.\n**{next}**부터 해 볼까요? (들뜬 시사)',
    '아직 시작 전이에요.\n**하나만** 골라서 해 볼까요?',
    '할 일이 **{total}개** 기다리고 있어요.\n천천히, 하나씩 해요.',
  ] },
  { key: 'today:p', button: 'today', hint: '일부 끝냄', lines: [
    '**{total}개** 중에 **{done}개**를 끝냈어요.\n다음은 **{next}** 차례예요. (뿌듯한 시사)',
    '**{total}개** 중에 **{done}개**를 끝냈어요.\n남은 건 **{open}개**예요.',
    '벌써 **{done}개**나 했어요.\n남은 건 **{open}개**예요.',
    '좋아요, **{done}개** 끝냈어요.\n다음은 **{next}** 차례예요.',
    '좋아요, **{done}개** 끝냈어요.\n남은 건 **{open}개**예요.',
    '**잘 가고 있어~요.**\n{done}개 끝냈고, {open}개 남았어요.',
  ] },
  { key: 'today:a', button: 'today', hint: '다 끝냄', lines: [
    '오늘 할 일 **{total}개**를 모두 끝냈어요.\n정말 잘했어요. (스이시~사)',
    '**전부 끝났어요!**\n오늘은 푹 쉬어도 돼요.',
    '할 일이 하나도 안 남았어요.\n**수고했어요.**',
    '**{total}개** 모두 해냈어요.\n스스로를 칭찬해 줘요. (기쁜 시사)',
  ] },
  { key: 'next', button: 'next', hint: '다음 할 일 있을 때', lines: [
    '지금은 **{next}** 차례예요.\n작게 시작해도 괜찮아요.',
    '**{next}** 어때요?\n딱 5분만 해 봐요. (스이시~사)',
    '**{next}**부터 시작해요.\n끝나면 쉬어도 돼요.',
    '먼저 **{next}**부터 해요.\n그다음 {rest}개는 나중에 봐요.',
  ] },
  { key: 'tired', button: 'tired', hint: '', lines: [
    '괜찮아요.\n남은 것 중에 **가장 쉬운 하나**만 해 봐요.',
    '오늘은 **조금만** 해도 충분해요.\n숨 한 번 쉬고 시작해요.',
    '힘든 날도 있어~요.\n**5분만** 하고 쉬어 봐요.',
    '여기까지 온 것만으로도 **잘했어요.**\n물 한 잔 마시고 올래요? (안심한 시사)',
    '지금은 **잠깐 쉬어도** 돼요.\n돌아와서 하나만 해 봐요.',
    '무리하지 말아요.\n작은 것 **하나**면 충분해요.',
  ] },
  { key: 'done:o', button: 'done', hint: '남은 일 있을 때', lines: [
    '제 화면에는 아직 **{open}개** 남아 있어~요.\n그래도 **수고했어요.**',
    '남은 게 **{open}개** 보여요.\n끝낸 건 꼭 챙겨 두고, 오늘은 여기까지 해도 좋아요.',
  ] },
  { key: 'done', button: 'done', hint: '끝냈을 때', lines: [
    '**수고했어요.**\n오늘은 푹 쉬어도 돼요. (스이시~사)',
    '정말 잘했어요!\n자기 전에 **내일 할 일**만 하나 생각해 봐요.',
    '**대단해요.**\n맛있는 것도 먹고 쉬어요.',
    '오늘 하루 **고생 많았어요.**\n이제 마음 편히 쉬어요.',
    '끝까지 해냈네요.\n**오늘의 승리**예요. (뿌듯한 시사)',
    '**멋져요!**\n내일도 천천히 같이 해요.',
  ] },
  { key: 'rest', button: 'rest', hint: '', lines: [
    '**그럼요.**\n쉬는 것도 일의 일부예요.',
    '**잠깐 쉬어~요.**\n눈을 감고 숨을 크게 쉬어 봐요.',
    '**좋아요.**\n10분 쉬고 돌아와요. (안심한 시사)',
    '쉬어도 괜찮아요.\n몸을 **조금만** 풀어 줘요.',
    '**충분히 쉬어요.**\n돌아오면 제가 기다리고 있을게요.',
  ] },
  { key: 'cheer', button: 'cheer', hint: '', lines: [
    '**잘하고 있어~요.**\n지금 속도로 충분해요.',
    '**할 수 있어요!**\n하나씩 하면 어느새 끝나 있어요. (스이시~사)',
    '오늘도 **여기까지 온 게** 대단해요.\n제가 옆에 있을게요.',
    '**파이팅!**\n막히면 쉬었다 해도 돼요.',
    '당신은 **생각보다 잘하고** 있어요.\n작은 한 걸음이면 돼요.',
    '**응원해요.**\n오늘도 천천히, 그래도 꾸준히 해요. (기쁜 시사)',
  ] },
  { key: 'dance', button: 'dance', hint: '', lines: [
    '💃 **춤춰요!**\n같이 신나게 해 봐요. (스이시~사)',
    '**춤 타임!**\n잠깐 쉬어 가요.',
  ] },
  { key: 'hello:morning', button: 'hello', hint: '아침', lines: [
    '**좋은 아침이에요!**\n오늘도 천천히 시작해요. (스이시~사)',
    '안녕하세요, **시사**예요.\n아침부터 만나서 반가워요.',
    '**굿모닝!**\n오늘 할 일부터 같이 볼까요?',
  ] },
  { key: 'hello:day', button: 'hello', hint: '낮', lines: [
    '**안녕하세요!**\n오늘은 잘 지나가고 있어~요?',
    '반가워요, **시사**예요.\n점심은 먹었어요?',
    '**안녕!**\n필요하면 오늘 할 일을 같이 봐요. (스이시~사)',
  ] },
  { key: 'hello:evening', button: 'hello', hint: '저녁', lines: [
    '**수고 많았어요.**\n저녁은 챙겨 먹었어요?',
    '안녕하세요, **시사**예요.\n오늘 하루는 어땠어요? (스이시~사)',
    '**안녕!**\n남은 일이 있으면 같이 정리해요.',
  ] },
  { key: 'hello:night', button: 'hello', hint: '밤', lines: [
    '**늦은 시간이에요.**\n오늘은 일찍 쉬어도 좋아요.',
    '안녕하세요, **시사**예요.\n밤에도 곁에 있을게요. (안심한 시사)',
    '**안녕!**\n너무 무리하지는 말아요.',
  ] },
  { key: 'who', button: 'who', hint: '', lines: [
    '저는 **시사**예요.\n오늘 할 일을 함께 보는 작은 비서예요. (스이시~사)',
    '**시사**라고 해요.\n할 일을 같이 보고 응원해요.',
    '저는 **시사**예요.\n지금은 정해진 말만 해요. AI를 붙이면 자유롭게 이야기할 수 있어요.',
    '**시사**예요.\n옆에서 오늘 할 일을 같이 봐요.',
  ] },
  { key: 'what', button: 'what', hint: '', lines: [
    '**오늘 할 일**이 얼마나 끝났는지 알려 줘요.\n힘이 안 날 때 응원도 해요.',
    '할 일 **현황**을 말해 주고, **다음에 할 일**을 골라 줘요.\n지금은 정해진 말로만 해요.',
    '할 일을 같이 보고 **응원**해요.\nAI를 붙이면 더 자유롭게 대화할 수 있어~요.',
    '**개요**, **할 일**, **프로젝트** 탭에서 오늘 상황을 볼 수 있어요.\n저는 그걸 말로 알려 줘요.',
  ] },
  { key: 'where', button: 'where', hint: '', lines: [
    '**개요** 탭에서 오늘을 한눈에 봐요.\n**할 일** 탭에서 할 일을 봐요.',
    '진행 중인 일은 **프로젝트** 탭에 있어~요.\n오늘 할 일은 **할 일** 탭에 있어요.',
    '**설치** 탭에서는 연결을 바꿀 수 있어요.\n**모델** 탭에서는 쓸 AI를 골라요.',
  ] },
  { key: 'ai', button: 'ai', hint: '', lines: [
    '**설치** 탭에서 AI를 붙이면 돼요.\n무료로 시작하는 **Gemini**를 권해요.',
    'AI를 붙이면 저와 **자유롭게** 이야기할 수 있어요.\n**설치** 탭에서 처음 화면으로 돌아가 골라 봐요.',
    '지금은 **정해진 말**만 할 수 있어~요.\n**설치** 탭에서 AI를 고르면 입력창이 열려요.',
    'Claude Code나 Codex가 있으면 **키 없이** 붙일 수 있어요.\n**설치** 탭을 열어 봐요.',
  ] },
];

// 단추 이름·묶음 설명은 부를 때 지금 언어로(표 overlay.canned_<id> · overlay.canned_hint_<key>). 시사 기본 말(lines)은 캐릭터 대사 쪽
const hintKey = (key) => `overlay.canned_hint_${key.replace(':', '_')}`;
for (const c of CANNED) Object.defineProperty(c, 'label', { get: () => t(`overlay.canned_${c.id}`), enumerable: true });
for (const g of CANNED_CATALOG) { const had = !!g.hint; Object.defineProperty(g, 'hint', { get: () => (had ? t(hintKey(g.key)) : ''), enumerable: true }); }

export const CANNED_DEFAULTS = Object.fromEntries(CANNED_CATALOG.map((g) => [g.key, g.lines]));
export const CANNED_KEYS = CANNED_CATALOG.map((g) => g.key);

const fallback = () => [t('overlay.canned_fallback')];

export function plainTitle(t) {
  const s = String(t ?? '').replace(/[*_`~[\]()<>#|\\]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > 30 ? `${s.slice(0, 29)}…` : s;
}

export function fillCanned(line, c = {}) {
  const open = Math.max(0, Number(c.open) || 0);
  const done = Math.max(0, Number(c.done) || 0);
  const total = Number.isFinite(c.total) ? Math.max(0, c.total) : open + done;
  const map = {
    next: c.next || '',
    open: String(open),
    done: String(done),
    total: String(total),
    rest: String(Math.max(open - 1, 0)),
  };
  return String(line ?? '').replace(/\{(next|open|done|total|rest)\}/g, (_, k) => map[k]);
}

export function sanitizeCanned(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of CANNED_KEYS) {
    if (!Array.isArray(src[key])) continue;
    const lines = src[key]
      .map((s) => (typeof s === 'string' ? s.replace(/\r\n/g, '\n').trim() : ''))
      .filter(Boolean);
    if (lines.length) out[key] = lines;
  }
  return out;
}

function linesFor(key, override, character) {
  const own = override?.[key];
  if (Array.isArray(own) && own.length) return own;
  const byChar = Object.hasOwn(CHARACTER_CANNED, character ?? '') ? CHARACTER_CANNED[character][key] : null;
  return byChar?.length ? byChar : (CANNED_DEFAULTS[key] || fallback());
}

function usable(pool, c) {
  if (c.next) return pool;
  const rest = pool.filter((s) => !s.includes('{next}'));
  return rest.length ? rest : pool;
}

function todayKey(c) {
  return `today:${c.open ? (c.done ? 'p' : 'n') : (c.done ? 'a' : 'e')}`;
}

export function cannedPool(kind, c, override, character) {
  const pick = (key) => usable(linesFor(key, override, character), c);
  switch (kind) {
    case 'today': return { key: todayKey(c), pool: pick(todayKey(c)) };
    case 'next':
      if (c.next && c.open) return { key: 'next', pool: pick('next') };
      return { key: todayKey(c), pool: pick(todayKey(c)) };
    case 'tired': return { key: 'tired', pool: pick('tired') };
    case 'done': return { key: c.open ? 'done:o' : 'done', pool: c.open ? [...pick('done:o'), ...pick('done')] : pick('done') };
    case 'rest': return { key: 'rest', pool: pick('rest') };
    case 'cheer': return { key: 'cheer', pool: pick('cheer') };
    case 'dance': return { key: 'dance', pool: pick('dance') };
    case 'hello': return { key: `hello:${c.period}`, pool: pick(`hello:${c.period}`) };
    case 'who': return { key: 'who', pool: pick('who') };
    case 'what': return { key: 'what', pool: pick('what') };
    case 'where': return { key: 'where', pool: pick('where') };
    case 'ai': return { key: 'ai', pool: pick('ai') };
    default: return { key: 'fallback', pool: fallback() };
  }
}

function period(hour) {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'day';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

const bags = new Map();
const lastPicked = new Map();

export function resetCanned() {
  bags.clear();
  lastPicked.clear();
}

function shuffled(n, rng) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextIndex(key, n, rng) {
  if (n <= 1) return 0;
  let bag = bags.get(key);
  if (!bag?.length) {
    bag = shuffled(n, rng);
    if (bag[0] === lastPicked.get(key)) bag.push(bag.shift());
  }
  const i = bag.shift();
  bags.set(key, bag);
  lastPicked.set(key, i);
  return i;
}

// kind: CANNED 의 id. ctx: { open, done, next, hour }. opts.override 는 저장한 말, opts.character 는 캐릭터 id, opts.rng 는 테스트용.
export function cannedReply(kind, ctx = {}, opts = {}) {
  const rng = opts.rng ?? Math.random;
  const c = {
    open: Math.max(0, Number(ctx.open) || 0),
    done: Math.max(0, Number(ctx.done) || 0),
    next: plainTitle(ctx.next),
    total: 0,
    period: period(Number.isFinite(ctx.hour) ? ctx.hour : new Date().getHours()),
  };
  c.total = c.open + c.done;
  const { key, pool } = cannedPool(kind, c, opts.override, opts.character);
  return fillCanned(pool[nextIndex(`${opts.character ?? ''}:${key}`, pool.length, rng)], c);
}
