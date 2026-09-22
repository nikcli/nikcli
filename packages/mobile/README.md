# nikcli mobile

The Expo / React Native companion app. It pairs with a nikcli server over SSE
and lets you follow and steer sessions from a phone.

## Installing a release build

Every release on [nikcli/nikcli](https://github.com/nikcli/nikcli/releases)
carries the mobile artifacts alongside the CLI and desktop ones:

| File                                         | Platform                              |
| -------------------------------------------- | ------------------------------------- |
| `nikcli-<version>-<build>.apk`               | Android, direct install               |
| `nikcli-<version>-<build>.aab`               | Android, Play Store upload            |
| `nikcli-<version>-<build>-unsigned.ipa`      | iOS, **needs re-signing** — see below |
| `nikcli-<version>-<build>-simulator.app.zip` | iOS Simulator, macOS only             |

Android is straightforward: download the `.apk`, allow installation from your
browser, open it.

### iOS is not straightforward, and this is why

There is no iOS equivalent of an APK. A build that an arbitrary person can
download and install has to be signed with an Apple distribution certificate,
and those exist only under the Apple Developer Program (99 €/year), which this
project does not hold.

So the `.ipa` we publish is deliberately **unsigned**, with its entitlements
stripped. The signature is applied on your own machine, with your own Apple ID,
by a sideloading tool. A free Apple ID can sign three apps at a time and the
signature lasts **seven days**, after which the app must be refreshed.

Pick the first row that applies to you:

| Path                                                                          | Apple ID | Expires                         | Needs a computer |
| ----------------------------------------------------------------------------- | -------- | ------------------------------- | ---------------- |
| **[TrollStore](https://github.com/opa334/TrollStore)**                        | none     | never                           | no               |
| **[SideStore](https://sidestore.io)**                                         | free     | 7 days, **renews on the phone** | first setup only |
| **[Sideloadly](https://sideloadly.io)** / **[AltStore](https://altstore.io)** | free     | 7 days, manual refresh          | every refresh    |

TrollStore only works on a bounded set of iOS versions; if yours is supported it
is strictly the best option, because nothing expires. Otherwise SideStore is
what you want — it is the only free path where you are not plugging the phone
into a computer every week.

### The helper script

`scripts/sideload.sh` finds the latest release, verifies the download against
the published `checksums-ios.txt` and hands the build to the right installer.

```sh
./scripts/sideload.sh              # fetch the .ipa and open your installer
./scripts/sideload.sh --simulator  # install straight into a booted simulator
./scripts/sideload.sh --tag v1.2.3 # a specific release
```

Only the simulator path is fully automatic — it unzips the build and runs
`xcrun simctl install`. The device path stops at the handoff, because the
signature has to come from your Apple ID.

The script never asks for an Apple ID or a password, and it will refuse to
continue if the download is missing from the checksum manifest or if the `.ipa`
turns out to be signed. Set `GH_TOKEN` if you hit the GitHub API rate limit.

### What you give up

The widget and live-activity extension is **not** in the sideload build. It
needs the `group.ai.nikcli.mobile` App Group, and Apple does not grant App
Groups to free Apple IDs — leaving the extension in makes the install fail
rather than degrade. Everything else works.

## Building it yourself

The native projects are generated: `app.json` and `plugins/` are the source of
truth, and `ios/` / `android/` are rebuilt by `expo prebuild`. Never hand-edit
the generated directories.

```sh
bun install
bun run ios       # device or simulator, via Xcode
bun run android
bun run typecheck
```

CI builds live in
[`.github/workflows/mobile-ios.yml`](../../.github/workflows/mobile-ios.yml) and
[`.github/workflows/mobile-android.yml`](../../.github/workflows/mobile-android.yml).
Both are `workflow_dispatch`-able and both are called from `ci-pipeline.yml` on
a release tag. Android needs the upload-keystore secrets; iOS needs none,
because nothing it produces is signed.

## If the project ever joins the Developer Program

`mobile-ios.yml` is one step away: add the signing secrets, drop the
`CODE_SIGNING_ALLOWED=NO` flags, and replace the hand-built `Payload/` zip with
`xcodebuild -exportArchive`. That unlocks TestFlight — a public link, 10 000
testers, two-tap install, 90-day builds — which is the only thing on iOS that
actually behaves like an APK. Everything in this document exists because that
membership is absent, not because sideloading is a good distribution story.
