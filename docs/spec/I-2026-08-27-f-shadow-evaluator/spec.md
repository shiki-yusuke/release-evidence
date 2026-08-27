# spec: release-evidence-shadow — F shadow 評価器（offline replay 専用）

intent: I-2026-08-27-f-shadow-evaluator / risk: medium（CI workflow に触れる場合は high に自動昇格）
設計正本: sol 裁定 2026-08-27（`~/ai_bus/logs/sol-f-evaluator-design-20260827.log`、must 全採用）

## 何を作るか

promotion-receipt/v0 の pre_promotion 述語6種（artifact_identity / review_admissibility /
verification_coverage / preview_verified / rollback_target_valid / privilege_boundary）を
**決定論的に評価し、記録するだけの** 独立 bin `release-evidence-shadow` を本 repo に追加する。
gate はしない。LLM 呼び出しは 0。live 導入は cohort-2 完了+データ lock 後の別 PR（本タスクでは作らない）。

## 採用済み設計（sol must、変更する場合は deviation 記録が必要）

### 配置
- `src/shadow/`（input.ts / resolver.ts / evaluate.ts / serialize.ts / reasons.ts）+
  `src/shadow-cli/main.ts`。既存 `release-evidence` CLI のサブコマンドにしない（別 bin）
- 既存 core からの再利用は可。ただし deploy adapter / network / credentials を shadow から
  import しない

### I/O 契約（実装内 draft schema、契約昇格は replay 実績後）
- 入力 = `shadow-evaluation-input/v0`: sealed bundle + exact record 群 + evaluation_cut +
  policy/contract pin。入力ポインタの解決先は sol 裁定の表に従う
- 出力 = `shadow-evaluation/v0` wrapper: `evaluation_status = evaluated | unknown | invalid_input`。
  evaluated かつ receipt 必須 subject が全て実在するときだけ schema-valid な `candidate_receipt`
  を内包（verdict は candidate_receipt.verdict が唯一。wrapper に第二の verdict enum を持たせない）
- `candidate_receipt.predicates` は `predicate_observations` の機械的 projection（別ロジックで再計算しない）
- **出力自身も evidence-closed**: `input_manifest.digest = sha256(JCS(sorted exact record refs))`、
  `record_digest = sha256(JCS(record without record_digest))`。path/ID だけでは解決済み扱いにしない

### unknown の分類（receipt の status 語彙は不変）
- 理由コード（closed、{code, params}）: `unknown_structural` / `not_yet_recorded` /
  `lane_ref_omitted`（params.omission_code に既存 closed code）/ `referent_unresolved` /
  `not_applicable_by_policy`
- 入力エラーは別 namespace（`record_invalid` / `digest_mismatch` / `unsupported_record_version`）
  → `evaluation_status=invalid_input`、receipt は生成しない
- 非 lane release の verification_coverage は applicability=applicable / status=unknown /
  reason.code=lane_ref_omitted（not_applicable に落とさない）
- selection_manifest 不在 → evaluation_status=unknown、candidate_receipt=null。
  ゼロ digest・空 manifest・現在からの逆算は禁止

### 決定論
- core API は `evaluate(input): ShadowEvaluation` の純粋関数。evaluation_cut / policy / risk /
  contract pin は全て入力。`evaluated_at = evaluation_cut`。receipt_id は input manifest digest +
  evaluator version + phase から決定的導出
- shadow core で禁止: Date.now() / 引数なし new Date() / Math.random() / crypto.randomUUID() /
  process.env / fs・network・process 実行（resolver 層だけがファイルを読む）
- 出力は JCS canonical bytes + LF。predicate 順は契約の closed order、refs は明示 sort
- evaluation_cut より後の event/record は読まない（hindsight leakage 禁止）

### live 化の構造的防止
- bin 名 `release-evidence-shadow`、mode は literal `shadow_only`
- verdict（ineligible/abstained/unknown）で CLI は exit 0。非0 は malformed input / tool failure のみ
- `--enforce` / `--fail-on-*` / `--promote` / `--approve` を実装しない
- `cohort-2-live-lock.json`（state:"locked"）を repo に置き、locked 中に deploy/gate 系 module
  から src/shadow/** への import が1件でもあればテストが fail する（architecture test。
  可能なら vitest 内で実装し .github/workflows は触らない）

## テスト（最小セット、sol E）
1. conformance parity: vendored 契約 fixtures（review-findings / promotion-receipt /
   release-approval composite / release-evidence）全件
2. 実 replay: lane-backed 全解決 / selection manifest 不在→unknown_structural / 非 lane→
   lane_ref_omitted / pointer あり record なし→referent_unresolved / cut 後 record→not_yet_recorded
3. 改ざん注入: bundle 1 byte / finding claim / verification record / pointer digest 差し替え /
   candidate receipt の predicate 欠落・重複 / shadow output の record_digest 差し替え
4. 決定論: 2プロセス byte 比較（TZ / locale / key order / record order を変えて cmp）

## 契約欠陥を見つけた場合（freeze-after-exercise）
evaluator 側に例外 allowlist を入れない。failing replay pack を保存 → 実装バグか契約欠陥かを
differential で切り分け → 契約欠陥なら playbook に draft revision + fixtures を出し、merge・
re-vendor 後に実装を再開する。既知: receipt が preview event / rollback history を束縛できない
点は G 前の contract blocker（本タスクでは wrapper の input_manifest で閉じ、契約変更はしない）。

## 非目標
- live gate / approval consumer / deploy 統合（cohort-2 lock 前は作らない）
- selection_manifest の契約化（既知 open question のまま）
- receipt 契約自体の変更
