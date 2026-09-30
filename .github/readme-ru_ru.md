<a name="readme-top"></a>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-dark.png">
  <img alt="Luker — платформа для ролевого общения нового поколения" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-light.png">
</picture>

<div align="center">

[English](readme.md) | [Deutsch](readme-de_de.md) | [简体中文](readme-zh_cn.md) | [繁體中文](readme-zh_tw.md) | [日本語](readme-ja_jp.md) | **Русский** | [한국어](readme-ko_kr.md)

[![GitHub Stars](https://img.shields.io/github/stars/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/forks)
[![GitHub Issues](https://img.shields.io/github/issues/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/issues)
[![License](https://img.shields.io/github/license/funnycups/Luker.svg?style=flat)](../LICENSE)
[![Docs](https://img.shields.io/badge/docs-luker.cups.moe-orange?style=flat)](https://luker.cups.moe)
[![Android APK](https://img.shields.io/badge/download-Android%20APK-3ddc84?style=flat&logo=android&logoColor=white)](https://github.com/funnycups/Luker/releases)

</div>

---

Luker — платформа для ролевого общения нового поколения. Общайтесь с персонажами, которые помнят, что произошло, чьи сцены перед каждым ответом планирует ансамбль агентов во главе с режиссёром, чьи карточки вы редактируете, разговаривая с ИИ, и которые умеют искать информацию в интернете прямо посреди диалога.

## Что такое Luker

Luker — это среда, созданная специально для ролевой игры с большими языковыми моделями. В комплекте — долговременная память на основе графа, мультиагентный планировщик сцен с библиотекой переиспользуемых навыков, студия карточек персонажей с ИИ-ассистентом, помощник по пресетам, нативная синхронизация по локальной сети и настоящее Android-приложение, которое запускает весь бэкенд прямо на телефоне — всё это в одной установке, без сторонних расширений.

Luker построен на базе [SillyTavern](https://github.com/SillyTavern/SillyTavern) и сохраняет с ним **100% совместимость данных**. Карточки персонажей, информация о мире, пресеты и чаты переносятся в обе стороны без каких-либо затрат на миграцию.

## Ключевые возможности

### Memory Graph — персонажи действительно помнят

Долговременная память на основе графа знаний. Каждая сцена превращается в типизированные узлы (персонажи, локации, события, сюжетные линии), связанные между собой. Перед каждым ответом проход припоминания идёт по графу и подставляет в контекст самые релевантные воспоминания — поэтому, когда спустя тридцать ходов пользователь спрашивает про «третий путь к разрушенному святилищу», персонаж достаёт именно тот давний разговор.

![Демонстрация Memory Graph](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/memory-graph-demo.gif)

→ [Документация Memory Graph](https://luker.cups.moe/features/memory-graph)

### Мультиагентный оркестратор — ансамбль во главе с режиссёром планирует каждый ответ

Прежде чем LLM-писатель проронит хоть слово, сначала запускается настраиваемый ансамбль агентов: дистиллятор сжимает недавний контекст, планировщик набрасывает следующую сцену, критик проверяет результат. Готовый ответ приходит вместе с трассировкой выполнения, которую можно изучить. Выберите один из пяти режимов исполнения — Spec (фиксированный конвейер), Single Agent, Agenda (поток распределяет задачи между агентами по мере выполнения), Loop (один агент итеративно выполняет вызовы инструментов до завершения задачи) или Director (главный агент вместе с командой суб-агентов пишет текст сообщения напрямую).

![Демонстрация мультиагентного оркестратора](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/orchestrator-demo.gif)

→ [Документация мультиагентного оркестратора](https://luker.cups.moe/features/orchestrator/)

### Skills — переиспользуемые наборы знаний по мере необходимости

Переиспользуемые наборы знаний, которые агент читает по мере необходимости: правила письма, речевые конвенции, чек-листы против штампов. Формат совместим с Anthropic Claude Skills, поэтому навык, написанный для Claude Code, без изменений переносится в Luker и обратно. Профиль Director, используемый оркестратором по умолчанию, поставляется с 24 встроенными навыками, а ещё навыки можно передавать вместе с карточкой персонажа или пресетом.

<img alt="Менеджер навыков с установленными и встроенными навыками" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/_screenshots/skills/manager-installed-tab.png" width="720">

→ [Документация Skills](https://luker.cups.moe/features/skills/)

### CardApp Studio и ИИ-редактор карточек — редактируйте карточки, разговаривая с ИИ

Полноценная IDE для карточек персонажей: редактор CodeMirror-6, панель чата с ИИ и подтверждение каждой партии правок в виде diff. Обычным карточкам достаётся редактор во всплывающем окне; карточки со встроенным **CardApp** — мини-приложением, живущим внутри карточки, — открываются в полноценной Studio с деревом файлов, живым предпросмотром и историей.

![Демонстрация CardApp Studio](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/cardapp-studio-demo.gif)

→ [Помощник редактора карточек](https://luker.cups.moe/features/card-editor/) · [CardApp Studio](https://luker.cups.moe/features/card-editor/studio)

### Preset Assistant — создание пресета по описанию

Расскажите помощнику, что должен делать ваш пресет чат-комплита. Он дорабатывает пресет вместе с вами, один diff за раз, пока результат вас не устроит: читает параметры, правит записи промптов и сравнивает с эталонным пресетом. Тот же подход работает и с пресетами оркестратора.

<img alt="Preset Assistant" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png" width="720">

→ [Документация Preset Assistant](https://luker.cups.moe/features/preset-assistant)

### Нативное приложение для Android — вся платформа в вашем телефоне

Бэкенд Luker работает *внутри* приложения для Android. Установите APK, откройте его — и получите полноценный сервер вместе с интерфейсом на одном устройстве: без Termux, без ручной установки Node, без проброса портов. Импорт резервной копии в формате ZIP прямо на экране первого запуска делает переезд безболезненным.

![Демонстрация Android APK](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/android-apk-demo.gif)

→ [Руководство по приложению для Android](https://luker.cups.moe/guide/android)

### Поисковые инструменты — персонажи умеют искать в сети

Дайте LLM-писателю инструмент живого веб-поиска (DuckDuckGo, SearXNG, Brave) или запустите поискового агента перед генерацией, который запишет результаты в информацию о мире ещё до начала ответа. В основе — настоящие поисковые системы, а не просто попытка вспомнить что-то из обучающих данных.

→ [Документация по поисковым инструментам](https://luker.cups.moe/features/search-tools)

### LAN Sync

Свяжите два экземпляра Luker в одной сети. Чаты, карточки, информация о мире и настройки синхронизируются между ними, так что компьютер и телефон остаются синхронными, а в облако ничего отправлять не нужно.

→ [Руководство по LAN Sync](https://luker.cups.moe/improvements/lan-sync)

### Объединение и разделение чатов

Разделите длинный чат в любой реплике или объедините два чата в один — история ветвлений остаётся согласованной. Пригодится, когда сцена вышла из-под контроля и хочется ответвить интересные фрагменты, не потеряв всё остальное.

<img alt="Объединение и разделение чатов" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/chat-merge-split/07-split-dialog-three-segments.png" width="720">

→ [Управление чатами](https://luker.cups.moe/basics/chat-management)

### Атрибуция реплик NPC в TTS

Когда TTS включён, каждая реплика в кавычках может звучать голосом своего персонажа. Фоновый проход определяет, кому принадлежит каждая из них: обнаруженные NPC автоматически попадают в карту голосов, а имена, добавленные заранее, распознаются уже при первом воспроизведении.

<img alt="Кнопки воспроизведения у каждой реплики в сообщении чата" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/tts-npc-attribution/03-inline-buttons-zoom.png" width="678">

→ [Атрибуция реплик NPC в TTS](https://luker.cups.moe/features/tts-npc-attribution)

### Меняйте модель, сохраняя настройку промптов

В SillyTavern API-подключения и пресеты чат-комплита связаны между собой, поэтому переключение на другую модель тянет за собой всю вашу конфигурацию промптов. Luker развязывает эти две вещи: меняйте модель, не пересобирая промпты, и меняйте пресет, не трогая API-ключи.

### Закройте вкладку — ответ продолжит писаться

Генерация выполняется на бэкенде и стримится в интерфейс по WebSocket. Перезагрузите вкладку, закройте крышку ноутбука, потеряйте Wi-Fi — ответ продолжит писаться на сервере и подключится к вашему интерфейсу, как только вы вернётесь. Ничего не теряется, ничего не приходится перезапускать.

→ [Хранение на бэкенде и жизненный цикл](https://luker.cups.moe/improvements/backend-storage)

---

Завершает картину длинный хвост мелких удобств — группировка пресетов и промптов, блокировка персоны в чате, уведомления с отменой, трассировка того, какие записи Информации о мире сработали и почему, списки моделей, подгружаемые в реальном времени от каждого провайдера. Всё это описано в [документации](https://luker.cups.moe).

## Скриншоты

<table>
  <tr>
    <td width="50%"><img alt="Инспектор Memory Graph" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/memory-graph/memory-graph-view.png"></td>
    <td width="50%"><img alt="Трассировка выполнения оркестратора" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/orchestrator/orch-runtime-trace.png"></td>
  </tr>
  <tr>
    <td width="50%"><img alt="Рабочее пространство CardApp Studio" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/cardapp-studio/studio-overview.png"></td>
    <td width="50%"><img alt="Preset Assistant" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png"></td>
  </tr>
</table>

## Начало работы

- **Десктоп (Node.js)** — `git clone https://github.com/funnycups/Luker.git && cd Luker && npm install && node server.js`. Требуется Node.js 24 или новее. → [Начало работы](https://luker.cups.moe/guide/getting-started)
- **Android APK** — скачайте последний подписанный APK со страницы [Releases](https://github.com/funnycups/Luker/releases) и установите. → [Руководство по приложению для Android](https://luker.cups.moe/guide/android)
- **Docker** — `docker compose up` с использованием compose-файла в корне репозитория. → [Начало работы](https://luker.cups.moe/guide/getting-started)

## Переходите из SillyTavern?

Luker на 100% совместим с SillyTavern по данным в обе стороны. Скопируйте папку `data/` — и готово: карточки, информация о мире, пресеты, чаты, персоны, настройки. Глобальные сторонние расширения хранятся вне `data/`, в `public/scripts/extensions/third-party/`, поэтому скопируйте их отдельно. Если решите вернуться, скопируйте её в обратную сторону; эксклюзивные данные Luker (графы памяти, конфигурации оркестратора) лежат в отдельных файлах состояния, которые SillyTavern игнорирует. **Впрочем, перед миграцией всё равно сделайте резервную копию.**

→ [Руководство по миграции](https://luker.cups.moe/guide/migration)

## Сообщество и обратная связь

- Отчёты об ошибках и предложения по функциям: [GitHub Issues](https://github.com/funnycups/Luker/issues)
- Перед созданием issue прочитайте документацию: [luker.cups.moe](https://luker.cups.moe)

## Участие в разработке

Pull request'ы приветствуются. См. [CONTRIBUTING.md](../CONTRIBUTING.md) и, пожалуйста, поищите среди существующих issue, прежде чем открывать новое.

## Лицензия и благодарности

Лицензия — **AGPL-3.0**. Программа распространяется в надежде, что окажется полезной, но БЕЗ КАКИХ-ЛИБО ГАРАНТИЙ; подробности — в [GNU Affero General Public License](../LICENSE).

- В основе — **SillyTavern** от Cohee, RossAscends, Wolfsblvt и ещё более 300 участников: <https://github.com/SillyTavern/SillyTavern>
- [TavernAI](https://github.com/TavernAI/TavernAI-v1) 1.2.8 от Humi (лицензия MIT)
- Части мода TavernAITurbo от CncAnon используются с разрешения
- Режим визуальной новеллы вдохновлён [PepperTaco](https://github.com/peppertaco/Tavern/)
- Шрифт Noto Sans от Google (лицензия OFL)
- Лексер и парсер — [Chevrotain](https://github.com/chevrotain/chevrotain) (Apache-2.0)
- Набор иконок — [Font Awesome](https://fontawesome.com) (иконки CC BY 4.0, шрифты SIL OFL 1.1, код MIT)
- Контент персонажа по умолчанию от @OtisAlejandro (Seraphina) и @kallmeflocc
- Руководство по Docker от [@mrguymiah](https://github.com/mrguymiah) и [@Bronya-Rand](https://github.com/Bronya-Rand)
- Библиотека kokoro-js от [@hexgrad](https://github.com/hexgrad) (Apache-2.0)

## Основные участники

[![Contributors](https://contrib.rocks/image?repo=funnycups/Luker)](https://github.com/funnycups/Luker/graphs/contributors)
