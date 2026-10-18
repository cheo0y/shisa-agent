// 데몬 화면 글 표 모음(키 앞에 묶음 이름: t("status.offline")). 새 묶음은 여기에 한 줄
import common from "./common.ts";
import status from "./status.ts";
import say from "./say.ts";

export type Table = Record<string, Record<string, string>>;
export const TABLES: Record<string, Table> = { common, status, say };
