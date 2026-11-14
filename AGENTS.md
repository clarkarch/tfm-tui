# tfm: the Rust port

`tfm` is a terminal file manager written in Rust using the OpenTUI fork. This branch is the Rust port of the original TypeScript implementation.

## Contract

- The feature specification is the source of truth. Read it, especially its behavioral invariants, before designing a subsystem.
- This is a fresh Rust implementation of the required behavior, not a line-by-line port of the old TypeScript implementation.

## Rules

- Use Rust and the `opentui` fork crates. The dependency is tagged `v0.8.4-fork.3`, and the API remains `opentui::…`.
- Keep one state and one owner. Use tagged enums for state machines, private state fields, and one transition owner. Do not use parallel booleans, magic sentinels, or ambiguous nullable fields.
- Prefer crate features, `opentui::testing::TestApp`, and `std` over custom equivalents.
- Keep design reasoning in module docs and `docs/`. Tests must assert observable behavior and protect named contracts.
- Treat warnings as errors. Do not use blanket lint allowances. Any exception must be narrow and explain why.
- Do not add unsafe code or unchecked casts. Keep unchecked indexing and panicking unwraps in tests only. Use typed errors and `Result` instead.
- If the fork API is missing something, fix `clarkarch/opentui-fork`, tag a release, and update `Cargo.toml`. Do not work around it here.

## Checks

```sh
cargo build --locked
cargo test --locked --all-targets
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo doc --locked --no-deps
```

A release build is `target/release/tfm`. Linux uses the native artifact from the fork dependency. Other platforms fetch it with the fork's `fetch-native.sh` script and set `OPENTUI_LIB_DIR`.
