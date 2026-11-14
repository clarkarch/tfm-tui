# tfm: the Rust port

`tfm` is a GUI like terminal file manager written in Rust using the OpenTUI fork. This branch is the Rust port of the original TypeScript implementation.

## Rules

- Use Rust and the `opentui` fork crates. The dependency is tagged `v0.8.4-fork.3`, and the API remains `opentui::…`.
- Every mutable state machine must use a tagged enum with one owner and one transition owner. Invalid combinations must be unrepresentable. Keep state fields private. Do not use parallel booleans, magic sentinels, or nullable fields that stand for several phases.
- Never use `Rc`, `Cell`, or `RefCell` for domain state. Put OpenTUI-required interior mutability in a named adapter at the framework boundary and keep it out of domain modules. Use `Arc` and `Mutex` only for genuine cross-thread ownership, with narrow lock scopes.
- Before implementing a stateful subsystem, name its states, events, and invariants in module docs. Every transition and invariant needs an observable test. Do not weaken these rules or add exceptions without explicit approval.
- Prefer crate features, `opentui::testing::TestApp`, and `std` over custom equivalents.
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
