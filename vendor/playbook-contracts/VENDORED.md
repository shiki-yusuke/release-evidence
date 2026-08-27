# vendored: ai-agent-skills-playbook contracts (review-findings/v1, promotion-receipt/v0, release-approval/v0)

これらのファイルは https://github.com/shiki-yusuke/ai-agent-skills-playbook の以下のディレクトリから
**そのままコピー**したものです（D8: 契約側の実装・fixtures を独自再実装しない。
vendor/playbook-shared/VENDORED.md と同じ方式）:

- `contracts/review-findings/v1/`
- `contracts/promotion-receipt/v0/`
- `contracts/release-approval/v0/`
- `docs/protocols/{promotion-receipt-v0,release-approval-v0,review-findings-v1}.md`

release-evidence リポジトリは playbook を import path で直接参照しない（相対 import で他 repo の
ファイルを読まない）ため、実行時に必要な分だけこの下にコピーして固定しています。F shadow
評価器（`src/shadow/**`）が読む review-findings/v1・promotion-receipt/v0・release-approval/v0 の
3契約のうち、schema・fixtures・protocol md をここに配置。既存の `release-evidence/v0` 契約は
従来通り `RELEASE_EVIDENCE_CONTRACTS_DIR` 経由で参照する（vendor しない）。

更新するときは同じ手順（コピー→sha256 再計算→この表を更新）を繰り返してください。差分が
出た場合は取得元 commit を進めてから再コピーすること。

## 取得元

