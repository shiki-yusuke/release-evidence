# 実 release corpus のリプレイ検証(sol 実装ステップ12)

正本は `spec.md` / `implement-notes.md`。この文書は `docs/replay-pack-format.md` 「Real-corpus
replay (not done by this chunk)」で明示的に「別途、人間が行う」とされていた作業(sol 設計ログ
step 12: 実 release corpus を再走行し、unknown 分布と false allow を人間確認)の実施記録。
**コード変更は行っていない**(`src/**`/`test/**` は読むだけ)。

## 対象データ

agent-metrics-harvester リポジトリ(`metrics-data` ブランチ)由来の実 corpus:

- `release-events.jsonl`: 15 event = 5 release × `prepared`/`deployed`/`verified`
- `bundles/bundle-*.json`: sealed `release-evidence/v0` bundle 5件

5 release とも `agent-metrics-dashboard` の scheduled/dispatched rebuild
(`bundle.lane_ref_omitted.code === "no_lane_scheduled_rebuild"`, review も
`review_omitted.code === "scheduled_rebuild_deploys_reviewed_main"`)。lane を経由しないため、
selection process 自体が発生していない release 群である。

作業場所(この repo の外, scratchpad):
`/private/tmp/claude-1659722564/-Users-a13714-oss-space/3abf38b8-a849-4a9d-9de5-18bf4c0be0a7/scratchpad/real-replay-packs/<release_id>/`
に 5 パックを `docs/replay-pack-format.md` 形式(`input.json` + `README.md`)で作成した。

## 機械的に導出した値と、正直な unknown にした値(捏造していない箇所)

- `subject.bundle_digest` / `records[].content`(bundle 本体・release_event 本体): 実データを
  そのまま埋め込み。**組み込み前に `recordContentDigest`(JCS canonicalize + sha256, この
  リポジトリの `src/shadow/serialize.ts` と同じ関数)で再計算し、release-events.jsonl が宣言する
  `bundle_digest` と全 5 release で一致することを確認済み**(下記「事実確認」参照)。
- `records[].observed_at`(release_event): `occurred_at` をそのまま使用。
- `evaluation_cut`: その release の最終 event(`verified`)の `occurred_at` + 1ms。「最終 event
  直後」を機械的に表現(ちょうど同時刻だと `resolver.ts` の `isAfterCut` は非包含側に倒れず
  その event 自身を読み込んでしまう、という理由で厳密に +1ms とした)。
- `subject.target`: `"production"`(release_event の `environment` と一致)。
- release 2〜5 の `subject.rollback_previous_bundle_digest`: 実 corpus 内に存在する前 release の
  bundle digest(前 release 自身の bundle content と event 3件も `records[]` に追加-- 手順は
  `docs/replay-pack-format.md` の「Building a pack from a real release」手順2に従った)。release 1
  は `bundle.rollback.previous_release_id === null` のため省略。
- **`subject.selection_manifest_digest`(意図的に非解決)**: 実 corpus にはこの 5 release いずれの
  selection_manifest も存在しない(lane が無いスケジュール rebuild であり、selection process
  自体が発生していないという実データ上の事実)。本物らしい値を作る代わりに、意図的に解決不能な
  sentinel `sha256:0000...0`(64桁の0)を入れ、`records[]` にも `selection_manifest` kind の
  record は一切入れていない。
- `policy.digest`: `null` + `absent_reason.code="policy_snapshot_absent"`(schema 必須の正直な
  declaration。実 corpus に policy_snapshot 相当のデータは存在しない)。
- `subject.review_finding_digest`: 省略(`bundle.review === null` かつ対応する
  review_finding_record も実 corpus に存在しない)。
- `contract_pin.playbook_commit`: `f9f0c127588f60fd299a02859c9f70f0b81a9dcc`(`vendor/
  playbook-contracts/VENDORED.md` に記録されている、現在この repo が実際に pin している値。
  プレースホルダーではない)。

### 唯一の非機械的仮定(分析結果に影響しない)

`policy.effective_risk = "medium"`。schema 上必須の enum で「未定」を表現する手段が無く、かつ
どの predicate も `policy_snapshot` の内容を読まない(`evaluate.ts` のコメントで明言)ため、
verdict・predicate 結果には影響しない。実 corpus にリスク値の記録はなく、これは管理メタデータの
仮置きであり証拠として扱っていない。

## 事実確認: bundle digest の再計算検証

`dist/src/shadow/serialize.js` の `recordContentDigest` を使い、5 bundle すべてで
「宣言された `bundle_digest`」と「bundle content から再計算した digest」が一致することを
先に確認した(この確認自体はコード変更ではなく、pack構築前の検証手順):

