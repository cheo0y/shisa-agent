// 메일 서비스(IMAP) 프리셋: 서버 주소·포트, 주소로 서비스 짐작하기, 로그인 실패를 사람 말로 바꿀 때 서비스별 안내.
// 서버 주소는 각 서비스 공식 안내에서 확인한 것만 넣었다(2026-10). 카카오메일(@kakao.com)은 서버 주소를 확인하지 못해 「다른 IMAP」으로 직접 적는다.
export const MAIL_PRESET_IDS = ["gmail", "naver", "daum"] as const;
import { t } from "./i18n.ts";
export type MailPresetId = (typeof MAIL_PRESET_IDS)[number];

export type MailPreset = {
  label: string;
  host: string;
  port: number;
  domains: string[];      // 이 주소면 이 서비스로 짐작한다
  gmail?: boolean;        // X-GM-RAW 검색(프로모션·소셜 거르기)·메일 링크를 쓴다
  authHint: string;       // 로그인이 거절됐을 때 덧붙일 안내(해요체)
};

export const MAIL_PRESETS: Record<MailPresetId, MailPreset> = {
  gmail: {
    label: "Gmail", host: "imap.gmail.com", port: 993, domains: ["gmail.com", "googlemail.com"], gmail: true,
    get authHint() { return t("status.preset_gmail_hint"); },
  },
  naver: {
    get label() { return t("status.preset_naver"); }, host: "imap.naver.com", port: 993, domains: ["naver.com"],
    get authHint() { return t("status.preset_naver_hint"); },
  },
  daum: {
    get label() { return t("status.preset_daum"); }, host: "imap.daum.net", port: 993, domains: ["daum.net", "hanmail.net"],
    get authHint() { return t("status.preset_daum_hint"); },
  },
};

export const isMailPreset = (x: unknown): x is MailPresetId => typeof x === "string" && (MAIL_PRESET_IDS as readonly string[]).includes(x);

// 메일 주소 → 서비스(모르면 undefined)
export function guessMailPreset(email: string): MailPresetId | undefined {
  const d = String(email ?? "").trim().toLowerCase().split("@")[1];
  if (!d) return undefined;
  return MAIL_PRESET_IDS.find((id) => MAIL_PRESETS[id].domains.includes(d));
}

// 서버 이름 모양만 본다(주소·포트를 섞어 넣지 않게)
export const mailHostOk = (h: string) => /^[a-z0-9.-]{1,253}$/i.test(h) || h === "::1";
