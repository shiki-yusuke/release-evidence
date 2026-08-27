# implement notes: F shadow 評価器

正本は `spec.md`（sol 裁定 `~/ai_bus/logs/sol-f-evaluator-design-20260827.log` を要約したもの）。
この文書は chunk 間の引き継ぎ専用 -- 「何が済み・何が未着手か」と、chunk 1 実装時に
下した非自明な判断だけを記録する。

## chunk 1（基盤層）: 完了

- `docs/adr-shadow-evaluator.md`: 配置 ADR（本 repo 所有 / shadow_only 固定 / live 解禁 6 条件
  を sol 裁定からそのまま転記）
- `vendor/playbook-contracts/{review-findings/v1,promotion-receipt/v0,release-approval/v0}` +
  `docs/protocols/*.md` を `~/work/ai-agent-skills-playbook` commit `f9f0c127588f60fd299a02859c9f70f0b81a9dcc`
  から byte-for-byte vendor（`git diff HEAD origin/main -- <対象dir>` で無差分確認済み）。
  `VENDORED.md` に全ファイルの sha256 を記録
- `cohort-2-live-lock.json`（`state: "locked"`）をリポジトリルートに設置
- `src/shadow/reasons.ts`: `UnknownReasonCode`（5種）/ `InputErrorCode`（3種）の closed set +
  `{code, params}` ファクトリ
- `src/shadow/input.ts`: `shadow-evaluation-input/v0` と `shadow-evaluation/v0` の TS 型 +
  実装内 draft JSON Schema（インメモリオブジェクト。ファイルには出していない -- 理由は下記
  「非自明な判断」参照）+ `validateShadowEvaluationInput` / `validateShadowEvaluation`
- `src/shadow/resolver.ts`: content-addressed record resolver（digest 検証 + `evaluation_cut`
  フィルタ）。`src/shadow/**` の中で fs に触れる唯一のファイル
- `src/shadow/serialize.ts`: `recordContentDigest` / `computeInputManifestDigest` /
  `computeRecordDigest`（JCS + sha256、self-digest は「自分自身のフィールドを除いてハッシュ」
  方式）
- テスト: `test/shadow-{reasons,input,resolver,serialize,architecture}.test.ts`
  （84 tests、typecheck/test/lint 全部 green。既存の 17 skipped テストは
  `RELEASE_EVIDENCE_CONTRACTS_DIR` 未設定による既存の pre-existing skip で、本チャンクの変更
  とは無関係）

## 非自明な判断（chunk 2/3 が踏まえるべき前提）

1. **JSON Schema はファイルではなくインメモリオブジェクトとして `input.ts` に直接書いた**。
   理由: spec.md の「shadow core で fs 禁止（resolver 層だけ許可）」を文字通り守ると、
   既存 core (`bundle.ts`/`event.ts`) の `createValidator(dir).validate(filename, instance)`
   パターン（呼び出し毎にファイルを読む）は shadow core では使えない。代わりに
   `createValidator("")` が返す `validateAgainst`（インメモリ schema オブジェクトに対して
   同期的に検証するだけで、`loadSchemaFile`/fs には一切触れない）を直接呼んでいる。
   `createValidator(schemaDir)` 自体は schemaDir を使わない限り I/O をしないため、
   ダミーの空文字列を渡している。
2. **`candidate_receipt` の schema は vendored promotion-receipt/v0 schema の手書き mirror**。
   fs を使わずに深い $ref 解決込みで vendored ファイルをそのまま検証できないため、
   `input.ts` 内の `candidateReceiptSchema` は必要フィールドの型・enum・required を
   手で複製したもの（allOf の if/then 分岐までは複製していない -- 例えば
   `applicability=not_applicable → status=unknown` の対応関係は本 schema では検証しない）。
   **chunk 2/3 で埋めるべき gap**: `evaluate.ts` が実際に `candidate_receipt` を組み立てたら、
   fs が使える層（CLI か conformance test）で vendored
   `vendor/playbook-contracts/promotion-receipt/v0/promotion-receipt.schema.json` に対しても
   必ず検証すること。ここでの手書き mirror は「明らかな構造ミスを早期に拾う」ための
   ゆるい一次防御であって、契約適合性の最終判定ではない
3. **wrapper 直下の `unknown_reasons` と `predicate_observations[].reason` は別物として設計した**。
   sol のサンプル JSON には両方が並んで出てくるが、明示的な使い分けの記述は無かったため、
   以下を仮定として採用（阻害的な不明点ではないと判断: receipt の必須要件にも
   データ損失にも影響しない、実装内部の設計選択）:
   - `unknown_reasons`（wrapper 直下）: `evaluation_status="unknown"` のとき **必須・1件以上**。
     評価全体が成立しない理由（例: selection_manifest 不在 = `unknown_structural`）
   - `predicate_observations[].reason`: 個々の predicate が `status="unknown"` のときの理由。
     `evaluation_status="evaluated"` の receipt の中で特定の predicate だけ unknown、
     というケースに対応
   - schema 上は `evaluation_status="evaluated"` のとき `unknown_reasons` は空配列必須とした
     （trade-off: 万一この仮定が違っていた場合、chunk 2 で schema のこの allOf 分岐だけ
     直せばよく、型/関数シグネチャへの影響はない）
4. **`ExactRecord.kind` の閉集合（`EXACT_RECORD_KINDS`）は spec.md に明記が無いため実装時に
   起こした**: `release_evidence_bundle` / `release_event` / `review_finding_record` /
   `verification_record` / `selection_manifest` / `policy_snapshot` / `other`。
   sol 裁定の入力ポインタ表（bundle ref / review finding ref / verification ref / policy ref /
   release ledger ref / selection manifest ref / rollback ref）をそのまま列挙した。
   `resolver.ts` は `kind` を解決に使わない（digest のみ）ので、chunk 2 でこの enum を
   増減させても resolver 側の変更は不要
5. **cut 比較は文字列比較ではなく `new Date(a).getTime() > new Date(b).getTime()`**。
   ISO タイムスタンプの小数秒桁数が揃っていない場合、素朴な文字列比較は誤った順序を返しうる
   （`"...:00Z"` と `"...:00.5Z"` を比較すると `.` が `Z` よりコード順で小さいため、
   0.5 秒後のレコードの方が「前」だと誤判定される）。`test/shadow-resolver.test.ts` に
   このケースの回帰テストを入れてある。引数付き `new Date()` は spec.md の禁止
   （`Date.now()` / 引数なし `new Date()`）に抵触しない

## chunk 2（評価コア + CLI）: 完了

- `src/shadow/evaluate.ts`: `evaluate(input): ShadowEvaluation` 純粋関数。六述語すべて実装済み
  （下記「非自明な判断」参照）。wrapper レベルの2ゲート（selection_manifest 未解決 →
  `unknown_structural`／bundle 未解決 → `referent_unresolved`、いずれも
  `candidate_receipt=null`）→ `pool.errors` があれば先に `invalid_input` で短絡 → 両ゲート通過後は
  必ず `evaluation_status="evaluated"` + 6 predicate 全部 + `candidate_receipt` を生成（個々の
  predicate が unknown でも wrapper は evaluated のまま。verdict の abstained/ineligible がその
  不確実性を表現する）
- `src/shadow/serialize.ts` 完成: `computeSemanticDigest`（R12 の3フィールド除外ハッシュ）、
  `deriveReceiptId`（input manifest digest + evaluator version + phase の決定的導出）、
  `sortInputManifestRefs`（`computeInputManifestDigest` と同じ (kind,digest) sort を wrapper 埋込み
  用に公開）、`serializeShadowEvaluation`（JCS canonical bytes + LF）を追加
- `src/shadow-cli/main.ts`: `replay --input <file> [--out <file>]` のみ。exit 0 は
  `evaluated`/`unknown` の全 verdict、exit 2 は schema-invalid input・`invalid_input`・
  candidate_receipt のフル fidelity 検証失敗・不明フラグ/コマンドのみ。`--enforce` 系は未実装
- `package.json`: `bin.release-evidence-shadow` + `imports["#contracts/*"]` →
  `./vendor/playbook-contracts/*` を追加（CLI が `import.meta.resolve` で dev/dist 両方から同じ
  相対解決をするために使用。`files` にも `vendor/playbook-contracts` を追加）
- テスト: `test/shadow-evaluate.test.ts`（述語ごとの satisfied/contradicted/unknown 分岐、4つの
  指定シナリオ全部、candidate_receipt のフル fidelity 検証、決定論2件）、
  `test/shadow-cli.test.ts`（exit code 契約、2プロセス byte 比較）、
  `test/shadow-input.test.ts` に `input_errors` 用テスト3件追加。125 tests passed / 17 skipped
  （既存の contracts dir 未設定 skip、本チャンクと無関係）、typecheck/test/lint 全部 green

## chunk 2 の非自明な判断（chunk 3 が踏まえるべき前提）