| release_id | 宣言値と再計算値 |
|---|---|
| `agent-metrics-dashboard@32572501427-1` | MATCH |
| `agent-metrics-dashboard@32615972524-1` | MATCH |
| `agent-metrics-dashboard@32687508604-1` | MATCH |
| `agent-metrics-dashboard@32806015116-1` | MATCH |
| `agent-metrics-dashboard@32927560937-1` | MATCH |

## 実行方法

```
node dist/src/shadow-cli/main.js replay --input <pack>/input.json --out <pack>/eval-run1.json
node dist/src/shadow-cli/main.js replay --input <pack>/input.json --out <pack>/eval-run2.json
cmp <pack>/eval-run1.json <pack>/eval-run2.json
```

## 結果: 5 release の集計

| release_id | evaluation_status | unknown_reasons (wrapper) | candidate_receipt / verdict | predicate_observations 件数 | CLI exit code | byte 比較(2回実行) |
|---|---|---|---|---|---|---|
| `...@32572501427-1` | unknown | `unknown_structural`(selection_manifest 未解決) | null | 0 | 0 / 0 | IDENTICAL |
| `...@32615972524-1` | unknown | `unknown_structural`(同上) | null | 0 | 0 / 0 | IDENTICAL |
| `...@32687508604-1` | unknown | `unknown_structural`(同上) | null | 0 | 0 / 0 | IDENTICAL |
| `...@32806015116-1` | unknown | `unknown_structural`(同上) | null | 0 | 0 / 0 | IDENTICAL |
| `...@32927560937-1` | unknown | `unknown_structural`(同上) | null | 0 | 0 / 0 | IDENTICAL |

**evaluation_status 分布**: `unknown` × 5 / `evaluated` × 0 / `invalid_input` × 0
**verdict 分布**: `abstained`/`ready_for_approval`/`ineligible` はいずれも 0(`candidate_receipt`
自体が全 5 release で `null` -- verdict は生成されない)
**述語(6種)の status 分布**: 全 6 種 × 5 release とも「評価未到達」(`predicate_observations`
配列が空 = 0件)。`evaluate.ts` のラッパー gate(`subject.selection_manifest_digest` 未解決 →
`evaluation_status="unknown"`)が predicate 評価そのものより手前で全件を止めているため、
6種の述語(artifact_identity / review_admissibility / verification_coverage /
preview_verified / rollback_target_valid / privilege_boundary)は一度も評価されなかった。
**reason code 分布**: `unknown_structural` × 5(wrapper 直下 `unknown_reasons`)、他の
reason code(`not_yet_recorded` / `lane_ref_omitted` / `referent_unresolved` /
`not_applicable_by_policy`)は 0 件。`input_errors` も全 release で空(`invalid_input` は
1件も発生していない)。

## byte 比較(決定論の実測)

5 release すべてで、同一 `input.json` を別プロセスで2回実行した `--out` ファイルが
`cmp` で **差分ゼロ**(IDENTICAL)。CLI exit code も両実行とも `0`(`evaluation_status=unknown`
は spec.md の言う「正常に記録された結果」であり、tool failure や invalid_input ではない)。

## 気づき・false allow 兆候の有無

- **false allow の兆候: なし。** 5 release すべてで `candidate_receipt` は `null` であり、
  「証拠が無いのに `satisfied`/`ready_for_approval` が出た」ケースは1件もない。selection_manifest
  という、この実 corpus が構造的に持ち得ない情報について、評価器は fabricate も default-allow も
  せず、正直に `unknown_structural` で止まった。これは `test/fixtures/replay-packs/
  lane-ref-omitted/README.md` が事前に立てていた期待(「非lane release は verdict=abstained
  になるはずで、satisfied が出たらバグ」)と整合する挙動そのもの。
- **今回の実 corpus では、6種の述語ロジック(evalArtifactIdentity 等)の実挙動を一切検証できて
  いない。** ラッパー gate が predicate 評価の手前で全件止まるため、「実データに対する述語の
  振る舞い」は今回の 5 release では未実証のまま。これは評価器の欠陥ではなく、この特定の実
  corpus(全件 lane 無しのスケジュール rebuild)の性質による限界 -- 述語ロジックの実データ検証
  には、lane を経由した release(selection_manifest が実在するもの)の corpus が別途必要。
- **`selection_manifest` はこの evaluator の入力契約上、lane を経由しない release を構造的に
  評価不能にする。** agent-metrics-dashboard のような「lane 無しスケジュール rebuild」運用が
  今後も real corpus の主要な形になるなら、この evaluator を shadow 以外の用途に広げる前に
  「lane 無し release の unknown をどう扱うか」を仕様側で決める必要がある(現状は「常に
  unknown」で一貫しており、これ自体は正しい)。
- 決定論(2プロセス byte 比較)は 5/5 で確認済み。TZ/locale 等を変えた比較は今回のスコープ外
  (既存の `test/shadow-*.test.ts` が担う領域)。
