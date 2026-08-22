# vendored: ai-agent-skills-playbook contracts/shared

これらのファイルは https://github.com/shiki-yusuke/ai-agent-skills-playbook の `contracts/shared/` から**そのままコピー**した
ものです（D8: 契約側の共有実装を独自再実装しない）。release-evidence リポジトリは playbook を
import path で直接参照しない（相対 import で他 repo のファイルを読まない）ため、実行時に必要な
分だけこの下にコピーして固定しています。

更新するときは同じ手順（コピー→sha256 再計算→この表を更新）を繰り返してください。差分が
出た場合は取得元 commit を進めてから再コピーすること。

## 取得元

- repo: https://github.com/shiki-yusuke/ai-agent-skills-playbook
- commit: `581ad9db626687a50de67d0a22119e64733c71f1`
- 取得日: 2026-08-22

## ファイルと sha256

| file | source path | sha256 |
|---|---|---|
| `jcs.mjs` | `contracts/shared/jcs.mjs` | `d63d711b9c8e3b9ecf7be0733c29518fa25cf1307470f88c42379e043638db13` |
| `schema-validator.mjs` | `contracts/shared/schema-validator.mjs` | `cd45530bfdcd74dc42ba9d13e533bc76a4a4ebe725e30fcf46ddd93e9a05e52e` |
| `personal-dimensions.mjs` | `contracts/shared/personal-dimensions.mjs` | `0bae6135d71be21abc61f8a0b3823cb97e38c94a066dd9a921099e3240b8159d` |

`types.d.ts` はこのリポジトリ独自の追加物（vendored ファイルではない）: 上記 3 ファイルは
plain JS (`allowJs` なし) なので、TS 側から `@ts-expect-error` なしで import できるよう薄い
型宣言を手書きしている。vendored ファイル自体を変更したときは型宣言も合わせて見直すこと。
