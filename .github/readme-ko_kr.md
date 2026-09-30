<a name="readme-top"></a>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-dark.png">
  <img alt="Luker — 차세대 롤플레이 채팅 플랫폼" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-light.png">
</picture>

<div align="center">

[English](readme.md) | [Deutsch](readme-de_de.md) | [简体中文](readme-zh_cn.md) | [繁體中文](readme-zh_tw.md) | [日本語](readme-ja_jp.md) | [Русский](readme-ru_ru.md) | **한국어**

[![GitHub Stars](https://img.shields.io/github/stars/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/forks)
[![GitHub Issues](https://img.shields.io/github/issues/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/issues)
[![License](https://img.shields.io/github/license/funnycups/Luker.svg?style=flat)](../LICENSE)
[![Docs](https://img.shields.io/badge/docs-luker.cups.moe-orange?style=flat)](https://luker.cups.moe)
[![Android APK](https://img.shields.io/badge/download-Android%20APK-3ddc84?style=flat&logo=android&logoColor=white)](https://github.com/funnycups/Luker/releases)

</div>

---

Luker는 차세대 롤플레이 채팅 플랫폼입니다. 일어난 일을 기억하는 캐릭터와 대화하고, 모든 답변 전에 Director가 이끄는 에이전트 팀이 장면을 설계하며, AI와 대화하며 카드를 편집하고, 대화 도중에 웹 검색까지 할 수 있습니다.

## Luker란 무엇인가

Luker는 대규모 언어 모델과의 롤플레이를 위해 처음부터 설계된 환경입니다. 그래프 기반 장기 기억, 재사용 가능한 스킬 라이브러리를 갖춘 멀티 에이전트 장면 플래너, AI 지원 캐릭터 카드 스튜디오, Preset Assistant, 네이티브 LAN Sync, 그리고 백엔드 전체를 휴대폰에서 돌리는 진짜 Android 앱까지 — 하나의 설치본에 전부 들어 있어서 서드파티 확장이 필요 없습니다.

Luker는 [SillyTavern](https://github.com/SillyTavern/SillyTavern)을 기반으로 만들어졌으며, SillyTavern과 **100% 데이터 호환**을 유지합니다. 캐릭터 카드, 월드 인포, 프리셋, 채팅이 양방향으로 오가며, 마이그레이션 비용이 전혀 들지 않습니다.

## 주요 기능

### Memory Graph — 캐릭터가 진짜로 기억하는 법

지식 그래프 기반의 장기 기억입니다. 모든 장면은 유형이 지정된 노드(캐릭터, 장소, 사건, 스토리라인)로 정제되고, 노드끼리 서로 연결됩니다. 답변을 내보내기 전마다 리콜 단계가 그래프를 순회하며 가장 관련성 높은 기억을 컨텍스트에 주입합니다. 그래서 서른 턴 뒤에 사용자가 "폐허가 된 신전으로 가는 세 번째 길"을 물어도, 캐릭터는 예전에 나눈 그 대화를 정확히 꺼내옵니다.

![Memory Graph 데모](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/memory-graph-demo.gif)

→ [Memory Graph 문서](https://luker.cups.moe/features/memory-graph)

### Multi-Agent Orchestrator — Director가 이끄는 에이전트 팀이 모든 답변을 설계

답변 작성 LLM이 입을 열기 전에, 설정 가능한 에이전트 팀이 먼저 실행됩니다. 디스틸러가 최근 컨텍스트를 압축하고, 플래너가 다음 장면을 스케치하며, 크리틱이 검토합니다. 최종 답변은 직접 확인할 수 있는 런타임 트레이스와 함께 도착합니다. 다섯 가지 실행 모드 중에서 고르세요 — Spec(고정 파이프라인), Single Agent, Agenda(흐름이 진행되면서 에이전트를 배치), Loop(단일 에이전트가 작업이 완료될 때까지 도구 호출을 반복), Director(메인 에이전트와 서브 에이전트 팀이 메시지 본문을 직접 작성).

![Orchestrator 데모](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/orchestrator-demo.gif)

→ [Multi-Agent Orchestrator 문서](https://luker.cups.moe/features/orchestrator/)

### Skills — 필요할 때 불러오는 재사용 가능한 지식 팩

에이전트가 필요할 때 읽는 재사용 가능한 지식 팩입니다. 글쓰기 규칙, 말투 규칙, 클리셰 방지 체크리스트 같은 것들이 담깁니다. 형식은 Anthropic Claude Skills와 호환되므로, Claude Code용으로 작성한 스킬을 수정 없이 Luker로 옮기고 다시 되돌릴 수 있습니다. Orchestrator의 기본 Director profile에는 24개의 번들 스킬이 들어 있으며, 스킬은 캐릭터 카드나 프리셋과 함께 배포할 수 있습니다.

<img alt="설치된 스킬과 번들 스킬을 보여주는 스킬 관리자" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/_screenshots/skills/manager-installed-tab.png" width="720">

→ [Skills 문서](https://luker.cups.moe/features/skills/)

### CardApp Studio & AI Card Editor — AI와 대화하며 카드 편집

CodeMirror-6 에디터, AI 채팅 패널, 그리고 모든 변경 묶음을 diff로 승인하는 절차를 갖춘 캐릭터 카드용 통합 IDE입니다. 일반 카드는 팝업 에디터로 열리고, **CardApp**(카드에 내장된 미니 애플리케이션)이 들어 있는 카드는 파일 트리, 라이브 프리뷰, 히스토리를 갖춘 완전한 Studio에서 열립니다.

![CardApp Studio 데모](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/cardapp-studio-demo.gif)

→ [Card Editor Assistant](https://luker.cups.moe/features/card-editor/) · [CardApp Studio](https://luker.cups.moe/features/card-editor/studio)

### Preset Assistant — 설명을 바탕으로 프리셋 작성

채팅 완성 프리셋이 어떤 일을 하길 원하는지 어시스턴트에게 알려 주세요. 어시스턴트는 매번 diff 하나씩, 원하는 모습이 될 때까지 여러분과 함께 프리셋을 다듬어 갑니다 — 파라미터를 읽고, 프롬프트 항목을 편집하고, 참조 프리셋과 비교하면서요. 같은 워크플로가 Orchestrator 프리셋에도 적용됩니다.

<img alt="Preset Assistant" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png" width="720">

→ [Preset Assistant 문서](https://luker.cups.moe/features/preset-assistant)

### Native Android APK — 휴대폰에서 실행되는 완전한 플랫폼

Luker 백엔드는 Android 앱 *안에서* 실행됩니다. APK를 설치하고 열면 기기 한 대에서 완전한 서버와 UI를 모두 사용할 수 있습니다 — Termux도, 수동 Node 설치도, 포트 포워딩도 필요 없습니다. 첫 실행 화면에서 백업 ZIP을 가져올 수 있어 마이그레이션도 간편합니다.

![Android APK 데모](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/android-apk-demo.gif)

→ [Android 앱 가이드](https://luker.cups.moe/guide/android)

### Search Tools — 캐릭터도 웹 검색

답변 작성 LLM에 실시간 웹 검색 도구(DuckDuckGo, SearXNG, Brave)를 달아 주거나, 답변이 시작되기 전에 검색 에이전트를 먼저 실행해 결과를 월드 인포에 기록하게 할 수 있습니다. 단순한 학습 데이터 조회가 아니라 실제 검색 엔진이 뒷받침합니다.

→ [Search Tools 문서](https://luker.cups.moe/features/search-tools)

### LAN Sync

같은 네트워크에 있는 두 Luker 인스턴스를 페어링하세요. 채팅, 카드, 월드 인포, 설정이 두 인스턴스 사이에서 동기화되므로, 클라우드에 아무것도 올리지 않고도 데스크톱과 휴대폰을 같은 상태로 유지할 수 있습니다.

→ [LAN Sync 가이드](https://luker.cups.moe/improvements/lan-sync)

### 채팅 병합과 분할

긴 채팅을 원하는 턴에서 분할하거나 두 채팅을 하나로 병합할 수 있으며, 분기 히스토리도 일관되게 유지됩니다. 장면이 통제를 벗어나서, 나머지는 그대로 둔 채 재미있는 부분만 따로 분기해 내고 싶을 때 유용합니다.

<img alt="채팅 병합과 분할" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/chat-merge-split/07-split-dialog-three-segments.png" width="720">

→ [채팅 관리](https://luker.cups.moe/basics/chat-management)

### TTS NPC 대사 화자 배정

TTS를 켜면 답변 속 따옴표로 묶인 대사마다 그 화자의 목소리로 재생할 수 있습니다. 백그라운드에서 각 대사를 누가 말했는지 판별합니다 — 찾아낸 NPC는 음성 맵에 자동으로 추가되고, 미리 등록해 둔 이름은 첫 재생부터 인식됩니다.

<img alt="채팅 메시지의 대사별 재생 버튼" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/tts-npc-attribution/03-inline-buttons-zoom.png" width="678">

→ [TTS NPC 대사 화자 배정](https://luker.cups.moe/features/tts-npc-attribution)

### 모델을 바꿔도 프롬프트 설정은 그대로

SillyTavern에서는 API 연결과 채팅 완성 프리셋이 함께 움직이므로, 다른 모델로 바꾸면 프롬프트 구성까지 덩달아 끌려갑니다. Luker는 이 둘을 분리했습니다. 프롬프트 설정을 다시 만들지 않고 모델만 바꾸고, API 키는 건드리지 않고 프리셋만 교체할 수 있습니다.

### 탭을 닫아도 답변은 계속

생성은 백엔드에서 실행되고, WebSocket을 통해 UI로 스트리밍됩니다. 탭을 새로고침하거나, 노트북 덮개를 닫거나, Wi-Fi가 끊겨도 — 답변은 서버에서 계속 작성되고, 돌아오는 순간 UI에 다시 연결됩니다. 잃을 것도, 다시 시작할 것도 없습니다.

→ [백엔드 스토리지와 수명 주기](https://luker.cups.moe/improvements/backend-storage)

---

그 밖에도 프리셋 그룹과 프롬프트 그룹, 채팅별 페르소나 잠금, 실행 취소 토스트, 어떤 월드 인포 항목이 왜 발동했는지 보여 주는 트레이스, 각 제공자에서 실시간으로 가져오는 모델 목록 등 자잘한 편의 기능이 이어집니다. 이 모든 내용은 [문서](https://luker.cups.moe)에 설명되어 있습니다.

## 스크린샷

<table>
  <tr>
    <td width="50%"><img alt="Memory Graph 인스펙터" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/memory-graph/memory-graph-view.png"></td>
    <td width="50%"><img alt="Orchestrator 런타임 트레이스" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/orchestrator/orch-runtime-trace.png"></td>
  </tr>
  <tr>
    <td width="50%"><img alt="CardApp Studio 워크스페이스" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/cardapp-studio/studio-overview.png"></td>
    <td width="50%"><img alt="Preset Assistant" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png"></td>
  </tr>
</table>

## 시작하기

- **데스크톱(Node.js)** — `git clone https://github.com/funnycups/Luker.git && cd Luker && npm install && node server.js`. Node.js 24 이상이 필요합니다. → [시작하기](https://luker.cups.moe/guide/getting-started)
- **Android APK** — [Releases](https://github.com/funnycups/Luker/releases) 페이지에서 최신 서명 APK를 내려받아 설치하세요. → [Android 앱 가이드](https://luker.cups.moe/guide/android)
- **Docker** — 저장소 루트에 있는 compose 파일로 `docker compose up`을 실행하세요. → [시작하기](https://luker.cups.moe/guide/getting-started)

## SillyTavern에서 오셨나요?

Luker는 SillyTavern과 양방향으로 100% 데이터 호환이 됩니다. `data/` 폴더를 복사해 오면 끝입니다 — 카드, 월드 인포, 프리셋, 채팅, 페르소나, 설정까지 전부요. 글로벌 서드파티 확장은 `data/` 밖, `public/scripts/extensions/third-party/`에 저장되므로 따로 복사해야 합니다. 다시 돌아가기로 마음먹었다면 반대 방향으로 복사하면 됩니다. Luker 전용 데이터(메모리 그래프, Orchestrator 설정)는 SillyTavern이 무시하는 별도의 상태 파일에 들어 있습니다. **어쨌든 마이그레이션 전에는 백업하세요.**

→ [마이그레이션 가이드](https://luker.cups.moe/guide/migration)

## 커뮤니티와 피드백

- 버그 신고와 기능 요청: [GitHub Issues](https://github.com/funnycups/Luker/issues)
- 이슈를 열기 전에 문서를 먼저 확인해 주세요: [luker.cups.moe](https://luker.cups.moe)

## 기여하기

Pull request는 언제나 환영합니다. [CONTRIBUTING.md](../CONTRIBUTING.md)를 확인하고, 새 이슈를 등록하기 전에 기존 이슈를 먼저 검색해 주세요.

## 라이선스와 크레딧

**AGPL-3.0**으로 배포됩니다. 이 프로그램은 유용하게 쓰이기를 바라며 배포되지만, 어떠한 보증도 제공하지 않습니다. 자세한 내용은 [GNU Affero General Public License](../LICENSE)를 참고하세요.

- Cohee, RossAscends, Wolfsblvt와 300명 이상의 기여자가 만든 **SillyTavern**을 기반으로 제작: <https://github.com/SillyTavern/SillyTavern>
- [TavernAI](https://github.com/TavernAI/TavernAI-v1) 1.2.8 by Humi (MIT 라이선스)
- CncAnon의 TavernAITurbo 모드 일부를 허가를 받아 사용
- [PepperTaco](https://github.com/peppertaco/Tavern/)에서 영감을 받은 Visual Novel 모드
- Noto Sans 폰트 by Google (OFL 라이선스)
- Lexer/Parser by [Chevrotain](https://github.com/chevrotain/chevrotain) (Apache-2.0)
- 아이콘 테마 by [Font Awesome](https://fontawesome.com) (아이콘 CC BY 4.0, 폰트 SIL OFL 1.1, 코드 MIT)
- 기본 캐릭터 콘텐츠 by @OtisAlejandro(Seraphina)와 @kallmeflocc
- Docker 가이드 by [@mrguymiah](https://github.com/mrguymiah)와 [@Bronya-Rand](https://github.com/Bronya-Rand)
- kokoro-js 라이브러리 by [@hexgrad](https://github.com/hexgrad) (Apache-2.0)

## 주요 기여자

[![Contributors](https://contrib.rocks/image?repo=funnycups/Luker)](https://github.com/funnycups/Luker/graphs/contributors)
