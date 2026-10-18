// 언어(데몬 lang.ts 와 같은 id) — 순수 로직. 창(프로세스)마다 하나씩 들고 있다.
// 데몬이 정한다: GET /characters 의 language(character-registry.js applyCharacters 가 넣는다)·SSE state.language·config.json language(main 이 켤 때).
// 캐릭터 대사는 데몬이 그 언어로 주고(lines.<언어>.json), 여기는 캐릭터 창(오버레이)에 늘 보이는 짧은 화면 글만 언어별로 둔다.
// 설정 창·패널 메뉴 글은 아직 한국어다(언어를 더하려면 UI 에 한 벌 더).
export const LANGUAGES = ['ko', 'ja'];
export const DEFAULT_LANGUAGE = 'ko';
export const isLang = (v) => typeof v === 'string' && LANGUAGES.includes(v);

let current = DEFAULT_LANGUAGE;
export const language = () => current;
// 바뀌었으면 true
export function setLanguage(v) {
  const next = isLang(v) ? v : DEFAULT_LANGUAGE;
  if (next === current) return false;
  current = next;
  return true;
}

// 캐릭터 창 화면 글. 함수는 그때 값(이름 등)을 받는다
export const UI = {
  ko: {
    chip_today: '오늘 할 일 얼마나 했어요?',
    chip_next_todo: '지금 할 일 뭐 있어요?',
    chip_next_event: '다음 일정은요?',
    chip_weather: '오늘 날씨?',
    chip_focus_start: '집중 시작할래?',
    chip_focus_stop: '집중 그만할래?',
    chip_cheer: '응원해 줘',
    chip_dance: '춤춰 줘',
    chip_connect: 'AI 연결하기',
    ask_placeholder: '물어보세요 · Enter',
    ask_label: (who) => `${who}에게 물어보기`,
    ask_attach: '파일 붙이기 — 이미지·PDF·문서(끌어다 놓거나 ⌘V 도 돼요)',
    ask_attach_label: '파일 붙이기',
    ask_more: '정해진 답 고르기 — 오늘 할 일·응원·춤(AI 없이 바로)',
    ask_more_label: '정해진 답 고르기',
    answer_fail: '지금은 답을 못 가져왔어요. 잠시 뒤에 다시 눌러 주세요',
    open_setup: '연결하러 가기',
    open_today: '오늘 할 일 보기',
    open_todos: '할 일 보기',
    open_panel: '패널에서 보기',
    close: '닫기',
    approve: '승인',
    hold: '보류',
    focus_on: '집중 중',
    focus_paused: '잠깐 쉬는 중',
    focus_pause: '일시정지',
    focus_resume: '다시 시작',
    focus_stop: '그만하기',
    focus_todo: (t) => `집중 중: ${t}`,
    doing: '진행 중',
    doing_more: (n) => ` 외 ${n}개`,
    stop: '답하던 걸 멈춰요',
    app_name: (name) => `${name} 비서`,
  },
  ja: {
    chip_today: '今日のやること、どれくらいできた？',
    chip_next_todo: 'いまやることは？',
    chip_next_event: '次の予定は？',
    chip_weather: '今日の天気は？',
    chip_focus_start: '集中はじめる？',
    chip_focus_stop: '集中やめる？',
    chip_cheer: '応援して',
    chip_dance: '踊って',
    chip_connect: 'AIをつなぐ',
    ask_placeholder: '話しかけてね · Enter',
    ask_label: (who) => `${who}に聞く`,
    ask_attach: 'ファイルを添付(画像・PDF・文書。ドラッグや ⌘V でも)',
    ask_attach_label: 'ファイルを添付',
    ask_more: '決まった答えを選ぶ(今日やること・応援・ダンス、AIなしですぐ)',
    ask_more_label: '決まった答えを選ぶ',
    answer_fail: 'いまは答えを持ってこられませんでした。少ししてからもう一度押してください',
    open_setup: 'つなぎに行く',
    open_today: '今日やることを見る',
    open_todos: 'やることを見る',
    open_panel: 'パネルで見る',
    close: '閉じる',
    approve: '承認',
    hold: '保留',
    focus_on: '集中中',
    focus_paused: 'ひと休み中',
    focus_pause: '一時停止',
    focus_resume: '再開',
    focus_stop: 'やめる',
    focus_todo: (t) => `集中中: ${t}`,
    doing: '進行中',
    doing_more: (n) => ` ほか${n}件`,
    stop: '答えるのを止めます',
    // 「ハチワレ秘書」. カニちゃん は アプリ名では「カニ秘書」
    app_name: (name) => `${String(name).replace(/ちゃん$/, '')}秘書`,
  },
};
// 지금 언어의 화면 글(없으면 한국어). 함수 글은 args 를 넣어 부른다
export function ui(key, ...args) {
  const v = UI[current]?.[key] ?? UI.ko[key];
  return typeof v === 'function' ? v(...args) : v ?? key;
}
