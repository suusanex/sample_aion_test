# 使い方

## 前提

- 対象リポジトリでGitHub CLIが利用できること。
- `gh auth status` が成功すること。
- File-based appsを実行できる .NET SDK が利用できること。
- 対象リポジトリの `AGENTS.md`、README、ビルド手順、テスト手順を確認すること。

## 基本フロー

### レビュー前準備

1. 対象リポジトリで作業ブランチ、merge先base branch、未コミット変更、push状態、PR有無を確認する。
2. 作業ブランチがない場合は、対象リポジトリのルールに従って作成する。
3. 未コミット変更がある場合は、PRに含める範囲を確認してcommitする。
4. head branchがremoteへpushされていない場合はpushする。
5. PRが存在しない場合は、merge先base branchとhead branchを確認してPRを作成する。PR作成できない場合は人手での作業が必要として止める。
6. PR番号、base branch、head branchを確定してからレビュー文脈収集へ進む。

### レビュー実行

1. PRレビュー文脈を収集する。
2. `local-reviewer` で、PRの差分、つまりbase branchとhead branchの差分だけを対象にローカルCodexレビューを行う。
3. Copilot自動レビューが有効な場合は、収集CLIが標準で完了を待機する。無効な場合は、ユーザーが事前にCopilotレビューをリクエストする。
4. `review-planner` で統合修正計画を作成する。
5. `spark-implementer` で計画範囲を実装する。
6. テスト、lint、format、型チェックを実行する。
7. 結果レポートを作成し、必要に応じて実装修正後のcommit/pushを行う。

## 必須モデル指定

各agentは次のモデル指定を必須とする。

- `local-reviewer`: `GPT 5.5 Medium`
- `review-planner`: `GPT 5.5 Medium`
- `spark-implementer`: `GPT-5.3-Codex-Spark High`

Codex agentでは、`GPT 5.5 Medium` を `model = "gpt-5.5"` と `model_reasoning_effort = "medium"` で指定する。`GPT-5.3-Codex-Spark High` は `model = "gpt-5.3-codex-spark"` と `model_reasoning_effort = "high"` で指定する。

モデル指定の原本は `.github/agents/*.agent.md` と `.apm/agents/*.agent.md` のfront matterである。インストーラが生成・更新する配布先はエージェント固有の `.codex/agents/*.toml` だけであり、対象リポジトリの `.codex/config.toml` は変更しない。

## Copilotレビューの扱い

このMVPは、GitHub上に投稿済みのレビュー情報を収集する。スクリプトから `@copilot` へのレビューリクエストは行わない。

- Copilotレビューが取得できた場合は、ローカルCodexレビューと合わせて `review-planner` に渡す。
- Copilotレビューがtimeoutまでに見つからない場合は「未取得」として扱う。
- timeout時は「コメントなし」と判断せず、未取得として扱う。
- `review-context.md/json` の `copilotReviewWait.status` で `reviewAndInline`、`reviewOnly`、`inlineOnly`、`none`、`timeout`、`disabled` を区別する。
- 「未取得」の場合、ローカルCodexレビューのみで進めるか、人間判断へ戻すかを `review-plan.md` に記録する。

## PRレビュー文脈の収集

```powershell
dotnet run --file scripts/collect-pr-review-context.cs -- --repo owner/name --pr 123 --out .review/pr-123 --include-checks
```

出力:

- `.review/pr-123/review-context.md`
- `.review/pr-123/review-context.json`

`--include-checks` を指定すると、`gh pr checks` によるチェック状態も収集する。

収集CLIは標準でGitHub Copilotレビューの完了を待機する。待機時間やpoll間隔を変える場合は、次を指定する。

```powershell
dotnet run --file scripts/collect-pr-review-context.cs -- --repo owner/name --pr 123 --out .review/pr-123 --copilot-timeout-seconds 300 --copilot-poll-interval-seconds 10 --copilot-stable-samples 2
```

待機を無効化する場合は、次を指定する。

```powershell
dotnet run --file scripts/collect-pr-review-context.cs -- --repo owner/name --pr 123 --out .review/pr-123 --no-wait-for-copilot
```

`review-context.md/json` には `copilotReviewWait` として待機結果、待機時間、取得件数、timeout有無が記録される。

## Codexへの依頼例

```text
このPRをCodex/Copilotレビュー反映ワークフローで処理して。
repo: owner/name
pr: 123
out: .review/pr-123
```