1. **`ShadowEvaluation` に `input_errors: InputError[]` を追加した（chunk 1 のスキーマ拡張）**。
   chunk 1 は `evaluation_status=invalid_input` と `InputErrorCode` namespace を定義したが、
   wrapper 自身にその理由を運ぶフィールドが無かった（`unknown_reasons` は namespace が違うため
   使えない）。`unknown_reasons` と対称的な必須フィールドとして追加し（`evaluated`/`unknown` 時は
   `maxItems:0`、`invalid_input` 時は `minItems:1`）、既存の chunk 1 テスト
   （`test/shadow-input.test.ts` の `validEvaluation()`）も合わせて更新した。これがないと
   「tool 障害/改ざん検知だが理由が記録上どこにも残らない」という、この評価器の目的そのものに
   反する状態になっていた
2. **wrapper レベルの2ゲートは「実在するか」だけを見る。kind の正しさは predicate 自身
   （主に artifact_identity）の責務**。`candidate_receipt.subject` は `input.subject` を
   そのまま転記するだけで bundle/manifest の CONTENT を読まないため、ゲートは
   `resolveByDigest !== null` だけで十分（chunk 2 指示の「必須 subject 全実在」を文字通り解釈）。
   kind が違う record が resolve された場合は `artifact_identity` が `contradicted` を返す
3. **6述語のセマンティクスは vendored 契約に定義が無いため、release-evidence/v0 の
   Bundle/ReleaseEvent 型に基づき本チャンクで新規に定義した**（契約が固定するのは predicate_id
   閉集合・evidence_refs 形状・verdict 導出式のみ、reference evaluator は存在しない）:
   - `artifact_identity`: 解決済み record の kind が `release_evidence_bundle` かつ
     bundle-like にパースできれば satisfied、そうでなければ contradicted。deep なスキーマ検証
     （配列 sort/uniqueness 等）は fs が要るため shadow core では行わない（CLI/test 層の課題として
     残す）
   - `review_admissibility`: `bundle.review.decision` が `commented` なら contradicted、
     `approved`/`self_merged` は satisfied（`src/core/gates.ts` の `checkProductionGate` が
     既に凍結している「comment だけが reject」という規則をそのまま再利用し、独自の厳格化はしない）。
     `review===null`（review omitted）は unknown/`unknown_structural`（review_omitted 用の新しい
     reason code は追加しなかった。closed set は sol must のまま5種を維持し、params に
     `review_omitted_code` を詰めた）
   - `verification_coverage`: 指示どおり `bundle.lane_ref.verification_digest` → exact
     verification record の連鎖。non-lane は `lane_ref_omitted`。evidence_refs は常に
     bundle 自身を `release_evidence` kind で引用（sol 設計ログに明示された唯一の具体例をそのまま
     採用）
   - `preview_verified`: `release_event` kind の record を bundle_digest で走査し
     `verified|preview`→satisfied、`failed|preview`→contradicted、どちらも無ければ
     `not_yet_recorded`。`target=preview` または `deployed|production` イベントに
     `preview_skipped=true` があれば not_applicable
   - `rollback_target_valid`: `previous_release_id=null`→not_applicable、self参照→contradicted、
     対象 release_id が `deployed|production` に到達した record が pool にあれば satisfied、
     なければ `referent_unresolved`
   - `privilege_boundary`: この評価器は CI/workflow 設定を表す exact-record kind を持たないため、
     静的走査は実装せず常に applicable/unknown/`unknown_structural`。
     "necessary condition, not a sufficient one" の注記を無条件に添付（spec.md の
     「observation の note に機械的に含める」を文字通り解釈）
4. **evidence_refs の一般化**: `release_event` 由来の証拠は promotion-receipt/v0 の
   `evidence_refs.kind` に解決可能な値（`review_finding`/`release_evidence`）が無いという既知の
   契約 gap（spec.md 「G 前の contract blocker」）に対し、`verification_coverage` 用に
   sol 設計ログが示した「bundle 自身を release_evidence として引用する」パターンを
   `preview_verified`/`rollback_target_valid`/`review_admissibility` にも一般化した。
   本タスクでは契約は変更しない、という指示に合致する範囲内の対処
5. **現在の実装では `verdict="ready_for_approval"` は絶対に出ない**。`privilege_boundary` が
   常に `applicable`+`unknown` である以上、verdict 導出式（contradicted優先→unknown→ready）は
   必ず `abstained`（他に contradicted が無い限り）に落ちる。これは「静的走査が無いのに
   satisfied を偽装しない」という設計そのものの必然的結果であり、chunk 3 が privilege_boundary の
   実スキャンを実装するまで変わらない、意図した振る舞い

## chunk 3 への引き継ぎ

- **決定論2プロセス比較・改ざん注入・実 corpus replay**（spec.md テスト計画の残り）:
  - `test/shadow-cli.test.ts` に2プロセス byte 比較を1件入れたが、TZ/locale を変えた比較
    （`env: {TZ: ...}` 付きで2回起動して stdout を比較）は未実施
  - 改ざん注入のうち「bundle 1 byte 変更」「finding claim 変更」は chunk 1 の
    `resolveRecordPool` の digest_mismatch 検出でカバー済みだが、predicate 評価済みの
    candidate_receipt 自体を後から破損させる（predicate 欠落・重複を人為的に作って
    `verifyCandidateReceiptFullFidelity` が確実に reject することを確認する）テストは未実施
  - 実 release corpus（spec-lane 等の実データ）でのリプレイは未実施。sol 裁定の実装ステップ12
    「実 release corpus を再走行し、unknown 分布と false allow を人間確認」はそのまま持ち越し
- **上流 conformance parity**（review-findings 全 fixture / promotion-receipt 全 fixture /
  release-approval composite 全 fixture）は vendored fixtures に対してまだ実行していない
  （`vendor/playbook-contracts/*/verify-fixtures.mjs` を node で直接叩くだけなら本チャンクの
  範囲内でもできたが、この評価器自身の実装を fixture と対照する形にはしていない -- chunk 3 で
  どの形の parity が意味を持つか要検討。この評価器は receipt を生成する側であって契約の
  reference verifier ではないため、素朴な fixture replay がそのまま適用できるとは限らない）
- **privilege_boundary の実スキャン**: 「非自明な判断3」の通り現状は常に unknown。chunk 3 で
  静的走査を実装するなら、まず「どの exact-record kind に CI/workflow 設定を入れるか」を
  `EXACT_RECORD_KINDS`（`input.ts`）に追加する設計判断から始まる
- **`review_omitted` 用の reason code**: 「非自明な判断3」で既存 `unknown_structural` に
  押し込んだが、chunk 1 の `lane_ref_omitted` と対称的な専用コードにする方が筋が良いかもしれない。
  ただし closed set は sol must（spec.md「変更する場合は deviation 記録が必要」）なので、
  追加するなら deviation として明示的に記録すること
- **selection_manifest の契約化**: 既知 open question のまま（本タスクの非目標）。chunk 2 では
  「resolveByDigest が非null」以上のことは要求していない（kind すら見ていない）ため、
  selection_manifest の実体が将来どんな形になっても wrapper ゲート側の変更は不要な設計にしてある

## chunk 3（検証層）: 完了

- `test/shadow-conformance.test.ts`: vendor/playbook-contracts/{promotion-receipt/v0,
  review-findings/v1,release-approval/v0} 全 fixture を、各契約自身の reference verifier
  （vendored `verify-fixtures.mjs`）にかけて `fixtures/expected-results.json` と完全一致するか
  機械確認する。この評価器は3契約いずれの完全なセマンティクスも自前実装していない（chunk 2
  「非自明な判断 3」: shallow なフィールド読み取りに留めている）ため、pin する対象は「この評価器
  自身のTS実装」ではなく「各契約が vendor する reference verifier」――
  `test/conformance.test.ts` が release-evidence/v0 に対してやっていることの対の関係
  （あちらは自前TS実装を fixture と対照、こちらは対照すべき自前実装が無いので契約側の
  reference 実装を直接使う）。件数は hardcode せず `readdirSync` で列挙、drift guard
  （expected-results.json の宣言と disk 上のファイルの一致）も3契約それぞれで検証
- **vendored verify-fixtures.mjs は直接 import 不可**という前提が判明: `"../../shared/*.mjs"`
  import は元 playbook repo のディレクトリ構成（`contracts/shared/` が
  `contracts/promotion-receipt/` 等の兄弟）を前提にしているが、本 repo は shared を
  `vendor/playbook-shared/` に別途 vendor しているため `vendor/playbook-contracts/shared/` が
  存在せず `node` 実行で `ERR_MODULE_NOT_FOUND` になる（`VENDORED.md` の想定通り、本 repo の
  `src/shadow/**` はこれを import せず TS 側で同等の検証を再実装する、という記述はある――が
  chunk 3 の conformance テストは「本 repo 自身の実装」ではなく「契約側の reference 実装」を
  参照する必要があるため、この一文の対象外として扱った）。対処として、テスト起動時に
  元のディレクトリ位相（`contracts/{promotion-receipt,review-findings,release-approval,
  shared}/...`）を一時ディレクトリに再構築: fs でしか読まれないもの（`fixtures/`、
  `*.schema.json`、`vendor/playbook-shared/*`）はシンボリックリンク、`verify-fixtures.mjs`
  本体だけはバイト同一の実ファイルとしてコピー（シンボリックリンクのままだと import 時に
  `import.meta.url` が symlink 解決後の実パス＝元の vendor パスに戻ってしまい、同じ壊れた
  相対 import を再現してしまうため）。vendor/ 自体は一切書き換えない
