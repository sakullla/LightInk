# Repository Guidelines

## Project Structure & Module Organization

LightInk is a Tauri desktop application. Frontend TypeScript lives in `src/`, organized by feature: `editor/`, `tabs/`, `file/`, `asset/`, `outline/`, `theme/`, `ui/`, and `export/`. Keep frontend tests beside their feature in `__tests__/`. The Rust/Tauri backend is under `src-tauri/`; commands are split across modules in `src-tauri/src/`, while application icons and capability declarations live in `src-tauri/icons/` and `src-tauri/capabilities/`. Requirements are documented in `docs/requirements/`.

## Build, Test, and Development Commands

- `npm install`: install JavaScript dependencies from the lockfile.
- `npm run tauri:dev`: launch the complete desktop app with Vite hot reload.
- `npm run dev`: run only the frontend server on port 1420.
- `npm run build`: run strict TypeScript checking, then create the Vite production bundle.
- `npm test`: run all Vitest suites once; use `npm test -- src/editor` to target a feature.
- `npm run test:watch`: rerun frontend tests during development.
- `cargo test --manifest-path src-tauri/Cargo.toml`: run backend tests.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: verify Rust formatting; CI fails the build on any diff, so run `cargo fmt --manifest-path src-tauri/Cargo.toml` before committing Rust changes.
- `npm run tauri:build`: produce platform-specific installers.

Rust **must** compile from this repository. Run `cargo` / `npm run tauri:dev` with cwd `LightInk` (or `--manifest-path src-tauri/Cargo.toml`) so artifacts land in `src-tauri/target`. Do not set `CARGO_TARGET_DIR` to a Cursor sandbox or other temp path, and do not run Tauri from `AppData\Local\Temp\cursor-sandbox-cache` (or any copy of the tree). A log that starts at `Compiling proc-macro2` with hundreds of crates means the incremental cache was missed; stop and rebuild from the project `target` instead of waiting out a cold compile. Frontend-only changes do not need a Rust rebuild: keep the existing `tauri:dev` process and reload the window, or kill only `lightink.exe` / `LightInk` and leave `cargo` running.

## Coding Style & Naming Conventions

Use strict TypeScript and ES modules. Follow existing files: two-space indentation, semicolons, single quotes, and explicit types at public boundaries. Name files and modules in kebab-case (`file-service.ts`), functions and variables in camelCase, and types/classes in PascalCase. Rust code should follow `rustfmt` defaults and snake_case naming; `cargo fmt -- --check` is enforced in CI and must pass clean. No standalone formatter or linter is configured; `npm run build` is the required static check. Keep feature logic in its owning directory rather than adding broad utility modules.

## Testing Guidelines

Use Vitest with `describe`/`it` and name files `*.test.ts` inside `__tests__/`. Add focused tests for behavior changes and regression cases. Rust tests use standard `#[test]` modules. Before submitting, run the relevant targeted suite, then `npm test` and the Cargo tests for cross-layer changes.

## Commit & Pull Request Guidelines

History generally uses concise, imperative subjects with Conventional Commit prefixes such as `feat(export):`, `fix(perf):`, `docs:`, and `ci:`. Keep commits scoped to one concern. Pull requests should explain the user-visible change, list verification commands, link related requirements or issues, and include screenshots or recordings for UI changes. Call out platform-specific Tauri behavior and any known limitations.

## Version Release Process

Keep the release version identical in `package.json`, both root entries in `package-lock.json`, `src-tauri/Cargo.toml`, the LightInk entry in `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. Before tagging, run `npm run build`, `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`. Commit with a subject such as `chore(release): v0.1.1`, push `main`, then create and push an annotated tag: `git tag -a v0.1.1 -m "LightInk v0.1.1"` and `git push origin v0.1.1`.

Do not manually create or publish the GitHub Release before pushing the tag; `.github/workflows/release.yml` owns Release creation and asset upload. Wait for both the platform build matrix and `Verify release assets` job to pass. Confirm the public Release contains `.msi`, `.exe`, `.dmg`, `.deb`, and `.AppImage` files. Never move an existing release tag; fix the issue and publish a new patch version.