## APM導入後の確認

インストーラは次のAPMコマンドを内部で実行し、その後にエージェント設定を補完する。

```powershell
apm install --update --target codex suusanex/codex_copilot_pr_review_agent --root <target-repo-root>
```

対象リポジトリの `apm.yml` にこのパッケージが既に登録済みの場合、インストーラは次のように既存依存を更新・再展開する。

```powershell
apm install --update --target codex --root <target-repo-root>
```

ローカルのパッケージリポジトリにあるインストーラを使って導入済みリポジトリを更新する場合は、APMの自己依存解決を避けるため、既存の `apm.yml` は維持したままローカル原本からCodex設定とskill assetを同期する。

別リポジトリまたはscratch rootへ導入する場合は、次を実施・確認する。

```powershell
dotnet run --file scripts/install-codex-copilot-pr-review-agent-local.cs -- <target-repo-root> --dry-run
dotnet run --file scripts/install-codex-copilot-pr-review-agent-local.cs -- <target-repo-root> --check-only
```

別のカレントディレクトリから実行する場合は、スクリプトをフルパスで指定できる。

```powershell
dotnet run --file D:\path\to\codex_copilot_pr_review_agent\scripts\install-codex-copilot-pr-review-agent-local.cs -- <target-repo-root> --dry-run
```

`--dry-run` でAPM dry-runと補完予定を、`--check-only` で現状との差分を確認した後、通常実行を行う。

```powershell
dotnet run --file scripts/install-codex-copilot-pr-review-agent-local.cs -- <target-repo-root>
```

- `<scratch>/.agents/skills/codex-copilot-pr-review-agent/SKILL.md` が存在する。
- `<scratch>/apm_modules/suusanex/codex_copilot_pr_review_agent/.apm/agents/local-reviewer.agent.md` のfront matterに `model: gpt-5.5` が存在する。
- `<scratch>/apm_modules/suusanex/codex_copilot_pr_review_agent/.apm/agents/review-planner.agent.md` のfront matterに `model: gpt-5.5` が存在する。
- `<scratch>/apm_modules/suusanex/codex_copilot_pr_review_agent/.apm/agents/spark-implementer.agent.md` のfront matterに `model: gpt-5.3-codex-spark` が存在する。
- インストーラ実行後も、対象リポジトリの `.codex/config.toml` は導入前の状態から変わらない。存在しない場合は作成されない。
- インストーラ実行後、対象リポジトリの `.codex/agents/local-reviewer.toml` に `model = "gpt-5.5"`、`model_reasoning_effort = "medium"`、`sandbox_mode = "read-only"` が存在する。
- インストーラ実行後、対象リポジトリの `.codex/agents/review-planner.toml` に `model = "gpt-5.5"`、`model_reasoning_effort = "medium"`、`sandbox_mode = "read-only"` が存在する。
- インストーラ実行後、対象リポジトリの `.codex/agents/spark-implementer.toml` に `model = "gpt-5.3-codex-spark"`、`model_reasoning_effort = "high"`、`sandbox_mode = "workspace-write"` が存在する。
- 同じskill配下に `scripts/collect-pr-review-context.cs` が存在する。
- 同じskill配下に `templates/review-plan.md` と `templates/review-result-report.md` が存在する。
- 同じskill配下に `references/usage.md`、`references/design.md`、`references/troubleshooting.md` が存在する。
- 対象リポジトリで `gh auth status` が期待通り成功または失敗する。

## Codexプロジェクト設定の移行

修正版のインストーラは、対象リポジトリ全体に適用される `.codex/config.toml` を作成・変更しない。旧版で生成された次の行が不要な場合は、既存の他設定を確認したうえで利用者自身が手動削除する。

```toml
model = "gpt-5.5"
model_reasoning_effort = "medium"
```

自動削除は行わない。利用者独自の設定を誤って削除しないためである。修正版の同期を再実行しても、削除済みのファイルや行は再生成されない。

## commit/push

レビュー前のcommit/pushは、PRを成立させるための必須準備として扱う。

実装修正後のcommit/pushは自動実行前提ではなく、次を確認してから行う。

- 未コミット変更に無関係な差分が混ざっていないこと。
- 関連テストが成功していること。
- 対象リポジトリの `AGENTS.md` に反していないこと。
- 人手承認が必要なリポジトリでは承認があること。