- 上記コピーには **1行だけの機械的パッチ**を全3ファイル共通で適用: `function runFixture(` →
  `export function runFixture(`（3ファイルとも export していない――promotion-receipt/v0 と
  review-findings/v1 は `checkReceipt`/`checkRecord` を export 済みだが release-approval/v0 は
  event/composite どちらの内部関数も export していない）。挙動は変えず、既存の per-fixture
  dispatch をこのテストから呼べるようにするだけ。**release-approval/v0/verify-fixtures.mjs は
  末尾で `main();` を無条件呼び出し**しており（promotion-receipt/review-findings は
  `if (isMainModule()) main();` でガード済み）、これを import すると即座に実行され
  `process.exit()` まで到達してしまうため、コピーからこの1行も除去した（vendor 側の欠陥ではなく
  「依存としてimportされる」使い方を元々想定していない、という前提の相違。テストコピー限定の
  対処であり contract gap としては記録しない）
- **release-approval/v0 の composite fixture（`bundles[]` を埋め込む全 fixture）は
  `RELEASE_EVIDENCE_CONTRACTS_DIR` 依存**: `checkEmbeddedBundle` が
  `release-evidence-bundle.schema.json` に対して検証するが、この契約は本 repo に vendor
  されておらず（既存の `test/helpers.ts` パターンと同じく外部参照のみ）、未設定環境では
  event-type fixture のみ実行し composite-type は `it.skipIf` で明示的にスキップする
  （`console.warn` は `helpers.ts` 側が既に出す。本チャンクで新設した silent cap ではない）。
  `RELEASE_EVIDENCE_CONTRACTS_DIR=<ai-agent-skills-playbook>/contracts/release-evidence/v0` を
  与えて実行し、92/92 全 fixture が accept/reject 通り（reason_code 込み）に振る舞うことを
  ローカルで確認済み（PR 前に人間が CI 環境で同様に確認することを推奨、下記参照）
- `test/shadow-tamper.test.ts`: 改ざん注入6種を1ファイルに集約（① bundle 1 byte / ② review
  finding claim / ③ verification record 内容改変 → いずれも `resolveRecordPool` の
  digest_mismatch で `invalid_input`。④ pointer digest 差し替え → プール自体は健全なため
  `invalid_input` にはならず、参照側 predicate の `unknown`/`referent_unresolved` として表出。
  ⑤ candidate_receipt の predicate 欠落・重複 → **生スキーマ単体では検出不能と判明**
  （`promotion-receipt.schema.json` の `predicates` ルールは `minItems:1` のみで、
  6件ちょうど・重複禁止という completeness 検査は vendored `verify-fixtures.mjs` 側の
  semantic MUST であり生スキーマには存在しない）。本チャンクでは
  `computeSemanticDigest`（既存 `serialize.ts`）による recompute-and-compare で検出可能である
  ことを実証――predicates を含むレシート全体をハッシュしているため、欠落/重複いずれも
  semantic_digest不一致として現れる。⑥ shadow output の record_digest 差し替え →
  同様に `computeRecordDigest` の recompute-and-compare で検出。⑤⑥ とも
  「schema 単体は通すが digest recompute は検出する」ことを明示的にアサートし、
  self-digest 設計（spec.md「出力自身も evidence-closed」）が実際に機能することを証明する形にした
- `test/shadow-cli.test.ts` に決定論テストを追加: TZ=UTC/Asia-Tokyo、LC_ALL=C/ja_JP.UTF-8、
  入力 JSON の全オブジェクトキー順序反転（再帰的）、records 配列順序反転――いずれも別プロセス
  2回起動（`execFileSync` を2回呼ぶ）で stdout を byte 比較。key 順序反転テストは前提
  （2つの入力ファイルのバイト列が実際に異なること）も明示的にアサートしている
- `docs/replay-pack-format.md` を新設し replay pack 形式（`input.json`必須 / `README.md`必須 /
  `expected.json`任意）を定義。`test/fixtures/replay-packs/{lane-backed,lane-ref-omitted}/` を
  vendored `release-approval/v0/fixtures/accept-composite-happy.json` の `bundles[0]`
  （実在・schema-valid な release-evidence/v0 bundle）から組んで作成――`lane-ref-omitted` は
  その bundle をバイト単位そのまま採用（`recordContentDigest` が同 fixture の
  `receipt.subject.bundle_digest` と一致することで provenance を確認済み）、`lane-backed` は
  同じ bundle をベースに `lane_ref`/`review` を populate した派生版（vendored fixture 集合には
  populate 済み `lane_ref` の accept 例が無いため）。`test/shadow-replay-pack.test.ts` が
  `test/fixtures/replay-packs/` を列挙して CLI e2e で `expected.json` と対照する
- 全体: `pnpm typecheck && pnpm test && pnpm lint` 全 green
  （`RELEASE_EVIDENCE_CONTRACTS_DIR` 未設定で 205 passed / 45 skipped、設定時
  290 passed / 0 skipped ―― 差分は全て release-evidence/v0 依存の既存 skip 規約どおり）

### 発見した contract gap

- なし。今回のテスト強化で見つかった検出不能ケース（predicate 欠落・重複が生スキーマ単体では
  reject されない、上記⑤）は**契約側の欠陥ではない**――promotion-receipt/v0 は
  completeness チェックを意図的に「スキーマ＋reference verifier のセマンティック層」に
  分離しており（vendored `verify-fixtures.mjs` 自身のコメント参照）、生スキーマだけで完結させる
  設計にはそもそもなっていない。本評価器はこの意図された分離を `computeSemanticDigest` の
  recompute-and-compare で正しく埋めている

### PR 前に人間がやること

1. **実 release corpus のリプレイ**（sol 実装ステップ12、本チャンクでも未実施）:
   実際の release-evidence bundle 群を `docs/replay-pack-format.md` の形式で1つ以上 replay pack
   化し、`release-evidence-shadow replay` を走らせて unknown 分布と（もしあれば）
   false allow の兆候を目視確認する。cohort-2 データロック後の対象コホートから
   数件サンプリングするのが妥当
2. **CI で `RELEASE_EVIDENCE_CONTRACTS_DIR` を設定して `test/shadow-conformance.test.ts` の
   release-approval composite fixture（28件）が実際に走ることを確認**する。ローカルでは
   `~/work/ai-agent-skills-playbook/contracts/release-evidence/v0` を指して 92/92 green を確認
   済みだが、CI 環境に同リポジトリのチェックアウトが無い場合はこの28件が恒常的にスキップされ
   続ける――既存の `test/conformance.test.ts` 等と同じ既知の制約だが、chunk 3 で追加した
   release-approval conformance にも同じ制約が及ぶことを認識した上で、CI 側の対応（サブモジュール
   化する／別ジョブで annex する等）を要検討
3. **`test/shadow-conformance.test.ts` の 1 行パッチ（`export function runFixture(` /
   release-approval の末尾 `main();` 除去）が、次回 playbook 側再 vendor 時に無効化しないか
   確認**する（`VENDORED.md` の commit を進めて再コピーする際、`mirrorContract` 内の
   `occurrences !== 1` チェックが構造変化を検知して fail するので、CI が green のままなら
   実質的に自動チェック済みではある）

## terra 実装レビュー must 修正ラウンド A（must 1〜4）: 完了

対象: `~/ai_bus/logs/terra-f-evaluator-impl-20260827.log` の must 1〜4（must 5〜7 はラウンド B、
本ラウンドでは触れていない）。

1. **must 1（契約不正 record が satisfied になる）**: `src/shadow/contracts.ts` を新設し、
   `release_evidence_bundle` / `release_event` / `review_finding_record` / `verification_record`
   の4 kind について、predicate 実行前に schema_version・全 schema・semantic MUST を検証する純粋
   関数 `validateRecordContract` を追加した。bundle/event の実体は release-evidence/v0（この repo
   に vendor されておらず `RELEASE_EVIDENCE_CONTRACTS_DIR` 経由の外部参照のみ）のため、fs を一切
   使わない hand-written mirror（`input.ts` の `candidateReceiptSchema` と同じ手法だが、この
   validator が oneOf/allOf/if-then-else まで解釈できる分、より高忠実度）として埋め込んだ。
   review-findings/v1 は本 repo に vendor 済みだが、それでも fs 経由で読まず同じ mirror 方式にした
   （shadow core の fs 禁止を「schema の読み込みも含めて」文字通り守るため）。verification_record
   は元々どの契約にも属さないため、この評価器自身の draft schema
   （`verification-record/v0`、`{schema_version, verification_id}`）を新設。semantic MUST は
   bundle について `contracts.ts` 内に `bundleContentSemanticChecks` を実装した（`src/core/
   bundle.ts` の `bundleSemanticChecks` と同内容 -- ただし今ラウンドの編集許可範囲が
   `src/shadow/**` 等に限られ `src/core/**` を含まないため、export して再利用するのではなく
   ハンドコピーした。将来 `src/core/**` も編集範囲に入るラウンドで export/import に一本化すべき
   残課題として contracts.ts のコメントに明記済み）。event/review-finding については
   observed_at と契約上の時刻フィールドの一致検証（must 3 と共有、下記）を semantic MUST として
   実装。呼び出しは `resolver.ts` の `resolveRecordPool` 内、digest
   検証・cut フィルタの後、pool 格納の直前。違反は `record_invalid`、schema_version 不一致は
   `unsupported_record_version`。回帰テスト: `test/shadow-evaluate.test.ts`
   `describe("evaluate: must-1 regression ...")`（terra の再現手順そのまま: 必須フィールド欠落
   bundle + 不正 enum decision + 空 verification record + 不完全 event → 全部 satisfied だったのが
   `invalid_input` になることを確認／`unsupported_record_version` の専用テスト）
