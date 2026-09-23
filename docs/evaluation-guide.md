# Aion Prompt API 評価ガイド

## 2026年9月 再計測手順

この手順は `main` のコミット `8415be39967257fd56f75b98053e9c56a19ea021` を基準に、2026年7月の評価ケースと同じ24件を再実行するためのもの。評価ケースのID・本文・分類・サイズは変更しない。Issue #1 のPhase 1の範囲に限り、OpenAI互換API化とOpenClaw連携は行わない。

### Codex側で確認済み

- .NET 10用の `dotnet restore`、`dotnet build`、`dotnet test` が成功。
- `npm ci --prefix tests` とPlaywrightテスト13件が成功。fake `LanguageModel`を用いたブラウザテストで、JSON/Markdownダウンロードも確認済み。
- ASP.NET Coreアプリの起動とlocalhostのHTTP 200を確認。配信された評価ケースJSONは24件。
- 2026年7月20日のJSON/Markdownは比較基準として保持する。JSONの実行記録は24ケース中14件で、10ケース分は未記録。

### 人手で実施する再計測

1. **ブランチとコミットを確認する。** `main` の上記コミット、またはそのコミットを含む後続の承認済み `main` を使う。GitHubのリポジトリを取得する。

   ```powershell
   git clone https://github.com/suusanex/sample_aion_test.git
   cd sample_aion_test
   git switch main
   git pull --ff-only
   git rev-parse HEAD
   ```

   すでにclone済みなら `git status --short --branch` でローカル変更を確認し、必要なら `git pull --ff-only` する。再計測時のcommit SHAを結果と一緒に控える。

2. **SDKとNode.jsを確認する。** 安定版 .NET 10 SDKとNode.js/npmを用意し、次で確認する。Node依存は `tests/package-lock.json` に固定されている。

   ```powershell
   dotnet --list-sdks
   dotnet --info
   node --version
   npm --version
   ```

3. **復元、ビルド、テストを実行する。** Chromiumが未導入の場合に限りPlaywrightのブラウザーもインストールする。

   ```powershell
   dotnet restore AionTest.slnx
   dotnet build AionTest.slnx --no-restore
   dotnet test AionTest.slnx --no-build --no-restore
   npm ci --prefix tests
   npx --prefix tests playwright install chromium
   npm test --prefix tests
   ```

4. **アプリを起動する。** このPowerShellウィンドウは起動中そのままにしておく。

   ```powershell
   dotnet run --project src/AionTest.Web
   ```

   表示された `https://localhost:...` または `http://localhost:...` を次のEdgeで開く。アプリが表示されない場合は起動ログとURLを確認する。

5. **Aion用Edgeを準備する。** Edge DevまたはCanaryを使う。現在の公式案内ではAionは150.0.4070以降。ブラウザーの `edge://settings/help` でチャネルと完全なバージョンを確認する。

6. **Prompt APIとプレリリースモデルを有効にする。** `edge://flags` を開き、Prompt APIのflagと `Enable prerelease on-device language model` をEnabledにし、Edgeを再起動する。flag名や提供状況が変わった場合は手順を推測で置き換えず、公式Prompt API文書と実際の画面を記録する。

7. **Aionモデルを確認する。** `edge://on-device-internals` のModel Statusでモデル名が `Aion-1.0-Instruct` であることを確認する。同画面からDevice performance classも記録する。Aion名を確認できなければ実モデル評価を開始せず、確認できなかった状態を記録する。モデルの初回取得が必要ならアプリの「モデルとセッションを準備」を押し、ダウンロード完了まで待つ。

8. **環境情報を記録する。** Windowsの「設定 > システム > バージョン情報」でWindowsエディション、バージョン、OS build、CPU、搭載RAMを確認する。GPUとNPUはWindowsタスクマネージャーの「パフォーマンス」またはデバイスマネージャーで名称を確認する。Device performance class、Aion確認結果、使用したflag、Edge channel/versionも控える。アプリの「実行環境」欄にEdge、OS、CPU/RAM/GPU/NPU、device class、モデル確認を入力する。欄に収まらない詳細、Windows build、flagの状態、モデルbuild/識別子（画面に表示がある場合のみ）は人手メモにも記載する。表示されないモデル識別子は推定しない。

   ブラウザーのAPI availabilityと `navigator.onLine` は実行ごとに記録される。モデル名、モデルbuild、GPU/NPU情報はAPIから推測せず、画面で確認できたものだけ人手入力する。

