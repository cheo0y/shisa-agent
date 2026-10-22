# Third-party notices

이 레포의 `desktop/renderer/vendor/`에는 아래 외부 라이브러리가 복사되어 들어 있습니다. 각 파일은 원래 라이선스를 따르며, 이 레포의 MIT 라이선스(LICENSE)와는 별개입니다.

| 파일 | 라이브러리 | 버전 | 라이선스 | 출처 |
|---|---|---|---|---|
| `desktop/renderer/vendor/qr.js` | uqr (Project Nayuki QR Code generator 기반) | 0.1.2 | MIT | https://github.com/unjs/uqr , https://www.nayuki.io/page/qr-code-generator-library |
| `desktop/renderer/vendor/marked.js` | marked | 18.0.14 | MIT | https://github.com/markedjs/marked |
| `desktop/renderer/vendor/purify.js` | DOMPurify | 3.4.16 | MPL-2.0 또는 Apache-2.0 (둘 중 선택) | https://github.com/cure53/DOMPurify |

## 캐릭터 그림과 이름

- v0.4.0부터 이 레포와 앱(dmg·윈도우 설치 파일)에는 캐릭터 그림·영상·말풍선 스티커가 들어 있지 않습니다. 0.3.x까지 들어 있던 그림과 영상(치이카와 팬아트)은 뺐습니다.
- 그림을 넣지 않은 캐릭터가 쓰는 기본 그림(`desktop/assets/default/`)과 앱 아이콘·트레이 아이콘은 `desktop/src/default-face.js`가 원과 곡선으로 직접 그린 것입니다. 외부 그림을 쓰지 않았고, 코드와 같은 MIT 라이선스를 따릅니다.
- 기본 캐릭터 이름(하치와레·랏코·모몽가·우사기·카니·치이카와·쿠리만쥬와 일본어 표기)은 원작 치이카와(ちいかわ, © Nagano / chiikawa committee)의 표기를 빌려 쓴 것입니다. 원작 캐릭터의 권리는 원저작자에게 있으며, 이 레포는 원작자나 권리자와 관계가 없습니다. 대사(`assets/characters/lines*.json`)는 이 앱을 위해 새로 쓴 글이고 원작 대사를 옮긴 것이 아닙니다.
- 사용자가 설정 창에서 넣는 그림·영상은 사용자 컴퓨터(`~/.cy-agent/characters/`)에만 저장되고 배포물에 들어가지 않습니다. 넣는 그림을 쓸 권리는 넣는 사람이 확인해야 합니다.

## uqr

MIT License. Copyright (c) Anthony Fu and UnJS contributors.
Based on the QR Code generator library by Project Nayuki, MIT License, Copyright (c) Project Nayuki.

## marked

MIT License.
Copyright (c) 2018-2026, MarkedJS.
Copyright (c) 2011-2018, Christopher Jeffrey.

## DOMPurify

(c) Cure53 and other contributors. Released under the Apache License 2.0 and the Mozilla Public License 2.0 (dual-licensed). 원문은 https://github.com/cure53/DOMPurify/blob/3.4.16/LICENSE 에 있습니다.

## MIT License 원문

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