2. **must 2（pointer chain 未実装）**: `ShadowEvaluationInput.subject` に
   `review_finding_digest` / `rollback_previous_bundle_digest`（どちらも optional, nullable）を
   追加。`evaluate.ts`: (a) selection_manifest gate は既存記録の kind が `selection_manifest` で
   あることも要求するよう修正（`kind:"other"` を通さない）、(b) `evalReviewAdmissibility` は
   `bundle.review` が非 null のとき（`commented` は pointer 不要で従来通り contradicted）、
   `subject.review_finding_digest` が `review_finding_record` kind のレコードに解決することを
   satisfied の必須条件にした、(c) `evalRollbackTargetValid` は
   `subject.rollback_previous_bundle_digest` が実在する `release_evidence_bundle` kind の
   previous bundle に解決し、かつその previous bundle 自身の digest に束縛された
   `deployed/production` event が存在することを satisfied の必須条件にした（release_id 文字列
   一致だけでは satisfied にしない）。policy_snapshot 側の pointer chain（`policy.digest` の
   resolve 必須化）は今回のレビュー再現に含まれておらず、既存テスト全件が resolve しない
   `policy.digest` を使っているため、追加すると影響範囲が本ラウンドの再現範囲を大きく超える
   ―― 今回はスコープ外とし、ここに明示的な残課題として記録する（round B か別 deviation で検討）。
   回帰テスト: `test/shadow-evaluate.test.ts` の各 describe に
   「pointer 無しでは unknown、pointer 解決で satisfied」のペアを追加
3. **must 3（evaluation_cut 迂回）**: `src/shadow/time.ts` を新設し、正規表現だけでなく実在暦日
   （月1-12、月ごとの日数、閏年、時分秒の範囲）を検証する `isRealTimestamp` を実装（`new Date()`
   のオーバーフロー許容挙動に依存しない）。`resolver.ts` の `resolveRecordPool` を全面的に
   再構成: (a) `evaluationCut` 自体の実在性を最初に検証し、不正なら record 単位ではなく
   `evaluation_cut` フィールドを指す `record_invalid` として即座に `invalid_input` にする、
   (b) record ごとの cut 判定は「宣言された `observed_at` の実在性 → cut 比較」の順で、
   **コンテンツ digest の再計算より前**に行う（cut 後 record は digest 再計算に一度も
   到達しない ―― tampered future record が invalid_input を汚染しない）、(c)
   `contracts.ts` の semantic MUST として、時間軸を持つ kind（`release_event`
   の `occurred_at`、`review_finding_record` の `recorded_at`）は envelope の `observed_at` が
   必須かつ内容の時刻フィールドと厳密一致することを要求（不一致・省略は `record_invalid`）。
   回帰テスト: `test/shadow-evaluate.test.ts` の must-3 regression に
   `evaluation_cut="2026-99-99..."` → invalid_input、`observed_at` 省略による cut 迂回の再現 →
   invalid_input、`observed_at` と `occurred_at` の不一致 → invalid_input、
   「未来 record の内容改ざんは digest_mismatch にならず素直に future 除外される」の4本
4. **must 4（重複 digest の非決定性）**: `resolver.ts` の `resolveRecordPool` で、digest
   検証済みの生存 record を digest でグルーピングし、同一 digest 内で `kind` または
   `observed_at` が一致しない場合は全体を `record_invalid`（`reason: "conflicting duplicate
   envelopes..."`、`kinds` は決定的にソート済み）として拒否するようにした（挿入順に依存する
   `Map.set` の last-write-wins を廃止）。`resolveByDigest(pool, digest)` の呼び出し側 API は
   変更していない（衝突自体を拒否するため、kind 込みの解決キーへの変更は不要と判断）。
   回帰テスト: `test/shadow-evaluate.test.ts` に kind 衝突・observed_at 不一致それぞれの
   records-order permutation（forward/reversed で同一の invalid_input になることを確認）、
   `test/shadow-cli.test.ts` に同じ衝突シナリオの2プロセス byte 比較テストを追加

### このラウンドで生じた既存挙動の変化（すべて satisfied/contradicted → unknown/invalid_input 方向）

- 自己参照ロールバック（`rollback.previous_release_id === release_id`）を持つ bundle は、以前は
  `evalRollbackTargetValid` が predicate 単位で `contradicted` にしていたが、bundle 自体が
  `bundleContentSemanticChecks` の `rollback_to_self` semantic MUST に違反するため、今は record_invalid
  （evaluation_status=invalid_input）になる。predicate 側の自己参照チェックは、kind が
  `release_evidence_bundle` 以外（＝ contracts.ts の検証を経ない）のレコードが bundle_digest に
  誤って束縛された場合の defense-in-depth として残した（`test/shadow-evaluate.test.ts` にこの
  ケース専用の回帰テストあり）
- `review_admissibility` / `rollback_target_valid` の既存 "satisfied" テストフィクスチャは、
  新しい pointer chain（review_finding_digest / rollback_previous_bundle_digest）を明示的に
  配線しないと unknown になる。既存の happy-path フィクスチャ（`fullyResolvedInput()` 系）は
  全ファイルで配線済みに更新した
- テストフィクスチャの bundle/event/verification/review-finding content は、契約フルスキーマに
  対して genuinely valid でなければ now record_invalid になる。全 shadow テストファイルの
  フィクスチャを `test/helpers.ts` の `validBundleContent` / `validEventContent` /
  `validReviewFindingContent` / `validVerificationRecordContent` ベースに更新した
  （`test/fixtures/replay-packs/lane-backed/input.json` も同様に更新 ―― must 7 の pack 契約
  valid化の一部だが、本ラウンドの must 1〜4 修正が前提として要求したため先行して直した。
  `lane-ref-omitted` pack は元々 valid だったため無変更）

### 検証結果

`RELEASE_EVIDENCE_CONTRACTS_DIR` を `~/work/ai-agent-skills-playbook/contracts/release-evidence/v0`
に設定して `pnpm typecheck && pnpm test && pnpm lint` 実行、**303 passed / 0 skipped**、
typecheck・lint とも green。未設定でも **218 passed / 45 skipped**（既存の contracts-dir 依存
skip 規約どおりで、shadow 側は新規に外部依存を増やしていないため 0 件も追加スキップされない
―― bundle/event の contract schema を hand mirror にしたことの直接的な効果）。

## terra 実装レビュー must 修正ラウンド B（must 5〜7 + policy_snapshot 保留 + should + nit）: 完了

対象: `~/ai_bus/logs/terra-f-evaluator-impl-20260827.log` の must 5〜7 / should / nit、および
ラウンド A の must-2 セクションに記録した「policy_snapshot 側の pointer chain は今回スコープ外」
という残課題。

1. **must 5（candidate receipt の full-fidelity 検証が JSON Schema のみ）**: 新設
   `src/shadow-cli/vendor-loader.ts` が、vendored `promotion-receipt/v0/verify-fixtures.mjs` の
   `checkReceipt`（と review-findings/v1 の `checkRecord`）を実際に dynamic import して実行する
   ―― `test/shadow-conformance.test.ts` が conformance テスト用に確立済みの「playbook 側の元
   ディレクトリ位相を一時ディレクトリへ再構築し、`shared/` は symlink・`verify-fixtures.mjs` 本体
   だけ byte-for-byte コピー」という手法を CLI 層（fs 許可済み）に持ち込んだもの。この2ファイルは
   どちらも既に `checkReceipt`/`checkRecord` を export 済みで `main()` も
   `if (isMainModule()) main();` でガード済みのため、conformance テストが release-approval/v0 に
   対して行った「1行パッチ」は不要だった。`src/shadow-cli/main.ts` の
   `verifyCandidateReceiptFullFidelity` はこれを呼ぶだけの薄いラッパーに置き換え（cmdReplay/main
   は async 化）、schema-only 検証ではなく predicate-set completeness/no-duplicate・
   resolvable-evidence-kind・real-calendar `evaluated_at`・`semantic_digest` 再計算・verdict 導出
   を含む全 semantic MUST を実行するようになった。加えて新設 `src/shadow/verify.ts` に
   `verifyRecordDigest` / `verifyInputManifestDigest` / `verifyPredicateProjection`
   （observation→receipt projection の照合、`evaluate.ts` の `toReceiptPredicate` を export して
   再利用）を追加し、CLI のフル検証ゲートに組み込んだ。回帰テスト:
   `test/shadow-tamper.test.ts` ⑤ を強化 ―― 「semantic_digest が変わった」比較ではなく、
   predicate 欠落・重複後に `computeSemanticDigest` で semantic_digest 自体も再計算して整合させた
   改ざんを `checkReceiptAgainstVendoredVerifier` に投入し、実際の verifier が
   `predicate_missing`/`predicate_duplicate` で reject することを確認する形に変更（旧来の弱い
   digest 比較は defense-in-depth として1件だけ残した）。⑥ に `verifyInputManifestDigest` /
   `verifyPredicateProjection` それぞれの改ざん検出テストを追加