- repo: https://github.com/shiki-yusuke/ai-agent-skills-playbook
- commit: `f9f0c127588f60fd299a02859c9f70f0b81a9dcc` (Merge pull request #18 "feat/shared-validator-oneof"; ローカル main HEAD が origin/main と同一であることを `git fetch` 後 `git diff HEAD origin/main -- <対象ディレクトリ>` で確認済み。`vendor/playbook-shared/VENDORED.md` と同一 commit)
- 取得日: 2026-08-27

## ファイルと sha256

| file | sha256 |
|---|---|
| `docs/protocols/promotion-receipt-v0.md` | `2dd606595cae59bf21d7d9d2fe848d9b187b87f7b553e8d059381bc52485b73e` |
| `docs/protocols/release-approval-v0.md` | `5ec97b473645f42d1b3bd9eaa9e85dc510761bdd6d08a6161613cc9ef9a1c7dd` |
| `docs/protocols/review-findings-v1.md` | `0b56e010990365d48577e2b77b18935d1eda1fd4de7a8e2753c57693dca98db6` |
| `promotion-receipt/v0/fixtures/accept-abstained-unknown.json` | `f914924fda8e89ab8fc1f6c56331c66211625d1177be776c735cf3ed3a20fd0a` |
| `promotion-receipt/v0/fixtures/accept-ineligible-contradicted.json` | `54792ee46c0a17c8b9ffa250b044a61b254241622fbc4fb87a7a9cf19990a7c3` |
| `promotion-receipt/v0/fixtures/accept-post-deploy-readback.json` | `2dcb2d650f5b9b35a7d554fa82b6ab9972180e968539ae3573bf60625e038428` |
| `promotion-receipt/v0/fixtures/accept-ready-for-approval-all-satisfied.json` | `f210ca7ddd1a4bd761a21d623ff59cbaf5b0b5ebf73d4ab93ab0bbe0f3b8ded3` |
| `promotion-receipt/v0/fixtures/expected-results.json` | `2d2d69922daf2f3bc4722c222ae499d616d5774c1cf2642b33b017e1cbd98956` |
| `promotion-receipt/v0/fixtures/invalid-additional-property-confidence.json` | `b16fe1a47c9d73bb92643213136c2e1d31ff9d1574e4cc670121a8c348ad3a88` |
| `promotion-receipt/v0/fixtures/invalid-evaluated-at-not-real-date.json` | `ad2965191b6203b4312d0b1881e9e9934daef8946454c2a52f4e32f02af4091b` |
| `promotion-receipt/v0/fixtures/invalid-not-applicable-status-not-unknown.json` | `2422ff7271e3d986f14021b70757183d257fc958fecefe82171e5dc52a1b3db1` |
| `promotion-receipt/v0/fixtures/invalid-offset-timestamp.json` | `e77acc962ced41a78ef043c5214afc9f286f4412347e7da8d5aa10e7f6ae399e` |
| `promotion-receipt/v0/fixtures/invalid-other-only-evidence-for-satisfied.json` | `26d3bb554ddacf9060738908939e04aa42118b9f5cf989a749968a90fb2a3a3b` |
| `promotion-receipt/v0/fixtures/invalid-phase-predicate-mismatch.json` | `5d9ea058f90cdee60ed861a7ecd1a2756923b93abcd5048a55a951bb98efa7cb` |
| `promotion-receipt/v0/fixtures/invalid-post-deploy-readback-not-applicable.json` | `8b95b637bec5e5e493cd931570b426a77894043770736abed8536256eeab41c8` |
| `promotion-receipt/v0/fixtures/invalid-predicate-all-not-applicable.json` | `14f29d30b74c4b3cb9bff63115a7eea6e78654330ad1ce11f7acb9a9c28bc86c` |
| `promotion-receipt/v0/fixtures/invalid-predicate-always-on-not-applicable.json` | `4ed6a5bc590156f4ca77973283d9604a8299cf7068c3d5f5097786fbf2dbc8d1` |
| `promotion-receipt/v0/fixtures/invalid-predicate-duplicate.json` | `aae8c8b0091604bb928462a5da333620b8fd14fe5dc71d2aff74b5118db41865` |
| `promotion-receipt/v0/fixtures/invalid-predicate-human-release-approval.json` | `5bc63925ebe3b48dd2f52dc25b5786d2c0f8f6658b0b1bc11bfd412e9f5a3364` |
| `promotion-receipt/v0/fixtures/invalid-predicate-missing.json` | `f56b40579c1015322897c34a5629055c216503097d51a2aff97b5b428de2336d` |
| `promotion-receipt/v0/fixtures/invalid-satisfied-without-evidence-refs.json` | `5650834d101fc9ca663695805b53a54d486a3ec94e42f888f8abd7fb98d79c68` |
| `promotion-receipt/v0/fixtures/invalid-verdict-eligible-not-allowed.json` | `1ed57d02607e2c398818d95db2e5a408686617ab24a8c28058178528e01e8dbc` |
| `promotion-receipt/v0/fixtures/reject-contradicted-but-verdict-abstained.json` | `bd5b797baac9d59de4ef71387f3f041aa1a586ae36fba521d8d8e1aff5f33ea8` |
| `promotion-receipt/v0/fixtures/reject-semantic-digest-tampered.json` | `a256f4bc917c16fe4602816ba3fbf7820b2ea5497ad8757b253a3dd033e64605` |
| `promotion-receipt/v0/fixtures/reject-unknown-but-verdict-ready.json` | `1ab3263eca9435ed96ad051d86be0913a594eb42b9d15350c02fd6b04dad2c5f` |
| `promotion-receipt/v0/promotion-receipt.schema.json` | `e845028606ed82a0ff706ab028bf6452ed3a6d0b85549861c807b7e6aad80730` |
| `promotion-receipt/v0/verify-fixtures.mjs` | `b89cd58e156cc3cb5b6465e27d5be513c169b9c3ff4434ec3f70c67fc15b0673` |
| `release-approval/v0/fixtures/accept-composite-break-glass-on-non-ready-receipt.json` | `f734b0026cc40d88c63a0d3ef2c059dcdf2d1d1a1153dc46f464abcbeb23232c` |
| `release-approval/v0/fixtures/accept-composite-grant-then-revoke.json` | `4ad9da97fa754f67c7927366016aa742d2cd6df554dcec01b5d434d06110a737` |
| `release-approval/v0/fixtures/accept-composite-happy.json` | `3ac0929af360e2bcfaa194c4db05744a1451dee6daf5fc2c548392696424b4b9` |
| `release-approval/v0/fixtures/accept-composite-revoke-subject-key-order.json` | `56157086a7ada10dc648077cf6f5089e0ccd9b7cd41c18eee639689813a75501` |
| `release-approval/v0/fixtures/accept-event-approval-granted.json` | `f2cfeaef0578fd30215a4c74669c4c599890463a7459dbf72f49a27e949d614f` |
| `release-approval/v0/fixtures/accept-event-break-glass.json` | `f59e248818b827e845720aca1f37cc8dad5cc2c2f8f5a651e3a6894798e248a6` |
| `release-approval/v0/fixtures/expected-results.json` | `74140fccd7cff77605a65835149ad866a9d49902f30a2e25dc3db96da8db4bfd` |
| `release-approval/v0/fixtures/invalid-additional-property-confidence.json` | `0dbdb8c66f09c58640050710000c515abd0e7160d7780e39b594ceca490aaa02` |
| `release-approval/v0/fixtures/invalid-approval-granted-missing-expires.json` | `57cfbbacc03a308a1d201c872944812358f68ca51d165de13aa271b4b167faac` |
| `release-approval/v0/fixtures/invalid-break-glass-bypassed-predicates-duplicate.json` | `26989915a53074914d489241b6cc9f2b13e7a7240479846a7a59f8d299eb0db9` |
| `release-approval/v0/fixtures/invalid-break-glass-empty-bypassed-predicates.json` | `07ebe8aa5e8ee912a35ea7b1dbc81ea1bd4a962ecbde862fb7d3b698a68bd7af` |
| `release-approval/v0/fixtures/invalid-break-glass-missing-bypassed-predicates.json` | `54431c5a5d4984fb931973fb1a98028285a5fcddf02a1d231f0425b9fd7f4027` |
| `release-approval/v0/fixtures/invalid-break-glass-missing-expires.json` | `4a48a7ddc2e561566098a306befd6403a3ad4d4749822c2a1127908b1f2be2b8` |
| `release-approval/v0/fixtures/invalid-break-glass-missing-incident-ref.json` | `e6e8c1337b45914747f16ea7ed8c614363ee5b35c387d47c3e595e63152af9e1` |
| `release-approval/v0/fixtures/invalid-expires-at-not-real-date.json` | `d0df1002573f6f9a18cda0bd968b24322615f1abd1d5eb40d052a0618ac2bdba` |
| `release-approval/v0/fixtures/invalid-expires-at-on-rejected.json` | `a035a5362c93c740c1b4fb52eb659b0dcb2c927da536daf086bb73fbe2e025f6` |
| `release-approval/v0/fixtures/invalid-expiry-not-after-occurrence.json` | `4f67d06ab06c30f695cffd33570f3ef9249f07908ed855e4a7ea2107d2a1fb3b` |
| `release-approval/v0/fixtures/invalid-occurred-at-not-real-date.json` | `da9f35370acde1d142b5fb005b1c6abf8373d922887410f9bc8f8a18e00777dc` |
| `release-approval/v0/fixtures/invalid-offset-timestamp.json` | `fe166368444d73302b4f34be5e13d1dfd637ccdf5fa13091260286a8f5236fd7` |
| `release-approval/v0/fixtures/invalid-principal-id-with-at-sign.json` | `71c2683496898d1ab3dc6cf40c30d97ae695c5741f288383742bef75d50eacb8` |
| `release-approval/v0/fixtures/invalid-revoked-without-target-event-id.json` | `ae0e989b37fa316f9851f27b116f35286afadf3f7cb5afc9681b14fac26c18bf` |
| `release-approval/v0/fixtures/reject-composite-anchor-invalid-format.json` | `5d073ee4c95db15c0e3b0f2b32971bd3ed083a2e4d757da1d280b01da79e421f` |
| `release-approval/v0/fixtures/reject-composite-anchor-nonexistent-finding.json` | `27f00964bcafd4beca17ada73136a64e3f67735cae900eb36e457370ced1cbc6` |
| `release-approval/v0/fixtures/reject-composite-anchor-scope-misuse.json` | `e21973fb2b1bb41a7b197cd3754e08bc0b7ec83983dd371955a8552b5b33a3c6` |
| `release-approval/v0/fixtures/reject-composite-approval-before-evaluation.json` | `7a1dcf5a6a37056dc504a4ffbde3b230692255d8d2d0ad22ef833b93db65bef3` |
| `release-approval/v0/fixtures/reject-composite-approval-granted-non-ready-receipt.json` | `43579ea3dcbc54691e43ae3a1d39b305cdcddf19176fee37ae0c6bba6cd57d4f` |
| `release-approval/v0/fixtures/reject-composite-bundle-digest-unresolved.json` | `8930c26dd05501bc5c9d30264aac7289f6c93318fa647199e04a1fdfe48d4298` |
| `release-approval/v0/fixtures/reject-composite-bypassed-predicate-not-in-receipt.json` | `f825599b51fdef2199164b4714dbe412cc08f8ed0709db1cce5370397f93cf33` |
| `release-approval/v0/fixtures/reject-composite-claim-replaced.json` | `660cf139c0052d7c7ac6ca9556c30fa0c8af1423f45f72d435f64848ac6dd3d1` |
| `release-approval/v0/fixtures/reject-composite-duplicate-event-id.json` | `4aa2330eae2e77243190d117475398ec1d32385ca728b63e5358094558528ed2` |
| `release-approval/v0/fixtures/reject-composite-embedded-bundle-duplicate-digest.json` | `30d8a40ace31b1d7d26061323d1e1fb89afee61378ee5c236390e6d9372e60dc` |
| `release-approval/v0/fixtures/reject-composite-embedded-bundle-lane-ref-array-type.json` | `c0e55d30f11a29e429a338432c3cc6da664f519da71223b536d44cb623ead8e5` |
| `release-approval/v0/fixtures/reject-composite-embedded-bundle-lane-ref-union-violation.json` | `a0e767a4ae8aed38df532cdab4a44d3e7fd20774b8668d297c100c52cef93abd` |
| `release-approval/v0/fixtures/reject-composite-embedded-bundle-review-array-type.json` | `892d72e46618e2c473aabecc65f3bce84c672a2eaf9df90579c0978bfda1f469` |
| `release-approval/v0/fixtures/reject-composite-embedded-bundle-review-union-violation.json` | `0816c9836c5fb4fdf51af1717a255fc9bf44ff555e67e1d5fb39c4cd59abdfe0` |
| `release-approval/v0/fixtures/reject-composite-embedded-bundle-schema-invalid.json` | `4a2ec95320d4f082526a1963ef7a05fc85727d0d2b199346f2b08b04062861cb` |
| `release-approval/v0/fixtures/reject-composite-evidence-ref-wrong-digest.json` | `1862b460e0ffe94ba662fc15f45fbe5bd262e22dd0309006c20aebd6ebc53faf` |
| `release-approval/v0/fixtures/reject-composite-fake-receipt-digest.json` | `c87590b89632313b0887efc6b90772b3a1a0fdb61daab1ad10eaff17f8f6230d` |
| `release-approval/v0/fixtures/reject-composite-release-evidence-digest-mismatch.json` | `47bb48759ed89644a794d523243726478802749f24d8a5406d58ea4fca756283` |
| `release-approval/v0/fixtures/reject-composite-release-evidence-no-bundle.json` | `74afd16a0ff0bc78153d3313eb507608051d02945458aee75a6a9690cf6ee9ce` |
| `release-approval/v0/fixtures/reject-composite-revoke-before-grant.json` | `10b6d178f139a1e2cf15ca5469aba0473f855db2ce83465c0f661510134efeef` |
| `release-approval/v0/fixtures/reject-composite-revoke-dangling.json` | `dee64c029f4ca02a9c539191ad75d28dc4ebaa26c7951af629662a570ef20b76` |
| `release-approval/v0/fixtures/reject-composite-revoke-subject-mismatch.json` | `450a96e56ffcf12c710bc3723bba5543154a6c469d57bdf183fb233665fe4df3` |
| `release-approval/v0/fixtures/reject-composite-revoke-wrong-kind.json` | `4235f63d5b8b354e91f4b23a41b8a98dbfaf88a607471c96788869e45949d617` |
| `release-approval/v0/fixtures/reject-composite-stale-bundle-digest.json` | `4da5653fa70fc3f55130bd784141d777353c8b555744fbdb9a9f744253251098` |
| `release-approval/v0/fixtures/reject-event-id-tampered.json` | `9cd69c05505fe42e8fd066a52c1a9f344d6d23728e6da0db3f516cc38644ebcc` |
| `release-approval/v0/release-approval-event.schema.json` | `760cf26c95e3aba6660341374c33ebcec088bb80d00c66c906730a6af9d73cc3` |
| `release-approval/v0/verify-fixtures.mjs` | `d70487a444a5daa79e22be96dac136258b7e382ff7dcea9afed660d5df1055e1` |
| `review-findings/v1/fixtures/accept-abstained.json` | `652fdab6991e70585d44db000a548ef3a86d218441396fcf87ad5421a5588a79` |
| `review-findings/v1/fixtures/accept-findings-observed-human.json` | `e763fbff9e26fc37c5dfd7366efd5fa29dc6b514ff477387b37dd8eb74b51ee2` |
| `review-findings/v1/fixtures/accept-findings-observed-model-multi.json` | `7faad3a9278f6ade13139cd484ba83ff6491e5de672d0d957992e37044b1add0` |
| `review-findings/v1/fixtures/accept-none-observed.json` | `fdb197782c78c947e422e3723a13d3b56a7fc9a69f8ecf4a20718e64d4ae2751` |
| `review-findings/v1/fixtures/expected-results.json` | `e7ba60296ccdad22c90d00ba01d851ac87ab323547815710dac684e86da6a2f2` |
| `review-findings/v1/fixtures/invalid-abstained-missing-abstention.json` | `fdc7731b9550cea669ad4c52baa0fe0677656acc37ec13fa88a096b9f50d3741` |
| `review-findings/v1/fixtures/invalid-additional-property-confidence.json` | `4f8bd09344c0f276d59a8fa32934720e91301183ca0907c2e8680acb70ef0192` |
| `review-findings/v1/fixtures/invalid-assessor-human-cohort-present.json` | `44ee131f77f8170a34a51d3d5f469f4df956482b51bf52afb187bbf9f6796148` |
| `review-findings/v1/fixtures/invalid-assessor-model-cohort-null.json` | `e6f84d733a9f5b5e8c4a72ed801ded1c103e310b5e4e60fdaef9616a53597420` |
| `review-findings/v1/fixtures/invalid-category-not-in-enum.json` | `a005da2c0c9e0ceadf544dbc3c7adfa54f94a4cd2f94e54f125f973eb984dbed` |
| `review-findings/v1/fixtures/invalid-findings-observed-empty-findings.json` | `7c519934f26b184327052acca4ee26e369ac91863dd5efbbed3e25e6ec3d51a1` |
| `review-findings/v1/fixtures/invalid-findings-observed-with-abstention.json` | `adafca4b057ec6d94e07849079ef6e8474ca949db1db09fede6d103a9e6b39d1` |
| `review-findings/v1/fixtures/invalid-location-line-order.json` | `ba91e16d8f176008d60c7458bb066c7ab262f20f748239016afb50c52b49976c` |
| `review-findings/v1/fixtures/invalid-location-line-partial.json` | `987fb47f5817385b5e1d64fbb7709556b4d6e2795eaa04c59bf6724bb4ba0e5e` |
| `review-findings/v1/fixtures/invalid-location-zero-line.json` | `35193c07393b0a5570f129d9be42639aca9194500fecba6038b28c0063dcc214` |
| `review-findings/v1/fixtures/invalid-none-observed-empty-lenses.json` | `ccb5564dbd1c4c4a6f5a82aec91592cd26d579dfe3f154dbfeb08192eca7dd03` |
| `review-findings/v1/fixtures/invalid-none-observed-empty-paths.json` | `94a92fa7798cd60dc65917d6e1d6bd93162fc4cb2be5dc6311a0dff2f55b71b9` |
| `review-findings/v1/fixtures/invalid-offset-timestamp.json` | `5d2cb43a03d43a467c2da945bdfd93827a817ca3ad71c13cd5155065f94fc8f0` |
| `review-findings/v1/fixtures/invalid-recorded-at-not-real-date.json` | `ea5590cdece6a8b9f4768f448526061708bf2c840bbcafc71858cdcc3dbc7e82` |
| `review-findings/v1/fixtures/invalid-required-verdict-not-proven.json` | `fac24d6857d62c91294e6686fb7e41c1ddf365f50b7dcf5fbb8d37889c09bec1` |
| `review-findings/v1/fixtures/invalid-severity-not-in-enum.json` | `c7e12b11da9b36d391d43b3a86d055c5f799cabd4f60a19e7c94b5ef397dda02` |
| `review-findings/v1/fixtures/reject-duplicate-finding-id.json` | `122efbd04b5b73ba740b347ffd87b574cda597f7f320610c90ec82b383e21a53` |
| `review-findings/v1/fixtures/reject-numeric-confidence-in-params.json` | `d909239bf8fdabdea4d58d9934c2784febfd819066f57a45194864acf9cfa5a6` |
| `review-findings/v1/fixtures/reject-personal-dimension-in-params.json` | `f77ff67eae0c332ef6c5ec2fb879eb55e5e709431b14b55203e662a0d16fc439` |
| `review-findings/v1/review-findings.schema.json` | `99aa2c7f02685500fbddc87e36c96296e1b1a5cf345cbb53eebe952de3f77225` |
| `review-findings/v1/verify-fixtures.mjs` | `8905ecf5a755a10e6b5dfa0e9f4666a8fa7051d2d229fdc46c08da7208ec4334` |

## 注記

- `review-findings/v1/fixtures/expected-results.json` / `promotion-receipt/v0/fixtures/expected-results.json` /
  `release-approval/v0/fixtures/expected-results.json` は各契約の reference verifier (`verify-fixtures.mjs`) が
  読む期待値マニフェスト。conformance テスト（chunk 1: input/reasons/resolver/serialize 相当分、predicate 評価は
  chunk 2）はこの3ファイルを playbook 側と同じ形で読み、fixture 追加時の drift を検知する。
- `verify-fixtures.mjs` は各契約の reference 実装（Node 実行、`ajv` 等の外部依存なし）。この扱いは
  F shadow 評価器の中で2種類に分かれる（terra 実装レビュー must 修正ラウンド B、2026-08-27 に
  確定）:
  - **record CONTENT の検証**（bundle/release_event/review_finding_record、`src/shadow/
    contracts.ts`）は依然 import せず、TS 側の手書き mirror で同等の schema・semantic MUST を
    再実装する（既存 `src/core/bundle.ts` / `event.ts` が release-evidence/v0 に対して行って
    いるのと同じ方式、shadow core の fs 禁止のため）。terra 実装レビュー round C
    （2026-08-27）まで review_finding_record は schema と observed_at 一致のみで、
    review-findings/v1 自身の semantic MUST（finding_id 重複禁止・locations[] の
    start_line/end_line 整合・numeric confidence 禁止・personal-dimension scan）は未実装だった
    ―― `reviewFindingContentSemanticChecks`（`contracts.ts`）で埋めた。release ledger の
    fold/collection 検証（孤立 event の illegal_transition 等）は record CONTENT 検証ではなく
    `src/shadow/evaluate.ts`（`foldAttemptEvents`、`src/core/fold.ts` の `foldAttempt` を
    そのまま再利用 -- fs を持たない純粋関数のため import 可）が `preview_verified`/
    `rollback_target_valid` の satisfied 判定の直前に行う。
  - **candidate_receipt の full-fidelity 検証**（`src/shadow-cli/vendor-loader.ts`、CLI 層のみ
    ―― fs は許可されている）は、この手書き mirror では検証できない semantic MUST（predicate-set
    completeness/no-duplicate、resolvable-evidence-kind、real-calendar `evaluated_at`、
    `semantic_digest` 再計算、verdict 導出）を埋めるため、`promotion-receipt/v0/
    verify-fixtures.mjs` の `checkReceipt`（および review-findings/v1 の `checkRecord`、
    `test/shadow-replay-pack.test.ts`・`test/shadow-tamper.test.ts` から使用）を実際に
    dynamic import して実行する。`../../shared/*.mjs` の相対 import を解決するため、実行時に
    playbook 側の元ディレクトリ位相を一時ディレクトリへ再構築する（`test/
    shadow-conformance.test.ts` が conformance テスト用に既に使っている手法と同じ）。vendor/
    自体は一切書き換えない。
