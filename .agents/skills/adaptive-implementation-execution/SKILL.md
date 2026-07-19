---
name: adaptive-implementation-execution
description: Use when the user explicitly requests adaptive implementation execution, or when the task clearly requires this package's serial high-model-to-standard-model implementation workflow with high-model re-entry for new structural decisions.
# Copyright (c) 2026 suusanex (GitHub UserName)
# SPDX-License-Identifier: CC-BY-4.0
# License: https://creativecommons.org/licenses/by/4.0/
# Source: https://github.com/suusanex/coding_agent_plan_and_verify_process
---

# Adaptive Implementation Execution

この skill が選択された後、通常の Plan Mode output、手書き Plan、repository-tracked Plan、Issue 内の実装計画を入力に、実装中の evidence に基づいて HIGH_MODEL と STANDARD_MODEL を直列に切り替える implementation-only flow です。package が導入されているだけで、repository 内の実装作業へ自動適用しません。

Plan Coverage Lite / Standard / Full Coverage の縮小版ではありません。Plan Coverage artifacts、change-risk-triage、runtime contract、test design、coverage ledger、residual decision は必須入力にしません。

## Parent role

parent / router は次だけを担当します。

- input の source of truth と最低限の Implementation Intent を確認する
- agent を直列に起動する
- verdict と handoff contract を検証する
- re-entry 時に元 intent と handoff を保持する
- 最終状態と未検証事項を集約する

parent / router は production code や tests を横取りして直接実装しません。write-heavy agent を並列に起動しません。

## Accepted inputs

- Codex 等の通常 Plan Mode output
- repository-tracked Plan file
- caller が直接渡した短い実装計画
- Issue / prompt 内の goal、scope、acceptance、constraints

内部では必要な項目だけを次の形で解釈します。

```yaml
implementation_intent:
  goal:
  scope:
  non_goals:
  acceptance:
  constraints:
  validation:
  plan_reference:
```

`goal`、`scope`、`acceptance` は必須です。`non_goals`、`constraints`、`validation`、`plan_reference` は任意です。未指定時は次のように扱います。

- `non_goals`: source request から明確に導ける場合だけ記録し、それ以外は `Not specified` とする。existing code から scope を狭めない
- `constraints`: user request または repository instructions が強制する内容だけを記録する
- `validation`: repository standard から推定できる
- `plan_reference`: source request から特定できる場合だけ記録する

長い正規化 artifact を常に作成しません。最低限、何を変更するか、scope、完了条件を判断できれば inline intent のまま進めます。

入力不足によりこの3点を判断できない場合は、内部設計を推測せず `REPLAN_REQUIRED` または `HUMAN_DECISION_REQUIRED` で停止します。

任意 template は `refs/intent.md` です。

## Required execution order

```text
ordinary Plan / short implementation intent
  -> high-implementation-starter [HIGH_MODEL]
       -> READY_FOR_STANDARD_COMPLETION
            -> standard-implementation-completer [STANDARD_MODEL]
                 -> COMPLETED
                 -> NEEDS_HIGH_MODEL_REENTRY
                      -> high-implementation-starter [HIGH_MODEL]
       -> CONTINUE_HIGH_IMPLEMENTATION
       -> COMPLETED_BY_HIGH_MODEL
       -> REPLAN_REQUIRED
       -> HUMAN_DECISION_REQUIRED
       -> BLOCKED
```

すべての非自明な implementation は `high-implementation-starter` から開始します。課題全体が small-bounded、low risk、少数ファイルであることだけを理由に STANDARD_MODEL へ直行してはいけません。

## Step 1: Validate the intent

1. repository instructions と user constraints を確認する。
2. goal、scope、acceptance を抽出する。constraints、non-goals、validation expectation、Plan reference があれば併せて抽出する。
3. missing information が implementation detail か、product / scope / acceptance decision かを分ける。
4. product / scope / acceptance が不足する場合は実装を開始しない。

validation expectation が明示されていない場合は repository standard を採用し、agent input と最終出力に `Validation expectation: inferred from repository` と記録します。

Plan Coverage artifacts が存在しないことは blocker ではありません。caller が binding artifact として明示した場合だけ追加 input として渡します。

Plan Coverage、Behavior Case、slice、runtime-contract、test-point、implementation-contract、または gap binding artifact が supplied input に含まれる場合は、各 implementation owner に canonical agent contract の `Implementation Self-Map Delta` を返させます。orchestrator は phase ごとの delta を stable Change ID で `plans/<slug>-implementation-execution.md` の canonical `Implementation Self-Map` に集約します。binding artifacts がない standalone run では、この traceability extension は evidence-backed `N/A` でよく、Plan Coverage artifact を新規要求しません。

## Step 2: Start with HIGH_MODEL

`high-implementation-starter` custom agent / subagent を一度だけ起動し、完了するまで待ちます。

渡すもの:

- original Plan または Implementation Intent
- repository instructions
- current worktree status
- relevant source pointers already known
- validation expectations
- previous re-entry handoff when resuming

HIGH_MODEL は code を読み、production code / tests を編集し、focused verification を行います。事前文書だけで `direct implementation` と `shape-then-complete` を分類しません。

## Step 3: Validate the HIGH_MODEL verdict

### COMPLETED_BY_HIGH_MODEL