2. **must 6（architecture lock の抜け道）**: `test/shadow-architecture.test.ts` を全面刷新。
   検出は TypeScript コンパイラ自身（`pnpm typecheck` が既に依存する devDependency）の AST を
   `ts.createSourceFile` で走査する方式に変更し、static import・`export ... from`・dynamic
   `import()`（文字列リテラル/no-substitution テンプレート/テンプレート式の3形とも）を検出 ――
   multiline import・dynamic import が旧来の1行 regex を素通りしていた抜け道を塞いだ。走査対象も
   `src/cli/**` と "deploy"-named core ファイルという allowlist から、`src/shadow/**`（対象自身）
   と `src/shadow-cli/**`（唯一の許可された import 元）を除く**全 production `src/**` へ
   default-deny**に変更 ―― 新しい `src/**` ディレクトリが将来増えてもこのファイルの変更なしに
   自動的に走査対象へ入る。自己テストとして、multiline import / dynamic import() /
   テンプレート式 dynamic import / export-from の4形それぞれについて一時ディレクトリに合成ソース
   を書き出し検出されることを確認するテストと、`src/shadow-cli/**` への import・無関係な import は
   一切 flag されないことを確認するネガティブコントロールを追加
3. **must 7（replay pack が契約不正 record を期待値固定）**: 調査の結果、ラウンド A の must 1〜4
   修正が `test/fixtures/replay-packs/{lane-backed,lane-ref-omitted}/input.json` を
   contracts.ts の hand-mirror 検証に通る形へ**既に**再構築済みだったため、fixture 自体の再構築は
   本ラウンドでは不要だった（must 1〜4 セクションの「既存挙動の変化」に記録済みの副作用）。
   本ラウンドの対応は、terra が要求した「pack 内の全契約 record を reference validator で先に
   検証するステップ」を `test/shadow-replay-pack.test.ts` に追加すること ―― bundle/release_event
   は `src/core/bundle.ts`/`event.ts` の `validateBundle`/`validateEvent`（release-evidence/v0 の
   本物の reference 検証、`RELEASE_EVIDENCE_CONTRACTS_DIR` 依存）、review_finding_record は
   vendor-loader.ts 経由の review-findings/v1 `checkRecord` で検証し、いずれも `[]`（エラー無し）
   であることを確認する。`RELEASE_EVIDENCE_CONTRACTS_DIR` を設定して実行し、両 pack の
   bundle/event/review-finding-record が全て実際の reference validator を通ることを確認済み ――
   expected.json の値そのものは変更不要だった（既に「契約 valid な record からの正しい評価結果」
   だったため）
4. **policy_snapshot の pointer chain 保留の解決**: `src/shadow/evaluate.ts` に
   `resolvePolicySnapshot(input, pool)` を新設・export。sol 裁定の入力ポインタ表
   （「policy ref | 評価開始時の policy snapshot」）どおり、既存の `input.policy.digest` を
   `policy_snapshot` kind のレコードに対して解決する（kind 不一致は must-2 と同じ discipline で
   非解決扱い）。ただし**非 gating**（`EvalContext.policySnapshot` に格納するだけで、
   selection_manifest/bundle の2ゲートのような evaluation_status 全体への影響は持たせない）―― 現在
   このリポジトリのどの predicate も policy_snapshot の CONTENT を読んでおらず
   （`privilege_boundary` の unknown は「静的スキャン未実装」という別の capability gap であって
   policy データの欠落が原因ではない）、既存 fixture 群も `policy.digest` に実在しないプレース
   ホルダ値を使っているため、これを gating にすると本ラウンドの再現範囲を超える既存挙動変化を
   招く。「現時点の corpus に policy record が無い場合は referent 不要の任意 ref」という round B
   の指示どおりの実装であり、将来 policy content に依存する predicate を実装する際は
   「解決できなければ該当部分を fabricate せず unknown/not_yet_recorded にする」というルールに
   従うことを `resolvePolicySnapshot` 自身の doc comment に明記した。回帰テスト:
   `test/shadow-evaluate.test.ts` に解決/kind不一致/未解決の3ケースと、policy ref の解決有無で
   `evaluate()` の `evaluation_status`/`predicate_observations`/`verdict` が変わらないことを
   確認するテストを追加
5. **should（VENDORED.md の記述更新)**: `vendor/playbook-contracts/VENDORED.md` の「本 repo の
   `src/shadow/**` はこれを import せず TS 側で同等の検証を再実装する」という一文を、実態
   （record CONTENT 検証は依然 hand-mirror だが、candidate_receipt の full-fidelity 検証は
   vendor-loader.ts が実際に import・実行する）に合わせて2パターンに分けて更新
6. **nit（CLI の余分な positional 引数）**: `src/shadow-cli/main.ts` の `main()` が
   `parseArgs` の返す `positional` を無視していたのを、1件以上あれば usage error
   （`fail(...)`、exit 2）にするよう修正。回帰テスト: `test/shadow-cli.test.ts` に
   `replay extra --input ...` が非ゼロ終了することを確認するテストを追加

### 検証結果（ラウンド B）

`RELEASE_EVIDENCE_CONTRACTS_DIR` を設定して `pnpm typecheck && pnpm test && pnpm lint` 実行、
**318 passed / 0 skipped**、typecheck・lint とも green。未設定でも **233 passed / 45 skipped**
（ラウンド A からの追加スキップ 0 件は変わらず、新規テスト15件は全て pass）。

## terra 再レビュー must 修正ラウンド C（最終）: 完了

対象: `~/ai_bus/logs/terra-f-evaluator-reimpl-20260827.log` の「新規・残存指摘」4件（must）+ should。
ラウンド B までで must 3・5 は resolved 済みだったが、terra の再攻撃で must 1・2・4・6・7 が
「同じ狭いケースは防御、要求全体は未完」の partially resolved と判定された。

1. **C-1（must 1 残余: semantic MUST と collection 検証）**:
   - **review-findings の semantic MUST**: `contracts.ts` に
     `reviewFindingContentSemanticChecks` を追加（duplicate finding ID / locations[] の
     start_line・end_line 整合 / numeric confidence 禁止 / personal-dimension scan）。
     personal-dimension scan は `#vendor/personal-dimensions.mjs`（fs 不使用の純関数）を直接
     import、numeric confidence scan は vendored `review-findings/v1/verify-fixtures.mjs` の
     `scanNumericConfidence` をハンドコピー（playbook 側 `contracts/shared` に無く各契約が
     個別に複製している関数のため）。duplicate finding ID / location consistency は同ファイルの
     `checkRecord` 相当をハンドポート。
   - **release ledger の fold/collection 検証**: `src/core/fold.ts` の `foldAttempt`
     （fs 不使用の純関数、release-evidence/v0 の D5 状態機械 reference そのもの）を
     `evaluate.ts` に import し、`foldAttemptEvents(releaseId, bundleDigest, pool)` を新設。
     `preview_verified`/`rollback_target_valid` の **satisfied 分岐の直前**でのみ呼び、
     対象 attempt（同一 release_id/bundle_digest）の release_event を `occurred_at` の実時刻順
     （配列順ではない -- 決定論のため）で fold し、illegal_transition が1件でもあれば
     satisfied にせず unknown（`unknown_structural`/既存の`referent_unresolved`）へ落とす。
     「孤立 verified/preview」「孤立 production deploy」はどちらもこれで満たさなくなる。
     collection 全体を pool.errors 経由で invalid_input にする設計は採らなかった
     （後述「設計判断」参照）。
   - **replay pack の expected 更新**: `test/fixtures/replay-packs/lane-backed/` の
     `verified|preview`/`deployed|production` イベントは意図的に孤立させたまま保持し
     （fixture 自体の再構築ではなく、この fix を実際に実演する目的で）、
     `expected.json`/`README.md` を `preview_verified`/`rollback_target_valid` = unknown に更新。
     `lane-ref-omitted` pack は元々どちらも unknown だったため無変更。
   - **設計判断（デビエーション記録）**: collection 検証を「pool.errors→invalid_input」ではなく
     「対象 predicate の satisfied 判定のみをブロックする unknown」としたのは、`fullyResolvedInput`
     系の既存ハッピーパス fixture が最小限の event 集合（当該 attempt の完全な prepared→...→
     verified 連鎖を持たない）で構成されており、collection 全体を reject する設計だと本ラウンドの
     再現範囲を大幅に超える既存挙動変化（無関係の大量テストが invalid_input に反転）を招くため。
     代わりに fixture 側（`fullyResolvedInput`/`baseInput` 系ヘルパ）を「本当に legal な
     event chain」へ修正し、terra が実演した「孤立イベントで satisfied を騙る」攻撃だけを
     確実に塞いだ。
