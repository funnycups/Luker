<a name="readme-top"></a>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-dark.png">
  <img alt="Luker — 次世代ロールプレイチャットプラットフォーム" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/hero-light.png">
</picture>

<div align="center">

[English](readme.md) | [Deutsch](readme-de_de.md) | [简体中文](readme-zh_cn.md) | [繁體中文](readme-zh_tw.md) | **日本語** | [Русский](readme-ru_ru.md) | [한국어](readme-ko_kr.md)

[![GitHub Stars](https://img.shields.io/github/stars/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/forks)
[![GitHub Issues](https://img.shields.io/github/issues/funnycups/Luker.svg?style=flat)](https://github.com/funnycups/Luker/issues)
[![License](https://img.shields.io/github/license/funnycups/Luker.svg?style=flat)](../LICENSE)
[![Docs](https://img.shields.io/badge/docs-luker.cups.moe-orange?style=flat)](https://luker.cups.moe)
[![Android APK](https://img.shields.io/badge/download-Android%20APK-3ddc84?style=flat&logo=android&logoColor=white)](https://github.com/funnycups/Luker/releases)

</div>

---

Luker は次世代のロールプレイチャットプラットフォームです。起きたことをちゃんと覚えているキャラクターとチャットでき、返信のたびにディレクター率いるエージェント集団が場面を組み立て、キャラクターカードは AI と話しながら編集でき、会話の途中でキャラクターが Web を検索することもできます。

## Luker とは

Luker は大規模言語モデルとのロールプレイのために専用設計された環境です。グラフベースの長期記憶、再利用できるスキルライブラリを備えたマルチエージェント場面プランナー、AI 支援のキャラクターカードスタジオ、Preset Assistant、ネイティブな LAN Sync、そしてバックエンド全体をスマートフォン上で動かせる本物の Android アプリを搭載。すべてが 1 回のインストールに収まっており、サードパーティの拡張機能は必要ありません。

Luker は [SillyTavern](https://github.com/SillyTavern/SillyTavern) をベースに構築されており、SillyTavern との **100% のデータ互換性**を保っています。キャラクターカード、ワールド情報、プリセット、チャットは双方向にそのまま移行でき、移行コストはゼロです。

## ハイライト

### Memory Graph — キャラクターが本当に覚えている

知識グラフによる長期記憶です。あらゆる場面は、型付きのノード（キャラクター、場所、イベント、プロットライン）とそれらをつなぐリンクに抽出されます。返信のたびに想起パスがグラフをたどり、最も関連性の高い記憶を注入します。だからこそ、30 ターン後にユーザーが「廃神社への 3 番目のルート」について尋ねると、キャラクターは以前のやり取りを正確に引き出してきます。

![Memory Graph のデモ](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/memory-graph-demo.gif)

→ [Memory Graph のドキュメント](https://luker.cups.moe/features/memory-graph)

### Multi-Agent Orchestrator — ディレクター率いるエージェント集団がすべての返信を設計する

書き手の LLM が話し始める前に、自由に構成できるエージェント集団が先に動きます。蒸留役が直近のコンテキストを圧縮し、プランナーが次の場面の下書きを作り、批評役がレビューします。最終的な返信には、いつでも確認できるランタイムトレースが付いてきます。実行モードは 5 つから選べます — Spec（固定パイプライン）、Single Agent、Agenda（進行に応じてエージェントを派遣）、Loop（単一のエージェントが完了するまでツール呼び出しを反復処理する）、Director（メインエージェントとサブエージェントチームがメッセージ本文を直接執筆）です。

![Orchestrator のデモ](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/orchestrator-demo.gif)

→ [Orchestrator のドキュメント](https://luker.cups.moe/features/orchestrator/)

### Skills — 必要なときに読み込む再利用可能な知識パック

エージェントが必要なときに読み込む、再利用可能な知識パックです。執筆ルール、口調の取り決め、決まり文句を避けるためのチェックリストなど。フォーマットは Anthropic の Claude Skills と互換性があり、Claude Code 向けに書かれたスキルはそのまま Luker へ移行でき、逆方向へも移行できます。オーケストレーターのデフォルト Director プロファイルには 24 個のスキルが同梱されており、スキルはキャラクターカードやプリセットに添えて配布することもできます。

<img alt="インストール済みスキルと同梱スキルを表示したスキルマネージャー" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/_screenshots/skills/manager-installed-tab.png" width="720">

→ [Skills のドキュメント](https://luker.cups.moe/features/skills/)

### CardApp Studio と AI Card Editor — AI と話しながらカードを編集する

CodeMirror-6 エディター、AI チャットパネル、そして変更のまとまりごとに diff で承認できる仕組みを備えた、キャラクターカード用のフル IDE です。通常のカードはポップアップエディターで開きますが、**CardApp**（カード内に埋め込まれたミニアプリ）を持つカードは、ファイルツリー、ライブプレビュー、履歴を備えたフル機能の Studio で開きます。

![CardApp Studio のデモ](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/cardapp-studio-demo.gif)

→ [カード編集アシスタント](https://luker.cups.moe/features/card-editor/) · [CardApp Studio](https://luker.cups.moe/features/card-editor/studio)

### Preset Assistant — 説明からプリセットを構築する

チャット補完プリセットに何をさせたいかをアシスタントに伝えてください。あとは 1 つずつ diff を重ねながら、納得のいくまであなたと一緒にプリセットを練り上げます — パラメータを読み、プロンプト項目を編集し、参照プリセットと比較しながら進みます。同じワークフローはオーケストレーターのプリセットにも使えます。

<img alt="Preset Assistant" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png" width="720">

→ [Preset Assistant のドキュメント](https://luker.cups.moe/features/preset-assistant)

### ネイティブ Android APK — プラットフォーム全体をスマートフォンに

Luker のバックエンドは Android アプリの*中*で動きます。APK をインストールして開けば、1 台の端末で完全なサーバーと UI が手に入ります。Termux も、手動での Node インストールも、ポートフォワーディングも不要です。初回起動画面ではバックアップ ZIP をインポートできるので、移行も苦になりません。

![Android APK のデモ](https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/branding/android-apk-demo.gif)

→ [Android アプリガイド](https://luker.cups.moe/guide/android)

### Search Tools — キャラクターが Web を検索できる

書き手の LLM にリアルタイムの Web 検索ツール（DuckDuckGo、SearXNG、Brave）を持たせるか、生成前に検索エージェントを実行して、返信が始まる前に結果をワールド情報へ書き込ませることができます。本物の検索エンジンによる結果であり、学習データの記憶ではありません。

→ [Search Tools のドキュメント](https://luker.cups.moe/features/search-tools)

### LAN Sync

同じネットワーク上にある 2 つの Luker インスタンスをペアリングできます。チャット、カード、ワールド情報、設定が両者の間で同期されるので、デスクトップとスマートフォンが歩調を合わせたまま、クラウドには何もアップロードする必要がありません。

→ [LAN Sync ガイド](https://luker.cups.moe/improvements/lan-sync)

### チャットの結合と分割

長いチャットを任意のターンで分割したり、2 つのチャットを 1 つに結合したりできます。分岐履歴は一貫したまま保たれます。場面が収拾つかなくなって、残りを失わずに面白い部分だけを分岐させたいときに便利です。

<img alt="チャットの結合と分割" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/chat-merge-split/07-split-dialog-three-segments.png" width="720">

→ [チャット管理](https://luker.cups.moe/basics/chat-management)

### TTS による NPC セリフの話者割り当て

TTS を有効にすると、返信内の引用されたセリフを 1 行ずつ、それぞれの話者の声で再生できます。バックグラウンド処理がどのセリフを誰が話しているかを割り出します — 検出された NPC はボイスマップに自動で追加され、あらかじめ登録しておいた名前は最初の再生から認識されます。

<img alt="チャットメッセージ内のセリフごとの再生ボタン" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/screenshots/tts-npc-attribution/03-inline-buttons-zoom.png" width="678">

→ [TTS による NPC セリフの話者割り当て](https://luker.cups.moe/features/tts-npc-attribution)

### モデルを変えても、プロンプト設定はそのまま

SillyTavern では API 接続とチャット補完プリセットが一体で動くため、モデルを切り替えるとプロンプト設定も一緒に引っ張られます。Luker はこの 2 つを分離しました。プロンプト設定を組み直さずにモデルを差し替え、API キーに触れずにプリセットを差し替えられます。

### タブを閉じても、返信は書き続けられる

生成はバックエンド上で実行され、WebSocket で UI にストリーミングされます。タブを再読み込みしても、ノートパソコンの蓋を閉じても、Wi-Fi が切れても、返信はサーバー上で書き続けられ、戻ってきた瞬間に UI へ再接続します。失われるものも、やり直すものもありません。

→ [バックエンドのストレージとライフサイクル](https://luker.cups.moe/improvements/backend-storage)

---

その仕上げとして、プリセットやプロンプトのグループ化、チャットごとのペルソナロック、元に戻すトースト、どのワールド情報エントリがなぜ発火したかのトレース、各プロバイダーからライブで取得するモデルリストなど、小さな便利機能が数多く揃っています。これらについては[ドキュメント](https://luker.cups.moe)を参照してください。

## スクリーンショット

<table>
  <tr>
    <td width="50%"><img alt="Memory Graph インスペクター" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/memory-graph/memory-graph-view.png"></td>
    <td width="50%"><img alt="Orchestrator のランタイムトレース" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/orchestrator/orch-runtime-trace.png"></td>
  </tr>
  <tr>
    <td width="50%"><img alt="CardApp Studio のワークスペース" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/cardapp-studio/studio-overview.png"></td>
    <td width="50%"><img alt="Preset Assistant" src="https://raw.githubusercontent.com/funnycups/Luker/release/docs/public/images/preset-assistant/cpa-overview.png"></td>
  </tr>
</table>

## はじめに

- **デスクトップ（Node.js）** — `git clone https://github.com/funnycups/Luker.git && cd Luker && npm install && node server.js`。Node.js 24 以降が必要です。→ [はじめに](https://luker.cups.moe/guide/getting-started)
- **Android APK** — [Releases](https://github.com/funnycups/Luker/releases) ページから最新の署名済み APK を入手してインストールしてください。→ [Android アプリガイド](https://luker.cups.moe/guide/android)
- **Docker** — リポジトリルートにある compose ファイルを使って `docker compose up`。→ [はじめに](https://luker.cups.moe/guide/getting-started)

## SillyTavern からの移行

Luker は SillyTavern と双方向で 100% データ互換です。`data/` フォルダーをコピーすればそれで完了 — キャラクターカード、ワールド情報、プリセット、チャット、ペルソナ、設定すべて。グローバルなサードパーティの拡張機能は `data/` の外、`public/scripts/extensions/third-party/` に保存されるため、別途コピーしてください。戻したくなったら、逆方向にコピーするだけです。Luker 独自のデータ（Memory Graph、オーケストレーターの設定）は別の状態ファイルに入っており、SillyTavern はそれを無視します。**移行する前に、いずれにせよバックアップを。**

→ [移行ガイド](https://luker.cups.moe/guide/migration)

## コミュニティとフィードバック

- バグ報告・機能リクエスト：[GitHub Issues](https://github.com/funnycups/Luker/issues)
- Issue を作成する前にドキュメントをお読みください：[luker.cups.moe](https://luker.cups.moe)

## コントリビューション

プルリクエスト歓迎です。[CONTRIBUTING.md](../CONTRIBUTING.md) をご覧ください。新しい Issue を立てる前に、既存の Issue を検索してください。

## ライセンスとクレジット

**AGPL-3.0** の下でライセンスされています。本プログラムは有用であることを願って配布されていますが、いかなる保証も伴いません。詳しくは [GNU Affero General Public License](../LICENSE) をご覧ください。

- **SillyTavern** をベースに構築 — Cohee、RossAscends、Wolfsblvt ほか 300 人以上のコントリビューターによる：<https://github.com/SillyTavern/SillyTavern>
- [TavernAI](https://github.com/TavernAI/TavernAI-v1) 1.2.8 by Humi（MIT License）
- CncAnon の TavernAITurbo mod の一部を許可を得て使用
- Visual Novel Mode は [PepperTaco](https://github.com/peppertaco/Tavern/) に着想を得たものです
- Noto Sans フォント by Google（OFL ライセンス）
- 字句解析／構文解析に [Chevrotain](https://github.com/chevrotain/chevrotain)（Apache-2.0）
- アイコンテーマ by [Font Awesome](https://fontawesome.com)（アイコン CC BY 4.0、フォント SIL OFL 1.1、コード MIT）
- デフォルトキャラクターコンテンツ by @OtisAlejandro（Seraphina）および @kallmeflocc
- Docker ガイド by [@mrguymiah](https://github.com/mrguymiah) および [@Bronya-Rand](https://github.com/Bronya-Rand)
- kokoro-js ライブラリ by [@hexgrad](https://github.com/hexgrad)（Apache-2.0）

## トップコントリビューター

[![Contributors](https://contrib.rocks/image?repo=funnycups/Luker)](https://github.com/funnycups/Luker/graphs/contributors)