HIGH_MODEL が scope 内の acceptance item をすべて `Complete` とし、各 item の実装または validation evidence、checks、remaining uncertainty を報告した場合に受理します。未完了 item があれば実装継続または適切な stop verdict を求めます。小規模課題でも、安全な delegation point がなければこの経路で構いません。

### CONTINUE_HIGH_IMPLEMENTATION

同一 run で継続可能なら agent にそのまま続行させます。parent へ細かく返して再起動しません。resume、別 run、または execution boundary が必要な場合だけ state verdict として受理します。

### READY_FOR_STANDARD_COMPLETION

`refs/handoff.md` の必須 field がすべて存在し、次を満たす場合だけ受理します。

- representative production path / wiring evidence がある
- production path / wiring、test harness、test seam、mock boundary の applicability evidence がある。該当しない concern は `N/A` と理由がある
- focused verification が実行済み
- scope 内の全 acceptance item と現在の status / evidence が列挙されている
- `Blocked` の acceptance item が存在しない
- すべての `Incomplete` acceptance item が1件以上の `Remaining work` Work ID に対応している
- すべての `Remaining work` row が1件以上の `Incomplete` acceptance item に対応している
- すべての `Complete` acceptance item に implementation または validation evidence がある
- Acceptance status の mapping と Remaining work の acceptance item(s) が双方向に一致している
- locked decisions が明示されている
- remaining work が file / symbol / expected behavior 単位
- allowed edit surface が明示されている
- high-model re-entry triggers が明示されている
- 残作業に新しい構造判断がない

不足がある場合は STANDARD_MODEL へ渡さず、HIGH_MODEL に handoff 修正または実装継続を求めます。

### Stop verdicts

`REPLAN_REQUIRED`、`HUMAN_DECISION_REQUIRED`、`BLOCKED` は理由、既実装、worktree state、次に必要な input を保持して停止します。

## Step 4: Delegate bounded completion

`READY_FOR_STANDARD_COMPLETION` のときだけ `standard-implementation-completer` を起動します。

渡すもの:

- original Plan / Implementation Intent
- complete Implementation Completion Handoff
- current diff / worktree status
- repository instructions

HIGH_MODEL と STANDARD_MODEL を同時に起動しません。STANDARD_MODEL は completion scope と allowed edit surface だけを変更します。

## Step 5: Handle STANDARD_MODEL result

### COMPLETED

completion scope、validation results、locked-decision compliance に加え、scope 内の全 acceptance item が `Complete` で evidence を持つことを確認します。未完了 item があれば `COMPLETED` を受理しません。これは implementation completion であり final review 完了ではありません。

### NEEDS_HIGH_MODEL_REENTRY

STANDARD_MODEL の `High-model Re-entry Handoff`、元の Implementation Intent、元の locked decisions、current worktree state を保持して `high-implementation-starter` を直列に再実行します。

STANDARD_MODEL に redesign を続行させません。re-entry 後の HIGH_MODEL は actual code と new evidence を読み、必要な設計判断と実装を行います。1 回 re-entry した後は HIGH_MODEL が完了まで担当することを既定とします。

re-entry state は次の順に更新します。

1. 初回 HIGH_MODEL handoff は `reentry_count: 0`、`previous_reentry_trigger: N/A`、`delegation_surface_reduced: N/A` とする。
2. STANDARD_MODEL は `NEEDS_HIGH_MODEL_REENTRY` で、`Trigger` に今回の trigger、`reentry_count` に incoming value + 1、`previous_reentry_trigger` に incoming value を設定する。
3. HIGH_MODEL が再委譲する場合、re-entry handoff の `reentry_count` を維持し、`previous_reentry_trigger` にその `Trigger` を設定し、`delegation_surface_reduced: Yes` とする。

再委譲できるのは、前回 handoff と比較して `Remaining work` と `Allowed edit surface` の両方が厳密に縮小し、re-entry handoff の `Trigger` がその `previous_reentry_trigger` と異なり、`delegation_surface_reduced: Yes` を evidence 付きで記録できる場合だけです。それ以外は HIGH_MODEL が実装を継続します。

### Other stop verdicts

`REPLAN_REQUIRED`、`HUMAN_DECISION_REQUIRED`、`BLOCKED` は変更内容と blocker を保持して停止します。

## Handoff persistence

- `inline`: 同一 run / 同一 parent orchestration 内の通常 handoff。既定値。
- `tracked`: resume、別 thread、別 model、別作業者へ渡す場合。

tracked handoff の推奨 path は `plans/<slug>-implementation-completion-handoff.md` です。実コードを source of truth とし、handoff は後段の自由度と re-entry trigger を伝える短い実行情報に留めます。

## Verification boundary

各 implementation agent に、変更へ関連する build、focused test、lint、format、type check を可能な範囲で要求します。実行できない check は理由と未検証範囲を明記します。

この skill は final code review、総合 architecture review、human review、独立 verification の代替ではありません。最終出力には必ず `Final review status: Not performed by this flow` または、caller が別工程で実施した actual status を記録します。

## Final output

- source Plan / Implementation Intent
- route taken
- agent verdict sequence
- implementation owner by phase
- files changed
- validation performed and results
- acceptance status table with evidence for every in-scope item
- tracked handoff path, if any
- re-entry events, if any
- remaining work / human-required work / blockers
- final review status