2. **C-2（must 2 残余: policy ref の正直な扱い）**: `input.ts`
   の `ShadowEvaluationInput.policy.digest` を `string | null` に変更し、null のときは
   `absent_reason: {code:"policy_snapshot_absent", note}` を必須化（schema の allOf で
   digest=null ⇔ absent_reason 必須の相互排他を強制）。`evaluate.ts` に policy 用の
   **第三の wrapper gate** を追加: digest が non-null なら `policy_snapshot` kind へ解決必須
   （未解決/kind 不一致は `evaluation_status="unknown"`, `reason=referent_unresolved` --
   `subject.bundle_digest` と同じ discipline）。digest===null は non-gating のまま
   （privilege_boundary 等、現時点でどの predicate も policy content を読んでいないため）。
   「未解決でも黙って receipt 生成」経路は削除された。ただし vendored promotion-receipt/v0 は
   `policy_digest` を必須 non-null 文字列として固定しており（契約は変更しない）、digest===null
   でも receipt 自体は生成する（non-gating の要請、実装ノート冒頭参照）ため、その場合に埋める
   固定 sentinel 値 `POLICY_DIGEST_ABSENT_SENTINEL`（`recordContentDigest("policy_snapshot_absent/v0")`
   の固定値、実データを指さない）を新設。`resolvePolicySnapshot` は digest===null を
   ルックアップなしで即 null 返却するよう修正。回帰テスト:
   `test/shadow-evaluate.test.ts` の policy_snapshot describe block を更新
   （旧「未解決でも結果不変」テストを round C の正しい挙動 = unknown ゲートに置き換え、
   「digest=null は結果不変」の新テストを追加）、`test/shadow-input.test.ts` に
   digest/absent_reason の相互排他 schema テストを追加。
3. **C-3（must 4 残余: input_errors の決定的ソート）**: `serialize.ts` に
   `sortInputErrors`（closed sort key: `code` → 記録 digest（`params.digest`、
   `digest_mismatch` は `params.declared`）→ 記録内の場所（`params.field`/`params.kind`）→
   `params` 全体の JCS canonical bytes を最終タイブレークとする全順序）を新設し、
   `evaluate.ts` の `invalid_input` finalize 直前でこれを適用。回帰テスト:
   無関係な invalid record 2件（kind・digest とも異なる）の配列順を反転しても
   `input_errors`/`record_digest`/CLI stdout が byte 一致することを
   `shadow-evaluate.test.ts`・`shadow-cli.test.ts`（2プロセス比較）・`shadow-serialize.test.ts`
   （`sortInputErrors` 単体）の3層で確認。
4. **C-4（must 6 残余: architecture guard の fail-closed 化）**:
   `test/shadow-architecture.test.ts` を2点修正。(a) 動的 `import()` の引数が文字列リテラル/
   no-substitution テンプレート以外（`BinaryExpression` 連結・置換ありテンプレート・裸の変数・
   関数呼び出し等）の場合、内容を推測せず**一律 forbidden**とする fail-closed に変更
   （旧版はテンプレートの literal chunk だけを best-effort で正規表現照合しており、
   `import("../" + "shadow/evaluate.js")` のような `BinaryExpression` は解析対象外だった）。
   (b) 走査対象を「`src/` 直下のディレクトリのみ」から「`src/shadow/**`・`src/shadow-cli/**`
   を除く `src/` 以下の全 production `.ts`」に拡張し、`src/` 直下に将来置かれる
   `.ts` ファイル（例: `src/promote.ts`）も自動的に対象へ入るようにした（`.d.ts` は対象外）。
   自己テスト: 置換ありテンプレート（"shadow" という文字列を含まないケースも追加）・
   `BinaryExpression` 連結・裸変数の3パターンを新規に追加。
5. **should（VENDORED.md / implement-notes.md の記述整合）**: `vendor/playbook-contracts/
   VENDORED.md` の record CONTENT 検証節に、review-findings の semantic MUST 追加分と
   release ledger fold/collection 検証（`foldAttemptEvents`）の位置づけを追記。本節
   （ラウンド C）が「正しい評価結果」の最新記録。

### policy ref の最終仕様（round C 確定）

- `policy.digest: string | null`
  - **null**: 「このリプレイには policy snapshot が無い」という正直な宣言。
    `absent_reason: {code:"policy_snapshot_absent", note}` を伴わなければ schema-invalid。
    non-gating -- evaluation_status/predicate_observations/verdict は resolvable な policy と
    完全に同一。candidate_receipt は生成されるが、`policy_digest` フィールドには
    `POLICY_DIGEST_ABSENT_SENTINEL`（実データを指さない固定値）を埋める。
  - **非 null**: `policy_snapshot` kind の record へ実際に解決しなければならない
    （expected kind + whole-record digest）。未解決・kind 不一致は
    `evaluation_status="unknown"`, `reason=referent_unresolved` -- receipt は生成されない。
    「解決できないふりをして黙って receipt を出す」経路は無い。
  - 将来 policy content に依存する predicate を実装する際のルール（`resolvePolicySnapshot`
    の doc comment に明記済み）: 解決できなければ該当部分を fabricate せず
    unknown/not_yet_recorded にする。

### 検証結果（ラウンド C）

`RELEASE_EVIDENCE_CONTRACTS_DIR` を設定して `pnpm typecheck && pnpm test && pnpm lint` 実行、
**340 passed / 0 skipped**、typecheck・lint とも green。review-findings/v1 の全23 fixture
（accept/reject 双方）を resolver.ts のフルパイプラインに通し、過剰 reject・過小 reject
とも 0 件を確認済み（terra が指摘した「reference が accept する58件相当の正常系」の
一部として review-findings 分をローカルで再確認）。

## terra 3巡目再監査 残 must 修正ラウンド D（最終収束）: 完了

対象: `~/ai_bus/logs/terra-f-evaluator-round3-20260827.log`「新規指摘」の must 2件 + should 2件。
ラウンド C で C-1（review-findings semantic MUST + ledger fold/collection 検証）と C-4
（architecture guard fail-closed 化）を resolved 済みと判定したが、terra の追加差分攻撃で
どちらも「新しい迂回」が再現し partially resolved と再判定された。

1. **D-1（must: collection-level semantic MUST の穴）**: `evaluate.ts` の event 収集
   （`foldAttemptEvents`）は `bundle_digest` のみで event をグルーピングしており、
   reference の `src/core/collection.ts`（`checkReleaseCollection`）が行う
   ① event–bundle の `release_id` 整合性確認と、`src/core/fold.ts`（`foldLedger`）が行う
   ② ledger-wide `event_id` uniqueness の両方を欠いていた。terra の再現2件
   （同一 bundle_digest を騙りつつ `release_id="attacker-release"` を名乗る3 event /
   合法な D5 遷移だが3 event が同一 `event_id="evt-dup"` を共有）はどちらも
   `foldAttemptEvents` の illegal_transition チェック（ラウンド C で追加済み）をすり抜ける
   ――前者はそもそも遷移グラフ自体は合法（event 自身の release_id は見ていない）、後者は
   遷移そのものが正規の prepared→...→verified 連鎖だからである。
   - `evaluate.ts` に `validateEventCollectionSemantics(pool)` を新設。プール内の全
     `release_event` record（対象 bundle の attempt に限らずプール全体）を対象に、
     (a) 各 event の `bundle_digest` が resolve する `release_evidence_bundle` record の
     `release_id` と一致するか、(b) `event_id` がプール全体で重複していないか、を検査し、
     違反があれば `record_invalid`（reason: `release_id_mismatch` / `duplicate_event_id`）を返す。
   - `evaluate()` 側は `pool.errors`（resolver.ts の per-record 検証）と同じ優先度・同じ
     短絡先で結線: 違反が1件でもあれば `evaluation_status="invalid_input"` にし、
     いかなる predicate も実行しない。
   - **設計判断**: ラウンド C の C-1 では「collection 全体を invalid_input にすると
     `fullyResolvedInput` 系の意図的に不完全な event chain を持つ既存ハッピーパス fixture が
     大量に invalid_input へ反転する」ため、illegal_transition は predicate 単位の unknown に
     留める設計を採った。今回の release_id 整合性・event_id 一意性は性質が異なる
     ――正当な fixture であれば event は常に自分自身の bundle の release_id と一致し、
     event_id を重複させることもないため、invalid_input に倒しても正常系58件相当・
     全340→348件の既存テストへの影響はゼロだった（実測: 過剰 reject 0 件）。
   - 回帰テスト: `test/shadow-evaluate.test.ts` に terra の再現2件をそのまま
     describe block化（reference と同じ reject = `record_invalid` 経由の `invalid_input`
     になることを確認）+ 正当な `fullyResolvedInput()` が引き続き `evaluated` のままである
     ことを確認する否定制御を追加。
