# ADE — rules for agents

ADE (Agent Development Environment) is a Tauri 2 desktop app: SolidJS frontend
in `src/`, Rust host in `src-tauri/`, voice control in `../voice`. These rules
apply to any agent changing ADE or `packages/voice`.

## Two apps, never mixed

| | Official ADE | ADE Test |
|---|---|---|
| Identifier | `ai.nikcli.ade` (`tauri.conf.json`) | `ai.nikcli.ade.test` (`src-tauri/tauri.test.conf.json`) |
| Built by | the `ade-release` workflow from an `ade-v*` tag, or `bun run native:build` | `bun run native:dev`, `bun run native:build:test` |
| Executable | `ade-desktop.exe` | `ade-test.exe` (`native:dev` runs the `ade-test` binary; `mainBinaryName` names it in `native:build:test`) |
| Data, WebView2 profile, install folder | its own | its own |
| Global voice hotkeys | registered | not registered |
| Update notices | yes, from published `ade-v*` releases | never (version `0.0.0`) |

- The official ADE is what the user works in. **Never start, stop, restart,
  rebuild into, or measure it.** If a task needs a running app, use ADE Test.
- When stopping processes, stop only ones you started, matched by creation
  time and ancestry — Windows reuses PIDs, and a parent-id walk alone sweeps in
  unrelated processes.
- Keep the two identities separate: anything that is system-wide (hotkeys,
  files outside the app data directory, CLI hook configuration) must not let
  the test build interfere with the official one. `is_test_build` in
  `src-tauri/src/lib.rs` is the switch.
- Keep the executable names apart too. An ADE setup, and the in-app update
  running one, closes every process of the user with the app's executable
  name, without asking when silent: when ADE Test was also `ade-desktop.exe`, a
  trial setup closed the user's ADE. Never run an ADE setup or uninstaller
  unless asked, and never one built as `ade-desktop`.

## ADE Test: one per worktree

Several sessions work on ADE at the same time. Each works in its own git
worktree, on its own branch off `feat/ade`, and tries its change in its own
ADE Test:

```
bun run test:app          # start this worktree's ADE Test, or say it is already running
bun run test:app --cdp    # same, with a WebView2 remote-debugging port to drive it
bun run test:app status   # this worktree's instance
bun run test:app list     # every worktree's instance
bun run test:app stop     # stop this worktree's instance, and only that
```

- Port, WebView2 profile, temp folder and log are derived from the worktree
  path and live in `.ade-test/` at its root. The window title and the TEST
  badge name the worktree, so several open instances can be told apart.
- **Do not start ADE Test with plain `tauri dev` while another worktree runs
  one.** Vite is `strictPort`: the second Vite exits on the busy port and the
  window loads the *other* worktree's code from it, with nothing on screen to
  say so. `test:app` gives each worktree its own port for this reason.
- Stop your instance with `test:app stop`, never by killing processes by
  name: it stops only processes that carry this worktree's config, profile or
  build folder and were created after the start in `.ade-test/record.json`,
  and their children created after them, one process at a time. An instance
  whose record has no start time is not stopped: close it by hand.
- **The user tries `feat/ade` in `nikcli-ade-prova`, never in `nikcli-ade`.**
  `nikcli-ade` is where branches are integrated: every merge there rebuilds
  and reloads the app under the user mid-test (a voice turn lost its history
  this way). `Desktop\ADE Test.cmd` checks out `feat/ade` detached in
  `nikcli-ade-prova` and starts its ADE Test. Nobody edits files or commits
  in that worktree.
- The first start in a new worktree compiles the Rust host (several minutes);
  later starts reuse that worktree's `src-tauri/target`.
- The profile is new per worktree, so localStorage starts empty: open
  workspaces are not carried over. The voice OpenRouter key is read again
  from nikcli's `auth.json`.
- `feat/ade` is where finished work is integrated; merges into it are
  announced to the other sessions first.

## Workflow

1. Change the code on the ADE branch (`feat/ade`).
2. Try it in ADE Test (`bun run test:app` from this directory: one instance per worktree, see below).
3. Before committing, run from this directory: `bun run typecheck` and
   `bun run test`; from `../voice`: `bun run typecheck` and `bun run test`.
   For Rust changes, `cargo check` and `cargo test` in `src-tauri`.
4. Commit only what the user has confirmed works, with a subject in the
   `type(scope): description` format of [`CONTRIBUTING.md`](./CONTRIBUTING.md).
   Push goes to the fork (`origin`), never to the upstream repository; pushes
   and pull requests only when the user asks.
5. The user decides releases. `ade-auto-release` is disabled on the fork and
   stays so; a push to `feat/ade` publishes nothing. When the user asks for a
   release, it is a tag `ade-vX.Y.Z` pushed to `origin` (or `ade-auto-release`
   run by hand); `ade-release.yml` builds every platform and publishes only if
   all succeed, and installed copies offer it in their notification bell.

## Conventions

- `bun test` cannot load Solid `.tsx`: logic worth testing lives in plain `.ts`
  next to the component.
- Timers go through `src/host/every.ts`, which pauses or slows them while the
  window is hidden. No bare `setInterval` for polling.
- Nothing animates forever at rest: animations run while something is
  happening, on hover, or during a short intro, and honour
  `prefers-reduced-motion`.
- Comments explain why, in full sentences, like the surrounding code.
