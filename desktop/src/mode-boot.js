// 앱이 켜질 때 가장 먼저: 고른 모드(mode.json)를 읽어 이 프로세스의 환경(CY_AGENT_MODE·CY_AGENT_HOME·CY_AGENT_PORT)을 정한다.
// main.js 의 다른 import 보다 먼저 돌아야 해서 따로 둔다(main.js 맨 위에서 import). 앱이 띄우는 데몬 자식도 이 환경을 그대로 받는다
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootMode } from './mode.js';

// 모드가 바꾸기 전 환경: 로그인 항목 판단처럼 「사용자가 폴더·포트를 직접 정했나」를 볼 때 쓴다
const planEnv = { ...process.env };
const boot = bootMode({ appData: app.getPath('appData'), packaged: app.isPackaged, env: planEnv, home: os.homedir(), read: (f) => fs.readFileSync(f, 'utf8') }, path.join);
Object.assign(process.env, boot.envPatch);

export const MODE = { ...boot, planEnv };
