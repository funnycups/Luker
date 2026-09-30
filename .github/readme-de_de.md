<a name="readme-top"></a>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-dark.png">
  <img alt="Luker — Rollenspiel-Chatplattform der nächsten Generation" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-light.png">
</picture>

<div align="center">

[English](readme.md) | **Deutsch** | [简体中文](readme-zh_cn.md) | [繁體中文](readme-zh_tw.md) | [日本語](readme-ja_jp.md) | [Русский](readme-ru_ru.md) | [한국어](readme-ko_kr.md)

[![GitHub Stars](https://img.shields.io/github/stars/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/forks)
[![GitHub Issues](https://img.shields.io/github/issues/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/issues)
[![License](https://img.shields.io/github/license/funnycups/Luker.svg?style=flat)](../LICENSE)
[![Docs](https://img.shields.io/badge/docs-luker.cups.moe-orange?style=flat)](https://luker.cups.moe)
[![Android APK](https://img.shields.io/badge/download-Android%20APK-3ddc84?style=flat&logo=android&logoColor=white)](https://github.com/funnycups/Luker/releases)

</div>

---

Luker ist eine Rollenspiel-Chatplattform der nächsten Generation. Chatte mit Charakteren, die sich an das Geschehene erinnern, deren Szenen vor jeder Antwort von einem Ensemble unter der Regie eines Directors geplant werden, deren Karten du im Dialog mit einer KI bearbeitest, und die mitten im Gespräch im Web suchen können.

## Was ist Luker

Luker ist eine eigens für Rollenspiele mit großen Sprachmodellen gebaute Umgebung. An Bord: ein graphbasiertes Langzeitgedächtnis, ein Multi-Agent-Szenenplaner mit wiederverwendbarer Skill-Bibliothek, ein KI-gestütztes Charakterkarten-Studio, ein Preset Assistant, native LAN-Sync-Unterstützung und eine echte Android-App, die das komplette Backend auf deinem Smartphone ausführt — alles in einer Installation, keine Drittanbieter-Erweiterungen nötig.

Luker baut auf [SillyTavern](https://github.com/SillyTavern/SillyTavern) auf und bleibt **100 % datenkompatibel** damit. Charakterkarten, Weltinfos, Presets und Chats lassen sich in beide Richtungen verschieben — ohne Migrationsaufwand.

## Highlights

### Memory Graph — deine Charaktere erinnern sich wirklich

Ein Langzeitgedächtnis auf Basis eines Wissensgraphen. Jede Szene wird zu typisierten Knoten verdichtet (Charaktere, Orte, Ereignisse, Handlungsstränge), die untereinander verknüpft sind. Vor jeder Antwort läuft ein Recall-Durchgang über den Graphen und injiziert die relevantesten Erinnerungen — wenn du dich dreißig Züge später nach „dem dritten Weg zum verfallenen Schrein“ erkundigst, bringt der Charakter genau dieses frühere Gespräch zur Sprache.

![Memory-Graph-Demo](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/memory-graph-demo.gif)

→ [Memory-Graph-Dokumentation](https://luker.cups.moe/features/memory-graph)

### Multi-Agent-Orchestrator — ein Ensemble unter der Regie eines Directors plant jede Antwort

Bevor das schreibende LLM überhaupt zum Zug kommt, läuft zuerst ein frei konfigurierbares Ensemble aus Agenten: Ein Destillierer komprimiert den jüngsten Kontext, ein Planer skizziert die nächste Szene, ein Kritiker prüft. Die endgültige Antwort kommt mit einem Runtime-Trace, den du einsehen kannst. Wähle einen von fünf Ausführungsmodi — Spec (eine feste Pipeline), Single Agent, Agenda (der Ablauf verteilt Agenten im laufenden Betrieb), Loop (ein einzelner Agent arbeitet Tool-Aufrufe iterativ ab, bis die Aufgabe abgeschlossen ist) oder Director (ein Haupt-Agent plus ein Sub-Agent-Team schreiben den Nachrichtentext direkt).

![Orchestrator-Demo](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/orchestrator-demo.gif)

→ [Orchestrator-Dokumentation](https://luker.cups.moe/features/orchestrator/)

### Skills — wiederverwendbare Wissenspakete, bei Bedarf geladen

Wiederverwendbare Wissenspakete, die ein Agent bei Bedarf liest: Schreibregeln, Tonfall-Konventionen, Anti-Klischee-Checklisten. Das Format ist mit Claude Skills von Anthropic kompatibel; ein für Claude Code geschriebener Skill lässt sich ohne Änderungen nach Luker übernehmen und wieder zurück. Das Standard-Director-Profil des Orchestrators bringt 24 mitgelieferte Skills mit, und Skills lassen sich zusammen mit einer Charakterkarte oder einem Preset verteilen.

<img alt="Skill-Manager mit installierten und mitgelieferten Skills" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/_screenshots/skills/manager-installed-tab.png" width="720">

→ [Skills-Dokumentation](https://luker.cups.moe/features/skills/)

### CardApp Studio & AI Card Editor — Karten im Dialog mit einer KI bearbeiten

Eine vollwertige IDE für Charakterkarten mit CodeMirror-6-Editor, KI-Chat-Panel und diff-basierter Freigabe für jedes Änderungspaket. Normale Karten bekommen den Popup-Editor; Karten mit eingebetteter **CardApp** — einer in der Karte gehosteten Mini-Anwendung — öffnen sich im vollständigen Studio mit Dateibaum, Live-Vorschau und Verlauf.

![CardApp-Studio-Demo](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/cardapp-studio-demo.gif)

→ [Card Editor Assistant](https://luker.cups.moe/features/card-editor/) · [CardApp Studio](https://luker.cups.moe/features/card-editor/studio)

### Preset Assistant — ein Preset aus einer Beschreibung erstellen

Sag dem Assistenten, was ein Chat-Completion-Preset tun soll. Er arbeitet mit dir Schritt für Schritt per Diff am Preset, bis es deinen Anforderungen entspricht — liest Parameter, bearbeitet Prompt-Einträge und vergleicht mit einem Referenz-Preset. Derselbe Workflow deckt auch Orchestrator-Presets ab.

<img alt="Preset Assistant" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png" width="720">

→ [Preset-Assistant-Dokumentation](https://luker.cups.moe/features/preset-assistant)

### Native Android-APK — die komplette Plattform auf deinem Smartphone

Das Luker-Backend läuft *innerhalb* einer Android-App. Installiere die APK, öffne sie, und du bekommst den kompletten Server samt UI auf einem einzigen Gerät — kein Termux, keine manuelle Node-Installation, kein Port-Forwarding. Der Backup-ZIP-Import im Erststart-Bildschirm macht die Migration schmerzlos.

![Android-APK-Demo](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/android-apk-demo.gif)

→ [Android-App-Anleitung](https://luker.cups.moe/guide/android)

### Search Tools — Charaktere können im Web suchen

Gib dem schreibenden LLM ein Live-Websuchwerkzeug (DuckDuckGo, SearXNG, Brave) oder lass vor der Generierung einen Such-Agenten laufen, der die Ergebnisse in die Weltinfos schreibt, bevor die Antwort beginnt. Gestützt auf echte Suchmaschinen, nicht nur einen Blick in die Trainingsdaten.

→ [Search-Tools-Dokumentation](https://luker.cups.moe/features/search-tools)

### LAN Sync

Koppel zwei Luker-Instanzen im selben Netzwerk. Chats, Karten, Weltinfos und Einstellungen werden zwischen ihnen synchronisiert, sodass Desktop und Smartphone Schritt halten, ohne etwas in eine Cloud hochzuladen.

→ [LAN-Sync-Anleitung](https://luker.cups.moe/improvements/lan-sync)

### Chats zusammenführen & aufteilen

Teile einen langen Chat an beliebiger Stelle oder führe zwei Chats zu einem zusammen; der Verzweigungsverlauf bleibt konsistent. Nützlich, wenn eine Szene ausgeufert ist und du die interessanten Teile abzweigen willst, ohne den Rest zu verlieren.

<img alt="Chats zusammenführen und aufteilen" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/chat-merge-split/07-split-dialog-three-segments.png" width="720">

→ [Chat-Verwaltung](https://luker.cups.moe/basics/chat-management)

### TTS — NPC-Dialogen die passende Stimme zuordnen

Wenn TTS aktiviert ist, kann jede zitierte Zeile einer Antwort mit der Stimme des jeweiligen Sprechers abgespielt werden. Ein Hintergrund-Durchgang ermittelt, wer welche Zeile spricht — NPCs, die er entdeckt, erscheinen automatisch in der Stimmenzuordnung, und Namen, die du vorab hinzufügst, werden schon beim ersten Abspielen erkannt.

<img alt="Abspiel-Buttons für einzelne Zitate in einer Chat-Nachricht" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/tts-npc-attribution/03-inline-buttons-zoom.png" width="678">

→ [TTS — NPC-Dialogen die passende Stimme zuordnen](https://luker.cups.moe/features/tts-npc-attribution)

### Modell wechseln, Prompt-Setup behalten

In SillyTavern hängen API-Verbindungen und Chat-Completion-Presets zusammen, sodass ein Modellwechsel deine Prompt-Konfiguration mitzieht. Luker entkoppelt beides: Modell wechseln, ohne das Prompt-Setup neu aufzubauen; Preset wechseln, ohne die API-Schlüssel anzufassen.

### Tab schließen — die Antwort wird weitergeschrieben

Die Generierung läuft auf dem Backend und wird per WebSocket an die UI gestreamt. Tab neu laden, Laptop zuklappen, WLAN verlieren — die Antwort wird auf dem Server weitergeschrieben und verbindet sich automatisch wieder mit deiner UI, sobald du zurück bist. Nichts geht verloren, nichts muss neu starten.

→ [Backend-Speicher & Lebenszyklus](https://luker.cups.moe/improvements/backend-storage)

---

Eine lange Reihe kleiner Annehmlichkeiten rundet das Ganze ab — Gruppen für Presets und Prompts, Persona-Sperren pro Chat, Rückgängig-Toasts, ein Trace, der zeigt, welche Weltinfo-Einträge ausgelöst wurden und warum, sowie Modelllisten, die live vom jeweiligen Anbieter abgerufen werden. All das ist in der [Dokumentation](https://luker.cups.moe) beschrieben.

## Screenshots

<table>
  <tr>
    <td width="50%"><img alt="Memory-Graph-Inspektor" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/memory-graph/memory-graph-view.png"></td>
    <td width="50%"><img alt="Orchestrator-Runtime-Trace" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/orchestrator/orch-runtime-trace.png"></td>
  </tr>
  <tr>
    <td width="50%"><img alt="CardApp-Studio-Arbeitsbereich" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/cardapp-studio/studio-overview.png"></td>
    <td width="50%"><img alt="Preset Assistant" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png"></td>
  </tr>
</table>

## Erste Schritte

- **Desktop (Node.js)** — `git clone https://github.com/funnycups/Luker.git && cd Luker && npm install && node server.js`. Erfordert Node.js 24 oder neuer. → [Erste Schritte](https://luker.cups.moe/guide/getting-started)
- **Android APK** — lade die neueste signierte APK von der [Releases](https://github.com/funnycups/Luker/releases)-Seite herunter und installiere sie. → [Android-App-Anleitung](https://luker.cups.moe/guide/android)
- **Docker** — `docker compose up` mit der Compose-Datei im Repository-Stammverzeichnis. → [Erste Schritte](https://luker.cups.moe/guide/getting-started)

## Umstieg von SillyTavern?

Luker ist zu 100 % in beide Richtungen datenkompatibel mit SillyTavern. Kopiere deinen `data/`-Ordner herüber, und du bist fertig — Charakterkarten, Weltinfos, Presets, Chats, Personas, Einstellungen. Globale Drittanbieter-Erweiterungen liegen außerhalb von `data/`, in `public/scripts/extensions/third-party/`, also kopiere sie separat. Wenn du zurückwechseln willst, kopierst du ihn in die andere Richtung; Luker-exklusive Daten (Memory Graphs, Orchestrator-Konfigurationen) liegen in separaten State-Dateien, die SillyTavern ignoriert. **Mach vor der Migration trotzdem ein Backup.**

→ [Migrationsanleitung](https://luker.cups.moe/guide/migration)

## Community & Feedback

- Fehlerberichte und Funktionswünsche: [GitHub Issues](https://github.com/funnycups/Luker/issues)
- Lies die Dokumentation, bevor du ein Issue eröffnest: [luker.cups.moe](https://luker.cups.moe)

## Mitwirken

Pull Requests sind willkommen. Sieh dir [CONTRIBUTING.md](../CONTRIBUTING.md) an und suche bitte nach bestehenden Issues, bevor du ein neues eröffnest.

## Lizenz und Danksagungen

Lizenziert unter **AGPL-3.0**. Dieses Programm wird in der Hoffnung verteilt, dass es nützlich ist, jedoch OHNE JEGLICHE GARANTIE; siehe die [GNU Affero General Public License](../LICENSE) für Details.

- Basiert auf **SillyTavern** von Cohee, RossAscends, Wolfsblvt und 300+ Mitwirkenden: <https://github.com/SillyTavern/SillyTavern>
- [TavernAI](https://github.com/TavernAI/TavernAI-v1) 1.2.8 von Humi (MIT-Lizenz)
- Teile von CncAnons TavernAITurbo-Mod werden mit Genehmigung verwendet
- Visual Novel Mode inspiriert von [PepperTaco](https://github.com/peppertaco/Tavern/)
- Noto-Sans-Schriftart von Google (OFL-Lizenz)
- Lexer/Parser von [Chevrotain](https://github.com/chevrotain/chevrotain) (Apache-2.0)
- Icon-Theme von [Font Awesome](https://fontawesome.com) (Icons CC BY 4.0, Fonts SIL OFL 1.1, Code MIT)
- Standard-Charakterinhalte von @OtisAlejandro (Seraphina) und @kallmeflocc
- Docker-Anleitung von [@mrguymiah](https://github.com/mrguymiah) und [@Bronya-Rand](https://github.com/Bronya-Rand)
- kokoro-js-Bibliothek von [@hexgrad](https://github.com/hexgrad) (Apache-2.0)

## Top-Mitwirkende

[![Contributors](https://contrib.rocks/image?repo=funnycups/Luker)](https://github.com/funnycups/Luker/graphs/contributors)
