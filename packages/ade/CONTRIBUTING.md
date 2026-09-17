# Contributing to ADE

ADE and `packages/voice` are developed on the fork
[`SandroHub013/nikcli`](https://github.com/SandroHub013/nikcli), on the
`feat/ade` branch, and released from there as `ade-v*` tags. These rules are
the fork's own and add to the repository-wide `CONTRIBUTING.md`; agents also
follow [`AGENTS.md`](./AGENTS.md).

Nothing here goes to the upstream repository (`nikomatt69/nikcli`): no pushes,
no pull requests, no issues about ADE there.

## Where the work happens

- Branch from `feat/ade` into your own worktree (`git worktree add`), one
  topic per branch. The main checkout is shared and may hold someone else's
  uncommitted work: never clean, reset or check out there.
- Integrate into `feat/ade` with a fast-forward or a merge, after telling the
  other people working on ADE, so nobody is rebasing at the same moment.
- Commit by path (`git commit -- <files>`), never `git add -A`.
- Try changes in **ADE Test** (`bun run native:dev`), never in the installed
  ADE.

## Commit messages

Every commit that touches `packages/ade`, `packages/voice` or
`packages/plugin/src/v2/ade` has a subject of the form

```
type(scope): description
```

in English, imperative, lower-case, describing what the user gets rather than
what the code does (`fix(ade): clicking a session in the sidebar opens it`).
The scope is optional and lower-case; use `ade`, `voice`, or both
(`perf(ade,voice): …`). CI (`ade-checks`) rejects any other shape.

The type decides whether the commit ships a release:

| Type | Use it for | Release |
|---|---|---|
| `feat` | something new a user can do or see | minor (0.2.0 → 0.3.0) |
| `fix` | something that was wrong for a user | patch (0.2.0 → 0.2.1) |
| `perf` | faster, lighter, less CPU or memory | patch |
| `revert` | undoing a released change | patch |
| `feat!` / `fix!`, or a `BREAKING CHANGE:` footer | settings, data or behaviour that will not carry over | major (minor while ADE is 0.x) |
| `refactor`, `docs`, `test`, `chore`, `build`, `ci`, `style` | everything else | none on its own |

Work that is on `feat/ade` but not ready to be released carries
`[skip release]` in its subject or body. A later releasable commit still
ships it, so keep unfinished features behind a switch or on a topic branch.

No `Co-Authored-By` or tool attribution trailers.

## Before you commit

From `packages/ade`:

```bash
bun run typecheck
bun run test
```

From `packages/voice`, the same two. For Rust changes, `cargo check` and
`cargo test` in `packages/ade/src-tauri`. CI runs the TypeScript half of this
on every push and pull request (`.github/workflows/ade-checks.yml`); the Rust
half runs in the release build.

Push only what has been tried in ADE Test and confirmed.

## Pull requests

Pull requests target `feat/ade`. They are optional for whoever maintains the
fork and the way in for everyone else. `area/ade` and `area/voice` are applied
from the changed paths; two labels are set by hand and read at release time:

| Label | Effect |
|---|---|
| `release:skip` | the pull request's commits never cause a release |
| `release:major` | the pull request's commits count as a breaking change |

## Releases

The maintainer decides when ADE is released. The scheduled
`.github/workflows/ade-auto-release.yml` is **disabled** on the fork, so a push
to `feat/ade` publishes nothing by itself. Run by hand, or re-enabled by the
maintainer, it releases when all of these hold:

1. at least one releasable commit (table above) since the last `ade-v*` tag
   touches ADE;
2. the newest commit on `feat/ade` is at least 2 hours old, so a series being
   pushed is not caught halfway;
3. `ade-checks` passes on that exact commit;
4. no earlier ADE release is still building.

It then tags `ade-vX.Y.Z` and runs `ade-release.yml`, which builds macOS,
Windows and Linux and publishes only if every platform succeeds. Installed
copies of ADE then show the update in their notification bell. Release notes
are the `feat`, `fix`/`revert` and `perf` subjects, grouped.

To release, the maintainer runs **ade-auto-release** from the Actions tab
(`min_age_hours: 0`; `dry_run` shows the plan without tagging), or pushes a
tag: `git tag -a ade-vX.Y.Z -m "ADE X.Y.Z" && git push origin ade-vX.Y.Z`.

To see what the next release would be, locally:

```bash
bun packages/ade/script/release-plan.ts plan
bun packages/ade/script/release-plan.ts check origin/feat/ade..HEAD
```