2. **D-2（must: architecture guard の CommonJS 迂回）**: `test/shadow-architecture.test.ts` の
   AST 走査は static/dynamic `import`、`export ... from`、`import =` のみを見ており、
   `import { createRequire } from "node:module"; const load = createRequire(import.meta.url);
   const shadow = load("../shadow/evaluate.js");` という ESM から CommonJS `require()` へ
   抜ける第二のロード経路を検出できなかった（terra が Node 22 上で実際に `evaluate` の
   ロードに成功したことを実演）。
   - `collectRequireBoundIdentifiers`（`const x = createRequire(...)` の束縛先識別子を
     ファイル全体から shape-only で収集）と `isRequireLikeCall`（グローバル `require`・
     上記束縛識別子・`createRequire(...)(...)` の即時呼び出しチェーンのいずれかを判定）を
     新設し、これらの呼び出しの第一引数を既存の dynamic `import()` と同じ fail-closed
     ルール（文字列リテラル以外は無条件 forbidden）で判定する分岐を `collectModuleSpecifiers`
     に追加。fail-closed 原則（判定できないロード形は違反扱い）を維持。
   - 自己テスト: terra の再現をそのまま合成ファイル化した回帰（`createRequire` 束縛 →
     呼び出し）に加え、`createRequire(...)(...)` 直接チェーン・裸の `require(...)`・
     束縛識別子への非リテラル引数（fail-closed）・`createRequire` 使用だが対象が
     `src/shadow/**` 以外という陰性制御の計5パターンを追加。
3. **should-1（`resolvePolicySnapshot` のコメントの実態不一致）**: JSDoc 冒頭が
   「an unresolved policy ref must never block or change today's evaluation」と無条件の
   non-gating であるかのように書かれたままだったが、ラウンド C で `policy.digest` が
   non-null かつ未解決/kind不一致の場合は `evaluate()` の第三 wrapper gate が
   `evaluation_status="unknown"` に落とす gating 経路になっている（実装は正しい）。
   コメントを「non-gating なのは `digest===null` の場合のみ、non-null は wrapper gate で
   gating される」と実装に一致する形に書き直した。
4. **should-2（replay pack 手順の記述とラウンド C 後の仕様の不一致）**: `docs/replay-pack-format.md`
   のサンプル pack 手順が「syntactically-valid placeholders」という古い表現のままだったが、
   ラウンド C で `test/fixtures/replay-packs/*/input.json` の `policy` は
   `digest: null` + `absent_reason: {code: "policy_snapshot_absent", ...}` という正直な
   absence 宣言に変わっている（placeholder digest ではない）。記述を実際の fixture の内容
   （`digest=null`＋`absent_reason`、`effective_risk`/`contract_pin.playbook_commit` は
   代表値）に一致させた。

### 検証結果（ラウンド D）

`RELEASE_EVIDENCE_CONTRACTS_DIR` を設定して `pnpm typecheck && pnpm test && pnpm lint` 実行、
**348 passed / 0 skipped**（ラウンド C の340件 + D-1回帰2件・否定制御1件 + D-2自己テスト5件）、
typecheck・lint とも green。正常系の過剰 reject は引き続き 0 件（conformance parity の既存
テストに変更なし）。作業ツリーへの git commit は行っていない。

## terra 4巡目 残 must 修正ラウンド E: 完了

対象: `~/ai_bus/logs/terra-f-evaluator-round4-20260827.log`。terra が指定した3件の再現攻撃
（`release_id="attacker-release"` / `event_id="evt-dup"` 異内容3event / 直接名 `createRequire`
ロード5パターン）はいずれも resolved と再確認されたが、terra 自身の差分攻撃で新規 must が
2件再現し、局所修正が必要と判定された。

1. **E-1（must: digest collapse 後に event_id uniqueness を見ているため、同一 record の
   重複が素通りする）**: `validateEventCollectionSemantics`（ラウンド D 新設）は
   `pool.byDigest.values()`（resolver.ts が同一 digest を1件へ collapse した後のプール）
   を対象に event_id 重複を検査していた。ある `release_event` envelope を `records[]` に
   byte-for-byte 同一のまま2回入れる（terra の再現: `structuredClone` で複製し push）と、
   両者は同一 digest を持つため resolver.ts の collapse で1件に畳まれ、`byDigest` には1件
   しか現れない――結果、`event_id` は「1回しか出現していない」ことになり、reference の
   `src/core/fold.ts` `foldLedger`（`input.records` を直接 fold し、重複 `event_id` を
   無条件 reject する）が reject する入力を `evaluated` のまま通してしまっていた。
   - `src/shadow/resolver.ts` の `ResolvedRecordPool` に `allOccurrences` フィールドを新設。
     cut・digest 検証・(同一 digest 内の) envelope 矛盾検査・contract 検証を通過した
     digest グループについて、そのグループの**生の occurrence 全件**（collapse 前、重複を
     保持したまま）を集めたもの。`byDigest`/`errors` の既存計算ロジック（terra
     must-4 の「同一 digest だが kind/observed_at が矛盾する envelope は record_invalid」
     判定を含む）は完全に不変のまま、判定を通過したグループの `group` 配列をそのまま
     追加で集約するだけの変更で、既存の会心テスト（must-4 回帰）への影響はゼロ。
   - `evaluate.ts` の `validateEventCollectionSemantics` の ② event_id uniqueness チェックを、
     `pool.byDigest.values()`（distinct digest 単位）ではなく `pool.allOccurrences`
     （occurrence 単位、`kind==="release_event"` のみ）を数え、同一 `event_id` の
     出現回数が2回以上ならば `duplicate_event_id` の `record_invalid` を返すように変更。
     ① release_id 整合性チェックは content のみに依存する性質のため、従来通り
     `pool.byDigest.values()`（distinct digest 単位）のままとした
     ――occurrence 単位にすると重複 occurrence ごとに同一違反を複数回報告してしまうため。
   - 回帰テスト: `test/shadow-evaluate.test.ts` に「terra round E」describe block を追加。
     (a) terra の exact repro（同一 `release_event` record を `structuredClone` して
     `records[]` に2回積む）→ `invalid_input` / `duplicate_event_id` を確認、
     (b) 対照として、内容が異なる（=digest も異なる）が `event_id` だけ共有する3 event
     （ラウンド D の repro と同型だが distinct digest 版）も引き続き `duplicate_event_id`
     で reject されることを確認――occurrence 単位化によって distinct-digest の既存検出が
     壊れていないことの回帰。
2. **E-2（must: `createRequire` の import alias / namespace binding で architecture guard を
   回避できる）**: `test/shadow-architecture.test.ts` の `collectRequireBoundIdentifiers` は
   呼び出し先識別子の `.text` が文字どおり `"createRequire"` の場合だけ束縛を収集していた。
   `import { createRequire as cr } from "node:module"; const load = cr(import.meta.url);`
   という合法な named-import alias は、ローカル識別子名が `cr` であるため一致せず、
   guard がまったく検出できなかった（terra が実測で `load("../shadow/evaluate.js")` が
   実際にロードに成功することを実演）。namespace import（`import * as m from "node:module"`
   → `m.createRequire(...)`）も同様に未対応だった。
   - `collectCreateRequireBindings(sourceFile)` を新設。ファイル内の
     `import ... from "node:module"`/`"module"` 宣言を走査し、各 named import specifier の
     **`propertyName`（`as` の前の、実際に import されている名前）** が `"createRequire"`
     であればその **local 名**（`as` の後の名前、alias があればそちら）を収集
     （`localNames`）。namespace import（`import * as m from ...`）の場合はその local 名を
     別集合（`namespaceNames`）に収集。
   - `isCreateRequireExpression(expr, localNames, namespaceNames)` を新設し、
     識別子が `localNames` に含まれる場合、または `<namespace>.createRequire` の
     property access で `<namespace>` が `namespaceNames` に含まれる場合を
     「`createRequire` 自体を指す式」として判定。`collectRequireBoundIdentifiers` /
     `isRequireLikeCall`（いずれもラウンド D 新設）の、従来 `.text === "createRequire"`
     と直接比較していた箇所をすべてこの判定に置き換え。fail-closed 原則
     （リテラル文字列以外の第一引数は無条件 forbidden）はそのまま維持。
   - 自己テスト: named-import alias（`createRequire as cr`）と namespace import
     （`import * as m ...` → `m.createRequire(...)`）の計2パターンを新規追加。
     既存の直接名 `createRequire` 系5パターン（束縛・チェーン呼び出し・裸 `require`・
     非リテラル引数・対象外ロードの陰性制御）はすべて無変更で green。

### 検証結果（ラウンド E）

`RELEASE_EVIDENCE_CONTRACTS_DIR` を設定して `pnpm typecheck && pnpm test && pnpm lint` 実行、
**352 passed / 0 skipped**（ラウンド D の348件 + E-1回帰2件 + E-2自己テスト2件）、
typecheck・lint とも green。正常系の過剰 reject は引き続き 0 件。terra 指定の3件の再現攻撃は
resolved のまま。作業ツリーへの git commit は行っていない。

## ラウンド F（2026-08-27）: architecture guard の方針転換 -- 束縛追跡から supply-cut へ

