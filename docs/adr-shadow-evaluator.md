# ADR: F shadow 評価器の配置

正本の設計は sol 裁定 2026-08-27（`~/ai_bus/logs/sol-f-evaluator-design-20260827.log`）。
この文書は「なぜこの repo に置くか」「なぜ shadow_only のまま止めるか」の決定だけを記録する。
詳細な I/O 契約・unknown 分類・テスト方針は
`docs/spec/I-2026-08-27-f-shadow-evaluator/spec.md` が正本。

## 決定

1. **本 repo 所有**: F shadow 評価器（`release-evidence-shadow`）は
   ai-agent-skills-playbook 側の契約ではなく、この release-evidence リポジトリが
   所有する独立 bin として実装する。promotion-receipt/v0 を評価する側であって
   契約そのものを定義する側ではないため、契約 repo に置く理由がない。
2. **shadow_only 固定**: mode は literal `"shadow_only"`。gate をしない・CLI が
   verdict で非0 exit しない・`--enforce` 系フラグを実装しない、という3点は
   実装ではなく設計として固定する（see spec.md「live 化の構造的防止」）。
3. **live 解禁の条件**: 本 PR では live 化を一切行わない。live 解禁は環境変数の
   切り替えではなく、cohort-2 のデータ lock 完了後、別 PR で次の 6 条件を
   すべて追加・確認する変更としてのみ行う（sol 裁定「F. live 解禁ゲート」の
   6 項目、そのまま採用）:
   1. cohort-2 data-lock artifact の exact digest
   2. shadow の KPI・false-allow（誤って satisfied にした事例）についての人間判定
   3. 契約（playbook 側 promotion-receipt/v0 等）の contract freeze 判断
   4. release-approval consumer の実装
   5. promotion 直前の再取得と atomic compare-and-promote
   6. shadow module とは別の live adapter
   `cohort-2-live-lock.json` の `state` を `"unlocked"` にする変更・
   architecture test（本 PR で追加）の更新は、この 6 条件を満たす live 化 PR の
   一部として行う。lock 解除だけを先行させる PR は作らない。

## 却下した代替案

- playbook 側に評価器を置く: 契約 repo が評価ロジックの実装言語・実行環境を
  持つことになり、D8（契約側の共有実装を独自再実装しない／契約と実装を分離する）
  の逆方向。却下。
- 既存 `release-evidence` CLI のサブコマンドにする: 既存 bin の exit code 規約・
  フラグ体系に shadow 専用の「非0 exit なし」制約を混在させると、将来の
  誤用（既存 CLI のフラグ慣習を shadow に持ち込む事故）のリスクが上がる。
  別 bin `release-evidence-shadow` にして境界を物理的に分離する。
