# vendored: ai-agent-skills-playbook contracts/shared

これらのファイルは https://github.com/shiki-yusuke/ai-agent-skills-playbook の `contracts/shared/` から**そのままコピー**した
ものです（D8: 契約側の共有実装を独自再実装しない）。release-evidence リポジトリは playbook を
import path で直接参照しない（相対 import で他 repo のファイルを読まない）ため、実行時に必要な
分だけこの下にコピーして固定しています。

更新するときは同じ手順（コピー→sha256 再計算→この表を更新）を繰り返してください。差分が
出た場合は取得元 commit を進めてから再コピーすること。

## 取得元

- repo: https://github.com/shiki-yusuke/ai-agent-skills-playbook
- commit: `f9f0c127588f60fd299a02859c9f70f0b81a9dcc` (merge of PR #18 "feat/shared-validator-oneof"; upstream `main` の ancestor であることを `git merge-base --is-ancestor` で確認済み)
- 取得日: 2026-08-23

前回 pin (`45e2c1b261c06632e9260a17b51c27249a911f68`, 2026-08-22) からの差分は
`schema-validator.mjs` の oneOf 評価追加のみ (upstream I-2026-08-23-shared-validator-oneof)。
oneOf 未評価の間、release-evidence-bundle.schema.json の `lane_ref` / `review` は任意の値を
素通ししていた (このリポジトリの validateBundle() がまさにその schema を検証する)。
`jcs.mjs` / `personal-dimensions.mjs` は両 commit 間で byte 一致 (git diff --quiet で確認)。
export 形状は不変のため `schema-validator.d.mts` の変更は不要。

## ファイルと sha256

| file | source path | sha256 |
|---|---|---|
| `jcs.mjs` | `contracts/shared/jcs.mjs` | `d63d711b9c8e3b9ecf7be0733c29518fa25cf1307470f88c42379e043638db13` |
| `schema-validator.mjs` | `contracts/shared/schema-validator.mjs` | `b48121a2b744ce924442df9a14d65d703b70c49da51d17966bc924586d5a8367` |
| `personal-dimensions.mjs` | `contracts/shared/personal-dimensions.mjs` | `0bae6135d71be21abc61f8a0b3823cb97e38c94a066dd9a921099e3240b8159d` |

`types.d.ts` はこのリポジトリ独自の追加物（vendored ファイルではない）: 上記 3 ファイルは
plain JS (`allowJs` なし) なので、TS 側から `@ts-expect-error` なしで import できるよう薄い
型宣言を手書きしている。vendored ファイル自体を変更したときは型宣言も合わせて見直すこと。

## 2026-08-23 upstream 履歴書き換えの注記

upstream playbook は 2026-08-23 に commit metadata から企業メールを除去するため全履歴を
`git filter-repo --mailmap` で書き換えた。tree/blob は byte 一致のため上記 sha256 は全て不変。
本ファイルの commit id は旧→新 map (ローカル ~/oss-space/.email-rewrite-20260823/
ai-agent-skills-playbook-commit-map.txt に恒久保存) で再ポイント済み。過去の commit 記録
(例: 旧 a8817f9 / 旧 581ad9db) は書き換え前の id であり、当該 map 経由でのみ解決できる。