terra 5巡目で、`createRequire` 束縛追跡（ラウンド D/E）の3つ目の迂回が指摘された:
computed property access（`m["createRequire"]`）、namespace オブジェクトからの
destructuring-with-rename（`const { createRequire: cr } = ns`）、単純な alias コピー
（`const copied = imported`）。いずれも round D/E の識別子追跡が監視していた
トークン形状（直接名・named-import alias・namespace property access）のいずれにも
一致せず検出できない。ラウンド D→E で1つ迂回が塞がるたびに次の迂回が出てきており、
識別子追跡という方式そのものが「構文形状の列挙」である以上、次の巡でも新形状が
出続ける構造的リスクがあると判断し、**束縛追跡の追加ではなく供給源の遮断へ方針転換**した。

1. **F-1（must: node:module supply-cut）**: `test/shadow-architecture.test.ts` に
   `findNodeModuleSupplyUsages` を新設。lock 中（`cohort-2-live-lock.json` state=locked）は、
   走査対象の production `src/**`（`src/shadow/**` と `src/shadow-cli/**` を除く）で
   `node:module`/`module` への import・export-from・require・import() 自体を、
   モジュール指定子の文字列一致のみで一律違反とする（識別子・束縛の追跡は一切行わない）。
   実装は既存の `collectModuleSpecifiers` がすでに全ての import 系サイトの指定子を
   収集している事実を利用し、そのヒットのうち `resolvable && specifier ∈
   {"node:module","module"}` のものだけを拾う薄いラッパー（`isNodeModuleSupplyHit`）を
   追加しただけ -- 新しい AST 走査は書いていない。事前に production src 全体を
   grep し、`node:module`/`require(`/`createRequire` の使用がゼロであることを確認済み
   （このコミット時点では正当な既存コードを壊さない）。既存の束縛追跡
   （`collectCreateRequireBindings` / `collectRequireBoundIdentifiers` /
   `isRequireLikeCall`）は defense in depth としてコード・テストとも変更せず残置。
2. **F-2（terra の3迂回の回帰テスト）**: 新規 describe block
   "node:module supply-cut guard: self-test on synthetic files" に、terra の3形を
   そのまま合成ファイル化した回帰テストを追加（computed property / destructuring-with-rename
   / alias-copy の3件）。いずれも `import * as m from "node:module"` 等の供給文自体を
   含むため、`findNodeModuleSupplyUsages` がその import 文一箇所を検出するだけで
   fail する（後続の消費形状を一切見ない）。加えて、"builtinModules のような
   createRequire と無関係な named export でも node:module の import自体で検出される"
   陽性コントロールと、無関係 import の陰性コントロールも追加。
3. **F-3（設計コメント）**: ファイル冒頭の terra 履歴コメントに "terra round F" 段落を追加し、
   識別子・束縛追跡（ラウンド D/E）は best-effort の defense in depth に過ぎず、
   `node:module`/`module` に対する **正本の防御は supply-cut（`findNodeModuleSupplyUsages`）**
   であることを明記。将来の保守者が新しい迂回形状を見つけるたびに束縛追跡へ機能追加を
   戻さないよう、供給源チェックがある限り消費形状の追跡は不要である理由を残した。

### 検証結果（ラウンド F）

`pnpm typecheck && pnpm test && pnpm lint` 実行、typecheck green、lint green
（フォーマット差分1件を biome の期待するクォート形式に合わせて修正済み）、
`test/shadow-architecture.test.ts` 単体で **25 passed**（ラウンド E までの18件 + F-1
本番チェック1件 + F-2 自己テスト5件 + describe 追加による内訳変動分）、
全体テストスイートは **273 passed / 45 skipped**、失敗ゼロ。作業ツリーへの
git commit は行っていない。

## terra 6巡目 最終ラウンド G（2026-08-27）: 脅威モデル明文化 + 安価な3経路の遮断で終端

対象: `~/ai_bus/logs/terra-f-evaluator-round6-20260827.log`。round F の supply-cut
（`node:module`/`module` specifier 自体の遮断）に対し、terra が specifier を一切書かずに同じ
ローダーへ到達する経路を3つ実演した:
`process.getBuiltinModule("module").createRequire(...)`（import 文なしで CommonJS ローダーへ
到達）、`eval('import("file:///.../shadow/evaluate.js")')`（Node で実際にロード成功、AST 走査は
eval に渡す文字列の内容を見ない）、base64 `data:` URL を渡した本物の `import()` 呼び出し（literal
かつ resolvable な specifier のため既存の fail-closed ルールに引っかからない）。

オーケストレータの統括判断: round D→E→F と続いた「識別子・束縛追跡 → supply-cut」という
いたちごっこは、この3経路も round D/E の束縛追跡と同型の構造的限界（次の巡でまた新形状が出る）を
持つ。しかし今回はさらに一段深い限界がある -- **この repo 内の悪意ある著者を静的走査だけで完全に
防ぐことは原理的に不可能**（その著者はこのテストファイル自体・`cohort-2-live-lock.json` 自体を
同じ変更で書き換えられる）。よって本ラウンドは (a) 安価に閉じられる3経路を閉じつつ、(b) この
ガードの脅威モデルの境界を明文化して、いたちごっこを構造的に終端させる方針とした。

1. **G-1（3経路の遮断）**: `test/shadow-architecture.test.ts` に3つの独立した検査を追加
   （変更前に production src 全体を grep し、いずれも正当利用ゼロを確認済み）。
   - `findForbiddenIdentifierUsages`: 識別子 `getBuiltinModule` の出現を、AST ではなく
     ファイル全文に対する**保守的な文字列一致**で検出（member access・computed property・
     alias 経由の import いずれも同じ literal text を含むため、この一致だけで捕捉できる。
     識別子を分割結合するような obfuscation は対象外 -- この検査自体のコメントと本ラウンドの
     脅威モデル注記の両方に明記）。
   - `findEvalAndFunctionConstructorUsages`: 実 TypeScript AST で `eval(...)` 呼び出しと
     `new Function(...)` を検出（コールバック先の識別子テキストが `"eval"`/`"Function"` の
     CallExpression/NewExpression）。渡された文字列の中身を解析するのではなく、呼び出し自体を
     無条件禁止することで、文字列内 `import()` を含むどんな variant も一括で塞ぐ。
   - `findDisallowedDynamicImportLiterals`: 既存の `collectModuleSpecifiers` が返す
     `SpecifierHit` に `isDynamicImport` フラグを追加した上で、**dynamic `import()` の
     literal specifier のみ**を対象に `"./"` / `"../"` / `"node:"`（`node:module`/`module`
     自体は round F の supply-cut が別途禁止）以外で始まるものを禁止。static import・
     export-from・require 系には適用しない（bare な npm package specifier を使う正当な
     static import を壊さないため、意図的にスコープを dynamic import() のみに限定）。
   - 3検査とも既存の `live-lock architecture guard` describe block に、既存の
     F-1（supply-cut）と同じパターン（lock 保持時のみ・`listProductionSrcFiles()` の
     default-deny 全走査）で追加した。
2. **G-2（terra の3再現の回帰テスト）**: 新規 describe block
   "terra round G self-test on synthetic files" に、terra の3経路をそのまま合成ファイル化した
   回帰テスト（`process.getBuiltinModule` 経由 / `eval('import(...)')` / `new Function` 経由 /
   base64 `data:` URL import）と、対応する陰性コントロール（相対 dynamic import・
   `node:path` の dynamic import・bare package の static import・無関係コード）を追加。全件
   green（`test/shadow-architecture.test.ts` 単体で25→36 tests）。
3. **G-3（脅威モデルの明文化）**: ガード冒頭のコメント（terra の各ラウンドの履歴をそのまま
   積み重ねてきた箇所）に「terra 6巡目」「terra round G, オーケストレータ判断」の2段落を追加。
   後者に本ガードの脅威モデルを明記: **このガードの脅威モデルは事故防止**（うっかり shadow を
   production 経路に配線する／コピペや補完による混入）であり、**同一 repo 内の悪意ある著者は
   対象外**（その著者はこのテスト自体・lock ファイル自体を編集できるため、静的走査で防ぐことは
   原理的に不可能）。悪意への防御は G フェーズの外部レビュー・branch protection・digest 束縛の
   層が担う。静的走査は必要条件であって十分条件ではない（この評価器自身の `privilege_boundary`
   predicate が自分について明記する `frozen decision` の境界と同型）。以後、同じ「悪意ある著者」
   脅威に対する新しい迂回形状を追いかけるラウンド（ラウンド H 以降）は想定しない、と明記した --
   次にラウンドを起こす根拠になるのは、迂回ではなく新しい「事故的な誤配線」の形状が見つかった
   場合のみである。

### 検証結果（ラウンド G）

`pnpm typecheck && pnpm test && pnpm lint` 実行、typecheck green、lint green
（フォーマット差分1件を biome `--write` で自動整形済み -- 内容の変更は無い）、
`test/shadow-architecture.test.ts` 単体で **36 passed**（ラウンド F までの25件 + G-1
本番チェック3件 + G-2 自己テスト8件）、全体テストスイートは **284 passed / 45 skipped**
（`RELEASE_EVIDENCE_CONTRACTS_DIR` 未設定、既存の contracts-dir 依存 skip 規約どおり）、
失敗ゼロ。src には一切触れていない（`test/shadow-architecture.test.ts` と本ファイルのみ変更）。
作業ツリーへの git commit は行っていない。
