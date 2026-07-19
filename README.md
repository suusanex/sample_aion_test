# sample_aion_test

Microsoft Edge の LanguageModel Prompt API をブラウザー側 JavaScript から直接利用し、Aion-1.0-Instruct の挙動を会話と共通評価ケースで記録する .NET 10 / ASP.NET Core Razor Pages アプリ。

サーバーは画面と評価ケースを配信するだけで、モデルを実行しない。実行結果はブラウザーの `sessionStorage` とクライアントダウンロードにのみ保存する。

## 起動

1. 安定版の .NET 10 SDK をインストールする。
2. 次を実行する。

   ```powershell
   dotnet restore AionTest.slnx
   dotnet run --project src/AionTest.Web
   ```

3. 表示された localhost の URL を、対象の Edge Dev または Canary で開く。

## Edge と Aion の手動確認

Prompt API は開発者プレビューであり、対応状況は Edge の版、フラグ、端末性能、接続条件で変わる。アプリはモデル名を推測表示しない。評価を始める前に以下を人手で確認して、画面の「実行環境」へ正確な結果を記録する。

1. Edge Dev または Canary のバージョンを確認する。
2. `edge://flags` で Prompt API と `Enable prerelease on-device language model` を有効にする。
3. `edge://on-device-internals` の Model Status で `Aion-1.0-Instruct` を確認する。
4. 同画面で Device performance class を確認する。

`LanguageModel` API がない、`availability` が `unavailable`、またはモデルダウンロードが進まない場合は、画面の状態とエラーを評価記録へ残す。アプリは Phi-4-mini を Aion として扱わず、モデル名を補完しない。

## 操作

- 「モデルとセッションを準備」で `LanguageModel.availability()` とセッション作成、モデルダウンロード進捗を確認する。
- system prompt、temperature、topK を変えると、モデルセッションだけを破棄する。次の送信時に完了済み会話を `initialPrompts` として再構築する。
- `LanguageModel.params()` を提供する環境だけで temperature/topK を検証して渡す。未対応環境では入力欄が無効化され、値を推測して渡さない。
- ストリーミングは既定で有効。無効にすると `prompt()` を明示使用する。ストリーミング失敗時の自動フォールバックはしない。
- セッションリセットはモデル文脈だけを破棄し、会話表示と記録を残す。会話履歴クリアは会話とモデル文脈だけを消し、記録を残す。
- キャンセル済み・失敗済み応答は表示と記録に残るが、次のセッション再構築の文脈には含めない。
- タブ再読み込み後は設定、会話表示、評価記録を `sessionStorage` から復元する。モデルセッションは復元せず、次回送信時に再構築する。
- 評価ケース選択時は `instruction`、空行、`input` の順で User prompt に展開する。

## 結果と評価資産

`src/AionTest.Web/wwwroot/evaluation/cases/evaluation-cases.json` は 8 カテゴリ × short/medium/long の 24 ケースで、他のローカル LLM でも再利用できる。出力する JSON には schema version、実行 ID、時刻、手動確認済み実行環境、availability、設定、入出力、TTFT、合計時間、文字数、状態、エラー、人手メモを含める。API が返さない token/usage や CPU/GPU 値を生成しない。

JSON/Markdown の保存はブラウザーのみで実行し、ファイル名は `aion-prompt-evaluation-<timestamp>` を使用する。入力に個人情報や機密情報を含めない。

実機での Aion 評価、オフライン状態の実測、性能・品質の結論はこのリポジトリの自動テスト対象外である。実機評価の観察方法と制約は [docs/evaluation-guide.md](docs/evaluation-guide.md) を参照する。

## テスト

Playwright テストは実 Edge/Aion を変更せず、ブラウザーに fake `LanguageModel` を注入する。.NET 用の独自 runner は作らず、ブラウザー側 ES module と fake `LanguageModel` を直接検証できる公式 Node Playwright を採用する。

```powershell
npm ci --prefix tests
npx --prefix tests playwright install chromium
npm test --prefix tests
dotnet test AionTest.slnx
```
