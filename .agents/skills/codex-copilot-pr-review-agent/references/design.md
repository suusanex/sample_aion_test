# 設計

## 目的

このパッケージは、実装完了後に繰り返し発生するPRレビュー反映作業を、Codexを入口に再利用可能なワークフローとして提供する。

対象は、ローカルCodexレビュー、GitHub Copilotレビュー、PRコメント、CI状態を統合し、修正計画、実装、検証、commit/push、結果レポートまで進めるMVPである。

## 構成

- `.agents/skills/codex-copilot-pr-review-agent/SKILL.md`
  - 利用者向け入口ワークフロー。
- `.github/agents/local-reviewer.agent.md`
  - `model: "gpt-5.5"` を必須指定する読み取り専用のローカルCodexレビューagent。
- `.github/agents/review-planner.agent.md`
  - `model: "gpt-5.5"` を必須指定する読み取り専用のレビュー統合計画agent。
- `.github/agents/spark-implementer.agent.md`
  - `model: "gpt-5.3-codex-spark"` を必須指定し、計画範囲だけを実装するagent。
- `scripts/install-codex-copilot-pr-review-agent-local.cs`
  - Codex向けAPM導入を実行し、`.agent.md` front matterを原本として、対象リポジトリの `.codex/agents/*.toml` を生成・更新するFile-based app。.codex/config.tomlは変更しない。
- `scripts/collect-pr-review-context.cs`
  - GitHub CLIからPR文脈を収集するFile-based app。
- `templates/review-plan.md`
  - 修正計画テンプレート。
- `templates/review-result-report.md`
  - 結果レポートテンプレート。

## データフロー

1. GitHub CLIでPR本文、レビュー、コメントを取得する。
2. 標準ではGitHub Copilotレビューの完了を待機し、`latestReviews` / `reviews` と Pull request review comments API をpollする。
3. Copilotレビュー本文とinline comment数が安定した時点、またはtimeoutした時点の取得結果を確定する。
4. 必要に応じてチェック状態を取得する。
5. `review-context.md` と `review-context.json` を生成する。
6. `local-reviewer` がローカルCodexレビュー結果を作成する。
7. ローカルCodexレビュー結果と収集結果を `review-planner` に渡す。
8. `review-planner` が `review-plan.md` を作成する。
9. `spark-implementer` が計画範囲を実装する。
10. 検証結果とcommit/push結果を `review-result-report.md` に記録する。

`review-context.json` には `copilotReviewWait` を出力する。`status` は `reviewAndInline`、`reviewOnly`、`inlineOnly`、`none`、`timeout`、`disabled` のいずれかであり、待機時間、取得件数、timeout有無を含む。`timeout` の場合、`review-planner` はGitHub Copilotレビューを未取得として扱い、推測でコメントなしとは判断しない。

## 必須モデル指定

各agentには、次の `model` 指定を必ず記載する。

- `local-reviewer`: `model = "gpt-5.5"`、`model_reasoning_effort = "medium"`
- `review-planner`: `model = "gpt-5.5"`、`model_reasoning_effort = "medium"`
- `spark-implementer`: `model = "gpt-5.3-codex-spark"`、`model_reasoning_effort = "high"`

このリポジトリで管理する原本は `.github/agents/*.agent.md` と `.apm/agents/*.agent.md` のfront matterである。インストーラが対象リポジトリへ生成・更新する配布先設定は `.codex/agents/*.toml` だけであり、`.codex/config.toml` は利用者のプロジェクト設定として保持する。

skill配下の `scripts/`、`templates/`、`references/` はAPMの配布物とし、インストーラは上書きコピーではなく存在確認のみを行う。

## 安全性

- 収集CLIは読み取り系GitHub CLI操作だけを実行する。
- 収集CLIはGitHub上に投稿済みのレビュー情報だけを読む。`@copilot` へのレビューリクエストは行わない。
- 収集CLIは標準でGitHub Copilotレビュー完了を待機するが、実行するGitHub操作は読み取り系に限定する。
- 取得失敗時にフォールバック推測を行わない。
- 実装agentは `review-plan.md` の範囲外を変更しない。
- commit/push は検証後のゲートとして扱う。
- インストーラは対象リポジトリ全体の `.codex/config.toml` を作成・変更しない。

## MVP完了条件

- 別リポジトリまたはscratch rootへAPM導入できる。
- `codex-copilot-pr-review-agent` skillが展開される。
- `local-reviewer`、`review-planner`、`spark-implementer` が展開され、それぞれに必須の `model` が指定される。
- skill配下の `scripts/`、`templates/`、`references/` が `SKILL.md` からの相対パスで解決できる。
- GitHub CLI前提チェックが期待通り成功または失敗する。
- 安全なテストPRでPR本文、レビュー、コメントの収集まで実行できる。
- Copilotレビューが未取得またはtimeoutした場合は、`review-plan.md` に未取得時の判断が記録される。

## 初版で扱わないもの

- GitHub App開発
- Webサービス化
- DB利用
- 組織全体展開機能
- ダッシュボード
- 複雑なマルチPR制御
- `@copilot` レビューリクエストの自動送信

旧版が生成した `.codex/config.toml` の値は自動削除しない。利用者の独自設定を保護するため、不要な行の削除は内容確認後の手動移行とする。

## 独自実装の理由

PR文脈収集はGitHub CLIで取得できる情報の整形が主目的であり、BCLの `System.Diagnostics.Process` と `System.Text.Json` で十分に実装できる。追加のOSSは導入せず、配布時の依存と認証面を単純に保つ。
