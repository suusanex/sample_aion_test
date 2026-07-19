---
name: codex-copilot-pr-review-agent
description: >
  Codexを入口として、GitHub PRを作成または取得し、ローカルCodexレビューとGitHub Copilotレビューを収集し、
  統合修正計画、実装、検証、commit/push、結果レポートまで進める再利用ワークフロー。
argument-hint: "[repo owner/name] [PR number or current branch] [任意: 出力ディレクトリ]"
user-invokable: true
disable-model-invocation: false
# Copyright (c) 2026 suusanex (GitHub UserName)
# SPDX-License-Identifier: CC-BY-4.0
# License: https://creativecommons.org/licenses/by/4.0/
# Source: https://github.com/suusanex/codex_copilot_pr_review_agent
---

# Codex/Copilot PR Review Agent Skill

## 目的

このスキルは、対象リポジトリのPRに対して、CodexレビューとGitHub Copilotレビューをまとめて扱い、修正計画から実装・検証・push・結果報告までを安全に進めるための入口です。

初版MVPでは、GitHub App、Webサービス、DB、ダッシュボード、複雑な複数PR制御は扱いません。ローカルCodex、GitHub CLI、File-based appsで完結する運用を前提にします。

## 前提

- 対象リポジトリで `gh auth status` が成功すること。
- 対象ブランチがGitHubへpush可能であること。
- 対象リポジトリの `AGENTS.md`、README、ビルド手順、テスト手順を必ず優先すること。
- このパッケージは対象リポジトリ固有のビルド手順を固定しないこと。

## 標準ワークフロー

### レビュー前準備

1. 対象リポジトリの作業ブランチ、merge先base branch、未コミット変更、push状態、PR有無を確認する。
2. 作業ブランチがない場合は、対象リポジトリのルールに従って作成する。
3. 未コミット変更がある場合は、対象範囲がPRに含めるべき内容だけであることを確認し、対象リポジトリのルールに従ってcommitする。
4. head branchがremoteへpushされていない場合はpushする。pushできない場合は「人手での作業が必要: ...」として止める。
5. PRが存在しない場合は、merge先base branchとhead branchを確認してPRを作成する。PR作成できない場合は「人手での作業が必要: ...」として止める。
6. PR番号、base branch、head branchを確定してからレビュー文脈収集へ進む。

### レビュー実行

1. `scripts/collect-pr-review-context.cs` を使い、PR本文、レビュー、コメント、必要に応じてチェック状態を収集する。収集CLIは標準でGitHub Copilotレビュー完了を待機し、timeout時は未取得として記録する。
2. `local-reviewer` は必須モデル `gpt-5.5`、必須推論設定 `medium` で、PRの差分、つまりmerge先base branchとhead branchの差分だけを対象にローカルCodexレビューを作成する。
3. ローカルCodexレビュー結果と収集結果を `review-planner` に渡す。
4. GitHub Copilotレビューが未取得またはtimeoutの場合は、未取得として扱う。推測でコメントなしとは判断しない。
5. `review-planner` は必須モデル `gpt-5.5`、必須推論設定 `medium` で、ファイルを変更せず、適用可否、重複コメント、修正順序、検証方針を含む `review-plan.md` を作成する。
6. `spark-implementer` は必須モデル `gpt-5.3-codex-spark`、必須推論設定 `high` で、`review-plan.md` の範囲だけを実装する。
7. 対象リポジトリの関連テスト、lint、format、型チェックを可能な範囲で実行する。
8. 実装修正後のcommit/pushは、未コミット変更、テスト結果、対象リポジトリのルール、上位指示を確認してから実施する。
9. 変更内容、検証結果、人手で必要な作業を `review-result-report.md` にまとめる。

## 必須モデル指定

このワークフローでは、次のagent設定に `model` を必ず指定します。

- `local-reviewer`: `model = "gpt-5.5"`、`model_reasoning_effort = "medium"`
- `review-planner`: `model = "gpt-5.5"`、`model_reasoning_effort = "medium"`
- `spark-implementer`: `model = "gpt-5.3-codex-spark"`、`model_reasoning_effort = "high"`

## 補助CLI

```powershell
dotnet run --file scripts/collect-pr-review-context.cs -- --repo owner/name --pr 123 --out .review/pr-123 --include-checks
```

標準ではGitHub Copilotレビュー完了を待機する。待機を無効化する場合は `--no-wait-for-copilot` を指定する。待機時間やpoll間隔は `--copilot-timeout-seconds`、`--copilot-poll-interval-seconds`、`--copilot-stable-samples` で調整できる。

生成物:

- `review-context.md`
- `review-context.json`

## 同梱ファイル

APMパッケージとして導入された場合、このスキル配下にも同じ補助ファイルを同梱します。

- `scripts/collect-pr-review-context.cs`
- `templates/review-plan.md`
- `templates/review-result-report.md`
- `references/usage.md`
- `references/design.md`
- `references/troubleshooting.md`

## 安全ルール

- 収集処理は読み取り専用のGitHub CLI操作だけを使う。
- GitHub CLIの取得に失敗した場合、フォールバックで別情報を推測しない。
- レビュー前のcommit/pushは、PRを成立させるための必須準備として扱う。
- 実装修正後のcommit/pushは、実装・検証後の明示ゲートとして扱う。
- レビューコメントを適用しない場合は、理由を `review-plan.md` または `review-result-report.md` に記録する。
- 人手の操作が必要な場合は、「人手での作業が必要: ...」として明記する。
