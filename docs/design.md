# design notes

正本の設計は platform plan の D5 (deployment state machine v1)。この文書は実装側の
決定だけを記録する。

## 2026-08-22 toolchain の選定 (routine call)

- **TypeScript 単一パッケージ** (monorepo にしない)。spec-lane と同じ tool 群
  (pnpm@10.28.2 / tsc strict / vitest / biome) を踏襲するが、CLI 1本 + adapter の
  規模に packages 分割は過剰
- 契約の fixtures (playbook 側) を conformance target にする: 実装のテストは
  playbook の fixtures ディレクトリを読み、schema 検証と fold の結果が
  expected-results.json と一致することを固定する (契約と実装のドリフト検知)
- 状態は常に fold で導出。ledger 書き込みは append のみ。訂正は新イベント
