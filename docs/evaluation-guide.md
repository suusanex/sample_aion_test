# Aion Prompt API 評価ガイド

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
