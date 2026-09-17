# Code signing policy

ADE releases are published at
[github.com/SandroHub013/nikcli/releases](https://github.com/SandroHub013/nikcli/releases)
as `ade-v*` tags.

Free code signing for the Windows installer is provided by
[SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

## What is signed

| Artifact                                               | Signature                | By                                                   |
| ------------------------------------------------------ | ------------------------ | ---------------------------------------------------- |
| Windows setup (`ADE_<version>_x64-setup.exe`)          | Authenticode             | SignPath Foundation certificate, through SignPath.io |
| Every installer and bundle the in-app updater installs | minisign (Tauri updater) | ADE's updater key, held as a repository secret       |
| macOS `ADE.app`                                        | ad-hoc                   | not notarized; see below                             |

Every signed artifact is built by the `ade-release` GitHub Actions workflow
from a tag of this repository. Nothing built on a developer machine is signed.

## Team roles

- **Committers and reviewers:** [SandroHub013](https://github.com/SandroHub013).
  Changes reach `feat/ade` only through them; automated sessions working on ADE
  commit locally and are pushed only after the maintainer has tried the change.
- **Approvers:** [SandroHub013](https://github.com/SandroHub013). Every signing
  request is tied to a release run of the `ade-release` workflow.

All members use multi-factor authentication on GitHub and SignPath.

## Privacy

ADE contacts the network on its own for exactly one thing: every 30 minutes it
reads the list of this repository's releases from the GitHub API, and when the
user chooses to update, it downloads `latest.json` and the release bundle from
GitHub. No usage data, identifiers or telemetry are sent. Agents started from
ADE (Claude Code, Codex, nikcli and others) talk to their own providers under
their own terms.

## macOS

macOS bundles are ad-hoc signed and not notarized: the first launch of a
downloaded copy needs right-click → Open once. Updates installed from inside
ADE are not quarantined and open normally.