9. **24ケースを同じ条件で実行する。** 新しいEdgeタブでアプリを開いて、過去実行がsessionStorageから混ざらない状態にする。`evaluation-cases.json` の全24 IDを上から順に選ぶ。各ケースについて、展開された指示と入力を編集せずに送信し、完了または失敗が記録されたことを確認してから次へ進む。system prompt、streaming設定、temperature/topKの利用有無を全ケースで固定する。7月と同じ既定system promptおよびstreaming有効を推奨する。temperature/topKが現行Edgeで利用可能なら値を記録し、非対応なら無効のままにする。24件の実行後、表示される記録件数とケースIDを照合する。

10. **JSONとMarkdownを保存する。** 「JSONをダウンロード」と「Markdownをダウンロード」をそれぞれ押す。ダウンロード先の既存ファイルに上書きしないよう、ファイル名に付く実行時刻を確認する。もし同名があれば、ダウンロード時に別名を付ける。

11. **成果物を保管する。** 両方のファイルをリポジトリの `results/` に保存する。新しい `aion-prompt-evaluation-<timestamp>.json` と `.md` の2ファイルにし、2026-07-20の既存2ファイルは変更・置換しない。実行したcommit SHAと、必要なら手動メモに含めた画面証跡を一緒に保管する。

12. **失敗時に確認する。** APIが見つからない場合はEdgeチャネル、Prompt API flag、再起動を確認する。availabilityがunavailableの場合はAion flag、端末適合性、`edge://on-device-internals` のModel Statusを確認する。downloadable/downloadingから進まない場合は従量課金接続、ネットワーク、モデルの取得状態を確認する。作成・生成エラーはJSONのerror欄とEdge DevTools Consoleを保存する。Aionモデル名を確認できない記録はAionでの成功結果として扱わない。

### API仕様上の注意（2026年9月確認）

- `LanguageModel.availability()`、`LanguageModel.create()`、`session.prompt()`、`session.promptStreaming()`、`monitor`の`downloadprogress`イベントとloaded/total、AbortControllerによる生成中断、`session.destroy()`は現行公式文書に記載があり、既存ラッパーの使い方と整合する。
- 現行公式Prompt API文書に `LanguageModel.params()`、temperature、topKの記載は見当たらない。アプリは `params()` が実際に存在して妥当なmetadataを返したときだけ欄を有効にし、それ以外ではnull/未対応として扱う。APIから存在を推測せず、現在のEdgeで利用できた場合は実環境として記録する。
- 現行文書ではAionは引き続きプレリリース扱い。Edge Canary/Dev 150.0.4070以降、専用flagを有効化し、on-device-internalsでモデル名を照合する条件に変更は確認できなかった。最新チャネルの動作や個別端末の利用可否は実機確認が必要。
- Prompt APIは開発者プレビュー。オンライン/オフライン、temperature/topKの実対応、モデルbuildの詳細な識別情報、device classとハードウェア別の品質・速度は今回の自動テストでは確定しない。

## 目的と境界

このアプリは Edge 組み込みモデルの実験を再現可能に記録するためのものであり、品質や速度の合格基準を設けない。ASP.NET Core サーバーからモデルを呼び出さず、ブラウザーの Prompt API を直接使う。Aion であることは API 応答から推測せず、`edge://on-device-internals` で人手確認する。

## 実施手順

1. Edge の版、Prompt API と on-device language model のフラグ、Model Status、Device performance class を確認する。
2. 画面の実行環境欄へ、確認した Edge、OS、CPU/RAM/GPU、device class、モデル確認結果を転記する。
3. `evaluation-cases.json` からケースを選び、必要に応じて system prompt と対応済みパラメーターを設定する。
4. 既定のストリーミングで実行し、TTFT、合計時間、形式遵守、事実性、失敗条件を人手メモへ記録する。
5. JSON と Markdown を保存し、比較対象のモデルについても同じケースと結果形式を使う。

## 観察時の注意

- モデル未ダウンロード、従量課金接続、ハードウェア不適合、入力上限、フラグ無効は、成功例と同様に記録対象とする。
- API が token usage、CPU、GPU、メモリなどを返さない場合は数値を推計しない。必要ならタスクマネージャー等の別計測値を、人手メモと測定方法を添えて記録する。
- キャンセル済み・失敗済み応答は評価記録に残るが、後続会話の文脈には再利用しない。
- オフライン可否はこの実装から断定しない。接続を変更する検証は人手で行い、条件と観察結果を記録する。

## 既知の制約

Prompt API はプレビュー仕様であり、`params()`、`promptStreaming()`、進捗通知の形が Edge の版で変わり得る。ラッパーは `wwwroot/js/aion-app.js` の `PromptApiClient` に局所化している。仕様変更時はこのラッパーと fake を同時に見直す。
