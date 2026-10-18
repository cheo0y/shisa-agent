import { t } from './i18n.js';
// 더 붙일 수 있는 MCP 목록. 화면용 데이터만 둔다.
// 도구 이름은 여기 넣지 않는다. 확인한 이름은 docs/connect/more-mcp.md 에만 적는다.
// Slack·캘린더·메일·GitHub 는 이미 프리셋이 있으므로 여기 없다.
export const EXTRA_MCPS = [
  {
    id: "notion",
    title: "Notion",
    get kid() { return t('setup.mcp_notion_kid'); },
    get youCan() { return t('setup.mcp_notion_youcan'); },
    readOnly: true,
    links: [{ href: "https://developers.notion.com/guides/mcp/mcp-supported-tools", get text() { return t('setup.mcp_notion_text'); } }],
  },
  {
    id: "google-drive",
    title: "Google Drive",
    get kid() { return t('setup.mcp_google_drive_kid'); },
    get youCan() { return t('setup.mcp_google_drive_youcan'); },
    readOnly: true,
    links: [{ href: "https://developers.google.com/workspace/drive/api/guides/configure-mcp-server", get text() { return t('setup.mcp_google_drive_text'); } }],
  },
  {
    id: "figma",
    title: "Figma",
    get kid() { return t('setup.mcp_figma_kid'); },
    get youCan() { return t('setup.mcp_figma_youcan'); },
    readOnly: true,
    links: [{ href: "https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/", get text() { return t('setup.mcp_figma_text'); } }],
  },
  {
    id: "todoist",
    title: "Todoist",
    get kid() { return t('setup.mcp_todoist_kid'); },
    get youCan() { return t('setup.mcp_todoist_youcan'); },
    readOnly: true,
    links: [{ href: "https://github.com/Doist/todoist-mcp/blob/main/README.md", get text() { return t('setup.mcp_todoist_text'); } }],
  },
  {
    id: "box",
    title: "Box",
    get kid() { return t('setup.mcp_box_kid'); },
    get youCan() { return t('setup.mcp_box_youcan'); },
    readOnly: true,
    links: [{ href: "https://developer.box.com/guides/box-mcp/tools", get text() { return t('setup.mcp_box_text'); } }],
  },
  {
    id: "miro",
    title: "Miro",
    get kid() { return t('setup.mcp_miro_kid'); },
    get youCan() { return t('setup.mcp_miro_youcan'); },
    readOnly: true,
    links: [{ href: "https://developers.miro.com/docs/miro-mcp-tools", get text() { return t('setup.mcp_miro_text'); } }],
  },
  {
    id: "asana",
    title: "Asana",
    get kid() { return t('setup.mcp_asana_kid'); },
    get youCan() { return t('setup.mcp_asana_youcan'); },
    readOnly: true,
    links: [{ href: "https://developers.asana.com/docs/mcp-tools-reference", get text() { return t('setup.mcp_asana_text'); } }],
  },
  {
    id: "monday",
    title: "monday.com",
    get kid() { return t('setup.mcp_monday_kid'); },
    get youCan() { return t('setup.mcp_monday_youcan'); },
    readOnly: true,
    links: [{ href: "https://developer.monday.com/api-reference/docs/platform-mcp-tools", get text() { return t('setup.mcp_monday_text'); } }],
  },
  {
    id: "airtable",
    title: "Airtable",
    get kid() { return t('setup.mcp_airtable_kid'); },
    get youCan() { return t('setup.mcp_airtable_youcan'); },
    readOnly: true,
    links: [{ href: "https://airtable.com/developers/agents/mcp/tools", get text() { return t('setup.mcp_airtable_text'); } }],
  },
  {
    id: "dropbox",
    title: "Dropbox",
    get kid() { return t('setup.mcp_dropbox_kid'); },
    get youCan() { return t('setup.mcp_dropbox_youcan'); },
    readOnly: true,
    links: [{ href: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server", get text() { return t('setup.mcp_dropbox_text'); } }],
  },
  {
    id: "canva",
    title: "Canva",
    get kid() { return t('setup.mcp_canva_kid'); },
    get youCan() { return t('setup.mcp_canva_youcan'); },
    readOnly: true,
    links: [{ href: "https://www.canva.dev/docs/mcp/tools/", get text() { return t('setup.mcp_canva_text'); } }],
  },
  {
    id: "sentry",
    title: "Sentry",
    get kid() { return t('setup.mcp_sentry_kid'); },
    get youCan() { return t('setup.mcp_sentry_youcan'); },
    readOnly: true,
    links: [{ href: "https://docs.sentry.io/product/sentry-mcp/", get text() { return t('setup.mcp_sentry_text'); } }],
  },
  {
    id: "stripe",
    title: "Stripe",
    get kid() { return t('setup.mcp_stripe_kid'); },
    get youCan() { return t('setup.mcp_stripe_youcan'); },
    readOnly: true,
    links: [{ href: "https://docs.stripe.com/mcp", get text() { return t('setup.mcp_stripe_text'); } }],
  },
];

// MCP 등록 안내가 의미 있는 플랜(코딩 도구가 있는 것)에서만 목록을 보여 준다.
export function extraMcpsForPlan(planId) {
  if (planId === 'tools' || planId === 'code') return EXTRA_MCPS;
  return [];
}
