# Changelog

<!-- UNRELEASED:START -->
<!-- UNRELEASED:END -->

## v1.362.0 (September 2026)

- No notable changes

## v1.361.0 (September 2026)

## Core

- Move sign-in to an OAuth App and make the client ID resolvable (@nikomatt69)
- Run a subagent on a different model (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(task): run a subagent on a different model
  - fix(github): move sign-in to an OAuth App and make the client ID resolvable

## v1.360.0 (September 2026)

## Core

- Streamline IP retrieval for mobile pairing (@nikomatt69)

## Mobile

- Build and publish iOS artifacts alongside Android (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(ci): build and publish iOS artifacts alongside Android
  - refactor(network): streamline IP retrieval for mobile pairing

## v1.359.0 (September 2026)

## Core

- Register Actions endpoints in the compat map and resolve nikcli in autofix (@nikomatt69)
- Integrate GitHub Actions workflows and runs management (@nikomatt69)

## Mobile

- Improve styling and layout of ScopeToggle component (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(github): integrate GitHub Actions workflows and runs management
  - docs(agents): add command for building iOS app for Nikoemme
  - refactor(git): improve styling and layout of ScopeToggle component
  - fix(ci): register Actions endpoints in the compat map and resolve nikcli in autofix

## v1.358.0 (September 2026)

- No notable changes

## v1.357.0 (September 2026)

## Core

- Treat the background service's loopback listener as local (@nikomatt69)
- Drive the update dialog off the check result, not the bus (@nikomatt69)
- Implement local account session handling and improve request authorization (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(auth): implement local account session handling and improve request authorization
  - fix(upgrade): drive the update dialog off the check result, not the bus
  - fix(auth): treat the background service's loopback listener as local
  - test(upgrade): assert the check wiring without pinning its line breaks

## v1.356.0 (September 2026)

## Core

- Enhance database interactions with Effect.runSync (@nikomatt69)
- Retire the synchronous singleton — syncDb has no callers in src (@nikomatt69)
- Move MobileAuth, SyncSnapshot and Outbox onto Effect (@nikomatt69)
- Move UserDB onto Effect-returning queries (@nikomatt69)
- Move SessionPending onto Effect-returning queries (@nikomatt69)
- Move SessionRepo onto Effect-returning queries (@nikomatt69)
- Move MessageRepo onto Effect-returning queries (@nikomatt69)
- Move SessionEntryRepo and InstructionRepo onto Effect (@nikomatt69)
- Move AccountDB and ProjectRepo onto Effect-returning queries (@nikomatt69)
- Move WorkspaceDB onto Effect-returning queries (@nikomatt69)
- Move loop, mission and routine repositories onto Effect (@nikomatt69)
- Move nine repositories onto Effect-returning queries (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(database): move nine repositories onto Effect-returning queries
  - refactor(database): move loop, mission and routine repositories onto Effect
  - refactor(database): move WorkspaceDB onto Effect-returning queries
  - refactor(database): move AccountDB and ProjectRepo onto Effect-returning queries
  - refactor(database): move SessionEntryRepo and InstructionRepo onto Effect
  - refactor(database): move MessageRepo onto Effect-returning queries
  - refactor(database): move SessionRepo onto Effect-returning queries
  - refactor(database): move SessionPending onto Effect-returning queries
  - refactor(database): move UserDB onto Effect-returning queries
  - refactor(database): move MobileAuth, SyncSnapshot and Outbox onto Effect
  - refactor(database): retire the synchronous singleton — syncDb has no callers in src
  - refactor(database): enhance database interactions with Effect.runSync

## v1.355.0 (September 2026)

## Core

- Format mobile pairing files with prettier (@nikomatt69)
- Update server context and router types for consistency (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(mobile): update server context and router types for consistency
  - fix(ci): format mobile pairing files with prettier

## v1.354.0 (September 2026)

## Mobile

- Streamline loading functions and update router types (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(mobile): streamline loading functions and update router types

## v1.353.0 (September 2026)

## Core

- Enhance QR code handling and pairing link visibility (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(mobile): enhance QR code handling and pairing link visibility

## v1.352.0 (September 2026)

- No notable changes

## v1.351.0 (September 2026)

## Core

- Improve hostLanGet listener handling (@nikomatt69)
- Implement LAN pairing functionality for mobile devices (@nikomatt69)

## Mobile

- Update layout and styling across multiple screens (@nikomatt69)
- Enhance bottom sheet and session components (@nikomatt69)
- Enhance session screen and composer UI (@nikomatt69)
- Integrate expo-camera and update app permissions (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(mobile): integrate expo-camera and update app permissions
  - feat(mobile): enhance session screen and composer UI
  - feat(mobile): enhance bottom sheet and session components
  - feat(mobile): update layout and styling across multiple screens
  - feat(mobile): implement LAN pairing functionality for mobile devices
  - fix(mobile): improve hostLanGet listener handling

## v1.350.0 (September 2026)

## Core

- Format the settings command search test (#264) (@nikomatt69)
- Standardize parameter naming in command handlers (@nikomatt69)

## Mobile

- Add background activity sheet for sub-agents and shell commands (#263) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(cli): standardize parameter naming in command handlers
  - Add background activity sheet for sub-agents and shell commands (#263)
  - style(nikcli): format the settings command search test (#264)

## v1.348.0 (September 2026)

- No notable changes

## v1.347.0 (September 2026)

## Core

- Format five test files so ci-pipeline's validate job passes (@nikomatt69)
- Improve code formatting and structure in test files (@nikomatt69)
- Implement state machine for authentication lifecycle (@nikomatt69)
- Introduce delivery classes for event handling (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(bus-event): introduce delivery classes for event handling
  - feat(auth): implement state machine for authentication lifecycle
  - refactor(tests): improve code formatting and structure in test files
  - style(test): format five test files so ci-pipeline's validate job passes

## v1.346.0 (September 2026)

## Core

- Replace ambient transaction context with explicit TransactionContext (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(database): replace ambient transaction context with explicit TransactionContext

## v1.345.0 (September 2026)

## Core

- Guard the sticky scroll that replaced the support auto-scroll (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - test(tui): guard the sticky scroll that replaced the support auto-scroll
  - docs(tui): say where FooterHintGroup can and cannot be used
  - fix(tui): keep the GitHub list cursor on screen

## v1.344.0 (September 2026)

## Core

- Re-register the opentui patch the 0.5.11 bump dropped (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - test(tui): make the standalone smoke fail on a terminal that crashed
  - fix(tui): re-register the opentui patch the 0.5.11 bump dropped
  - refactor(tui): make scroll, dialog headers and selection consistent

## v1.342.0 (September 2026)

## Core

- Surface a replay that resumes across a compacted range (EOT-15) (@nikomatt69)
- Cover the one untested export in the LLM event adapter (EOT-11) (@nikomatt69)
- Cover the message windowing math (EOT-06) (@nikomatt69)
- Record the machine behind every EOT-01 measurement (@nikomatt69)
- Wait for the search index instead of racing it (EOT-20) (@nikomatt69)
- Ask the renderer whether a dialog is being typed into (EOT-07) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(tui): ask the renderer whether a dialog is being typed into (EOT-07)
  - test(server): wait for the search index instead of racing it (EOT-20)
  - perf(probe): record the machine behind every EOT-01 measurement
  - docs(specs): record which slices landed, and which specs have not started
  - test(tui): cover the message windowing math (EOT-06)
  - test(session): cover the one untested export in the LLM event adapter (EOT-11)
  - feat(sync): surface a replay that resumes across a compacted range (EOT-15)
  - docs(specs): correct the landed-slices table for EOT-06, EOT-11 and EOT-15

## v1.341.0 (September 2026)

## Core

- Stop one failed optional request pinning bootstrap at "partial" (EOT-05) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(tui): stop one failed optional request pinning bootstrap at "partial" (EOT-05)

## v1.340.0 (September 2026)

## Core

- Bound first-run onboarding and report an incomplete session (EOT-12) (@nikomatt69)
- Guard restartable dialog flows against superseded attempts (EOT-03) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(tui): guard restartable dialog flows against superseded attempts (EOT-03)
  - perf(tui): characterise the eager import cost and move one dialog off it (EOT-08)
  - fix(tui): bound first-run onboarding and report an incomplete session (EOT-12)

## v1.339.0 (September 2026)

## Core

- Restore the 28 specification documents deleted in af5546f8c9 (@nikomatt69)
- Implement the first slices of EOT-02/04/09/10/13/17/20 (@nikomatt69)
- Integrate EOT-11..20 and restore the CLI command surface gate (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - docs(specs): integrate EOT-11..20 and restore the CLI command surface gate
  - feat(specs): implement the first slices of EOT-02/04/09/10/13/17/20
  - docs(specs): restore the 28 specification documents deleted in af5546f8c9
  - fix(tui): stop the CLI host swallowing a TUI config failure

## v1.338.0 (September 2026)

## Core

- Update architecture and specs references in documentation (@nikomatt69)
- Improve dialog lifecycle tests and add web preview functionality (@nikomatt69)
- Enhance tests for cellSize and streaming churn (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - test(tui): enhance tests for cellSize and streaming churn
  - test(tui): improve dialog lifecycle tests and add web preview functionality
  - docs: update architecture and specs references in documentation

## v1.337.0 (September 2026)

## Core

- Delete the finished plans (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - chore(specs): delete the finished plans

## v1.336.0 (September 2026)

## Core

- Resolve every Proposed v2 contract (D1/D2), and fix what the audit found (D3) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - docs(specs): resolve every Proposed v2 contract (D1/D2), and fix what the audit found (D3)
  - deps: move solid-js to the version @opentui/solid declares (U6)

## v1.335.0 (September 2026)

## Core

- Streamline instance-less routing and directory handling; introduce requestedDirectory function for consistent directory resolution across handlers (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor: streamline instance-less routing and directory handling; introduce requestedDirectory function for consistent directory resolution across handlers

## v1.334.0 (September 2026)

## Core

- Upgrade @opentui/core and @opentui/solid to version 0.5.10 across all relevant files; enhance Dockerfile.serve to include NIKCLI_REVISION for improved deployment identity tracking (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - update: upgrade @opentui/core and @opentui/solid to version 0.5.10 across all relevant files; enhance Dockerfile.serve to include NIKCLI_REVISION for improved deployment identity tracking

## v1.330.0 (September 2026)

## Core

- Advance C2 and align Bun runtimes to 1.4.2 (#258) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(ci): stop desktop release upload from globbing the tracked artifacts/ dir (#257)
  - fix(release): advance C2 and align Bun runtimes to 1.4.2 (#258)

## v1.328.0 (September 2026)

## Core

- Declare the part-id mismatch as a 400 on the typed channel (E9) (#256) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(httpapi): declare the part-id mismatch as a 400 on the typed channel (E9) (#256)

## v1.327.0 (September 2026)

## Core

- Add GPT-6 Astra support (#255) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(provider): add GPT-6 Astra support (#255)

## v1.326.0 (September 2026)

## Mobile

- Resolve static scan defects and broken test fixtures (#234, #228) (#254) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix: resolve static scan defects and broken test fixtures (#234, #228) (#254)

## v1.324.0 (September 2026)

## Core

- Raise declared failures with Effect.fail, not throw inside Effect.gen (E8) (#247) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(effect): raise declared failures with Effect.fail, not throw inside Effect.gen (E8) (#247)
  - docs: close the 2026-08-26 engineering refill

## v1.322.0 (August 2026)

## Core

- E6/E7: pin Effect 4.0.0-rc.112 and fix generated SseError mapping (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - E6/E7: pin Effect 4.0.0-rc.112 and fix generated SseError mapping
  - H9: declare location, retry-after, and www-authenticate on the contract
  - H10: matchOrElse does not un-force SessionV2 Unknown
  - R2: name remaining instance ALS reads as boundaries

## v1.321.0 (August 2026)

## Core

- Refill the queue from the Effect pin measurement (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - docs(roadmap): refill the queue from the Effect pin measurement

## v1.320.0 (August 2026)

## Core

- Thread the instance into the last 22 ambient reads (R1) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(instance): thread the instance into the last 22 ambient reads (R1)
  - refactor(instance): own instances in a ScopedCache, not a promise Map (R1)

## v1.319.0 (August 2026)

## Core

- Routines take the instance they belong to (R1) (@nikomatt69)
- The mission manager takes the project it operates on (R1) (@nikomatt69)
- The loop manager takes the project it operates on (R1) (@nikomatt69)
- Brain, sandbox and the session LLM path take the instance (R1) (@nikomatt69)
- CLI command bodies receive the instance they run in (R1) (@nikomatt69)
- Server handlers resolve the instance and pass it down (R1) (@nikomatt69)
- Lsp servers and mobile git take the instance as an argument (R1) (@nikomatt69)
- The tool layer takes its instance from the call (R1) (@nikomatt69)
- Key the two module-level caches that answered for every instance (R1) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(instance): key the two module-level caches that answered for every instance (R1)
  - refactor(instance): the tool layer takes its instance from the call (R1)
  - refactor(instance): lsp servers and mobile git take the instance as an argument (R1)
  - refactor(instance): server handlers resolve the instance and pass it down (R1)
  - refactor(instance): CLI command bodies receive the instance they run in (R1)
  - refactor(instance): brain, sandbox and the session LLM path take the instance (R1)
  - refactor(instance): the loop manager takes the project it operates on (R1)
  - refactor(instance): the mission manager takes the project it operates on (R1)
  - refactor(instance): routines take the instance they belong to (R1)

## v1.317.0 (August 2026)

## Core

- Thread the instance context through every module that held one (R1) (@nikomatt69)
- Stop crossing the Effect runtime to read three ALS getters (R1) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(instance): stop crossing the Effect runtime to read three ALS getters (R1)
  - refactor(instance): thread the instance context through every module that held one (R1)

## v1.316.0 (August 2026)

## Core

- Stop version bumps from silently dropping dependency patches (C1) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(deps): stop version bumps from silently dropping dependency patches (C1)

## v1.315.0 (August 2026)

## Core

- Record the Brain pass output and this session's plan artifacts (@nikomatt69)
- One bridge for withInstanceAsync, and measure what bootstrap costs (R1) (@nikomatt69)
- Make bootstrap a property of the instance, not of the first caller (R1) (@nikomatt69)
- Make multiedit one atomic batch instead of N sequential edits (@nikomatt69)
- Give the mid-request call sites invalidation instead of teardown (R1) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(instance): give the mid-request call sites invalidation instead of teardown (R1)
  - fix(tool): make multiedit one atomic batch instead of N sequential edits
  - fix(instance): make bootstrap a property of the instance, not of the first caller (R1)
  - refactor(effect): one bridge for withInstanceAsync, and measure what bootstrap costs (R1)
  - chore(nikcli): record the Brain pass output and this session's plan artifacts

## v1.314.0 (August 2026)

## Core

- Characterize the post-dispose leak R1 owns (@nikomatt69)
- Satisfy the type checker on the new characterization tests (@nikomatt69)
- Declare output codecs on the built-ins that already emit JSON (T3) (@nikomatt69)
- Drop the unused reject half of the test deferred (@nikomatt69)
- Characterize normalizeMessages, and keep its passes (P3) (@nikomatt69)
- Pin the instance lifecycle before R1 replaces it (@nikomatt69)
- Declare authentication on the contract with HttpApiMiddleware (H8.1) (@nikomatt69)
- Gate hot-poll request logs, and close P2.2 on the measurement (@nikomatt69)
- Filter, order, and limit the session list in SQL (P2.1) (@nikomatt69)
- Close E5 — declared errors on the typed channel only (@nikomatt69)

## SDK

- Stop the SDK build from collapsing the codegen manifest again (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(session): close E5 — declared errors on the typed channel only
  - perf(session): filter, order, and limit the session list in SQL (P2.1)
  - perf(server): gate hot-poll request logs, and close P2.2 on the measurement
  - feat(httpapi): declare authentication on the contract with HttpApiMiddleware (H8.1)
  - docs(roadmap): record the H8 typecheck result
  - test(instance): pin the instance lifecycle before R1 replaces it
  - perf(provider): characterize normalizeMessages, and keep its passes (P3)
  - test(instance): drop the unused reject half of the test deferred
  - feat(tool): declare output codecs on the built-ins that already emit JSON (T3)
  - fix(test): satisfy the type checker on the new characterization tests
  - test(instance): characterize the post-dispose leak R1 owns
  - fix(ci): stop the SDK build from collapsing the codegen manifest again
  - fix(ci): name the missing secret when the site deploy cannot authenticate

## v1.313.0 (August 2026)

## Core

- Clean up code formatting and improve readability (@nikomatt69)
- Enhance error handling in session API (@nikomatt69)

## TUI

- Bind the daemon on the main thread so sessions can start (#236) (@SandroHub013)

## SDK

- Stop prettier from collapsing the httpapi codegen manifest (@nikomatt69)

**Thank you to 3 community contributors:**

- @nikomatt69:
  - refactor(session): enhance error handling in session API
  - refactor(session): clean up code formatting and improve readability
  - fix(ci): stop prettier from collapsing the httpapi codegen manifest
- @SandroHub013:
  - fix(browser-control): stop idle sessions, and stop close-all from bricking the browser
  - fix(browser-control): only count driving a session as using it
  - fix(browser-control): bind the daemon on the main thread so sessions can start (#236)
- @cursoragent:
  - fix(browser-control): strip the BOM, and reap a session once its live view ends

## v1.312.0 (August 2026)

## Core

- Add country tracking to community statistics (@nikomatt69)
- Resolve all oxlint warnings (66 -> 0)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(web): count downloads by country and map them on /data
  - feat(inference-dashboard): add country tracking to community statistics

## v1.311.0 (August 2026)

## Core

- Regenerate httpapi manifest and apply prettier formatting (@nikomatt69)
- Enhance validation and client generation processes (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(ci): enhance validation and client generation processes
  - fix(ci): regenerate httpapi manifest and apply prettier formatting

## v1.310.0 (August 2026)

## Core

- Generate the SDK compat layer and gate direct publishes (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(httpapi-codegen): generate the SDK compat layer and gate direct publishes

## v1.309.0 (August 2026)

- No notable changes

## v1.305.0 (August 2026)

## TUI

- Improve code consistency and readability in serve.ts and worker.ts (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(cli): improve code consistency and readability in serve.ts and worker.ts

## v1.304.0 (August 2026)

## Core

- Stop GET /github/repos answering empty 400 (#239) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(mobile): stop GET /github/repos answering empty 400 (#239)

## v1.303.0 (August 2026)

## Core

- Keep --parallel=1 on each test batch (@claude)
- Shard the validate suite so it stops OOM-killing the runner (@claude)

**Thank you to 2 community contributors:**

- @nikomatt69:
  - fix(railway): ship packages/discord in the deploy upload context (#237)
- @claude:
  - fix(ci): shard the validate suite so it stops OOM-killing the runner
  - fix(ci): keep --parallel=1 on each test batch
  - fix(ci): stop running the nikcli suite in validate
  - fix(ci): remove test execution from the workflows too
  - fix(ci): put the four Windows unit suites back
  - fix(ci): drop the orphaned e2e harness from test.yml

## v1.302.0 (August 2026)

## Core

- Sample memory during validate and cut the suite to one worker (@nikomatt69)
- Stop validate's test step from taking the runner down with it (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(ci): point the Windows Global.Path invariant at @nikcli-ai/util
  - fix(ci): cap validate's test parallelism so it stops killing the runner
  - Revert "fix(ci): cap validate's test parallelism so it stops killing the runner"
  - fix(ci): stop validate's test step from taking the runner down with it
  - fix(ci): sample memory during validate and cut the suite to one worker

## v1.301.0 (August 2026)

## Core

- Follow the Bun 1.4 drop of the baseline x64 targets (@nikomatt69)
- Update bun.lock and package.json to remove deprecated packages and add @nikcli-ai/util (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - chore(dependencies): update bun.lock and package.json to remove deprecated packages and add @nikcli-ai/util
  - fix(build): follow the Bun 1.4 drop of the baseline x64 targets
  - fix(install): apply the baseline-target fallback to the other two shell copies

## v1.295.0 (August 2026)

## Core

- Add Discord Gateway bot integration (@nikomatt69)
- Update artifact URLs to include view keys (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(session): update artifact URLs to include view keys
  - feat(discord): add Discord Gateway bot integration

## v1.293.0 (August 2026)

## Core

- Enhance JSON safety in provider responses (@nikomatt69)
- H6 — named payload field refs; keep unknown as unknown (@nikomatt69)
- X2 — delete unused share/message/runner/llm adapters (@nikomatt69)
- H4 — collapse two dispatcher stacks; add AccountGroup + profilesList (@nikomatt69)
- H5 — generate implementedRoutes from OpenApi.fromApi(PublicApi) (@nikomatt69)
- E4 — Schema.optionalKey across domain, delete jsonSafe (@nikomatt69)
- P2 quick cuts — disableLogger, COUNT(\*), skip sessionForRequest on pinned workspace (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - perf(httpapi): P2 quick cuts — disableLogger, COUNT(\*), skip sessionForRequest on pinned workspace
  - refactor(httpapi): E4 — Schema.optionalKey across domain, delete jsonSafe
  - perf(httpapi): H5 — generate implementedRoutes from OpenApi.fromApi(PublicApi)
  - feat(httpapi): H4 — collapse two dispatcher stacks; add AccountGroup + profilesList
  - refactor(util): I1 — delete unprefixed Identifier; enterprise uses util/id
  - chore(nikcli): X2 — delete unused share/message/runner/llm adapters
  - feat(httpapi): H6 — named payload field refs; keep unknown as unknown
  - feat(httpapi): enhance JSON safety in provider responses

## v1.292.0 (August 2026)

- No notable changes

## v1.288.0 (August 2026)

## Core

- Expand theme catalog with new themes and enhance test coverage (@nikomatt69)
- Enhance update handling and session management (@nikomatt69)
- Add character-entities dependency and refactor profile and loop schemas (@nikomatt69)
- Introduce event visibility management and internal event handling (@nikomatt69)

## Desktop

- Refactor global SDK and SDK context for improved type safety and structure (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(bus): introduce event visibility management and internal event handling
  - feat(nikcli): add character-entities dependency and refactor profile and loop schemas
  - feat(nikcli): enhance update handling and session management
  - feat(tui): expand theme catalog with new themes and enhance test coverage
  - feat(sdk): refactor global SDK and SDK context for improved type safety and structure

## v1.287.0 (August 2026)

- No notable changes

## v1.286.0 (August 2026)

## Core

- Add TUI package and enhance CLI functionality (@nikomatt69)
- Add new build and development scripts (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(cli): add new build and development scripts
  - feat(tui): add TUI package and enhance CLI functionality
  - feat(tui): integrate TUI package into Docker and deployment scripts

## v1.285.0 (August 2026)

## Core

- Update utility imports and enhance functionality (@nikomatt69)
- Update utility imports and add new dependencies (@nikomatt69)
- Update import paths for utility modules (@nikomatt69)
- Enhance session tab functionality and introduce keybind utilities (@nikomatt69)
- Streamline data fetching and enhance tool usage metrics (@nikomatt69)
- Implement v2 session write path and enhance analytics functionality (@nikomatt69)
- Enhance analytics performance and caching mechanisms (@nikomatt69)
- Enhance instruction management and UI updates (@nikomatt69)
- Implement instruction sync functionality and related database schema (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(instruction): implement instruction sync functionality and related database schema
  - feat(instruction): enhance instruction management and UI updates
  - feat(analytics): enhance analytics performance and caching mechanisms
  - feat(analytics): implement v2 session write path and enhance analytics functionality
  - refactor(analytics): streamline data fetching and enhance tool usage metrics
  - feat(tui): enhance session tab functionality and introduce keybind utilities
  - refactor(cli): update import paths for utility modules
  - feat(dependencies): update utility imports and add new dependencies
  - feat(cli): update utility imports and enhance functionality

## v1.277.0 (August 2026)

## Core

- Move every consumer off hey-api onto the Effect contract (@nikomatt69)
- Remove Hono dependencies and streamline HTTP server implementation (@nikomatt69)
- Introduce user profile and habits management (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(profile): introduce user profile and habits management
  - refactor(nikcli): remove Hono dependencies and streamline HTTP server implementation
  - refactor(sdk): move every consumer off hey-api onto the Effect contract

## v1.275.0 (August 2026)

- No notable changes

## v1.274.0 (August 2026)

## Core

- Remove trailing whitespace in index.ts (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix: remove trailing whitespace in index.ts

## v1.271.0 (August 2026)

## Core

- Backfill the whole history on the first automatic report (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(analytics): backfill the whole history on the first automatic report

## v1.270.0 (August 2026)

## Core

- Report automatically, and show day, month and lifetime (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(analytics): report automatically, and show day, month and lifetime

## v1.269.0 (August 2026)

## Core

- Serve an opencode-style /data dataset from the local SQL (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(analytics): serve an opencode-style /data dataset from the local SQL

## v1.268.0 (August 2026)

## Core

- Drive /data from local rollups, harden the ingest (@nikomatt69)
- Put the models people actually run on /data (@SandroHub013)

## TUI

- Drive /data from the console usage table (@SandroHub013)

**Thank you to 2 community contributors:**

- @SandroHub013:
  - feat(web): publish gateway usage on a /data page
  - feat(web): drive /data from the console usage table
  - fix(web): name the table /data actually reads
  - feat: put the models people actually run on /data
- @nikomatt69:
  - Merge pull request #212 from nikomatt69/feat/web-data-page
  - feat(analytics): drive /data from local rollups, harden the ingest

## v1.266.0 (August 2026)

## Core

- Enhance tool visibility and add new tools (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(tools): enhance tool visibility and add new tools

## v1.265.0 (August 2026)

## Core

- Virtualize the session tree panel (@nikomatt69)

## TUI

- Choose project or global scope for environments (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - perf(tui): virtualize the session tree panel
  - feat(tui): choose project or global scope for environments

## v1.264.0 (August 2026)

## Core

- Implement project/global session scope switching (@nikomatt69)
- Improve project ID handling and caching logic (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(project): improve project ID handling and caching logic
  - feat(dialogs): implement project/global session scope switching

## v1.263.0 (August 2026)

## Core

- Update workspace and project terminology for consistency (@nikomatt69)
- Enhance email and device code handling (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(identity): enhance email and device code handling
  - refactor(dialogs): update workspace and project terminology for consistency
  - refactor(identity): streamline fetch handling in tests

## v1.262.0 (August 2026)

- No notable changes

## v1.261.0 (August 2026)

## Mobile

- Update splash screen and app theme settings (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - chore(android): update splash screen and app theme settings

## v1.250.0 (August 2026)

## Core

- Repair upgrade strategy, verify applied version, surface real errors (@SandroHub013)

## Desktop

- Restore broken triple-slash reference in custom-elements.d.ts (@SandroHub013)

**Thank you to 1 community contributor:**

- @SandroHub013:
  - fix(installation): repair upgrade strategy, verify applied version, surface real errors
  - fix(app): restore broken triple-slash reference in custom-elements.d.ts
  - fix(enterprise): restore broken triple-slash reference in custom-elements.d.ts

## v1.249.0 (August 2026)

- No notable changes

## v1.247.0 (August 2026)

## Core

- Add Herdr integration for nikcli (@nikomatt69)
- Standardize code formatting and improve readability (@nikomatt69)
- Implement patching for reasoning options in model variants (@nikomatt69)

## TUI

- Correct import statement for useTheme (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(variants): implement patching for reasoning options in model variants
  - refactor(variants): standardize code formatting and improve readability
  - feat(herdr): add Herdr integration for nikcli
  - fix(browser-surface): correct import statement for useTheme
  - fix(ci): unblock validate — pwsh exit hang, herdr env gate, pty output race

## v1.242.0 (August 2026)

## Core

- Show what the runtime is actually doing, behind /devtools (@nikomatt69)
- Pull the dialog and path logic out of the components (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(tui): pull the dialog and path logic out of the components
  - feat(tui): show what the runtime is actually doing, behind /devtools

## v1.241.0 (August 2026)

## Core

- Ensure consistent export syntax and improve type definitions (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix: ensure consistent export syntax and improve type definitions

## v1.240.0 (August 2026)

## Core

- Introduce math rendering plugin for LaTeX in messages (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(tui): introduce math rendering plugin for LaTeX in messages

## v1.239.0 (August 2026)

## Core

- Ensure consistent export syntax and update type definitions (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix: ensure consistent export syntax and update type definitions

## v1.237.0 (August 2026)

## Core

- Add a golden-screen corpus for the session renderer (@nikomatt69)
- Add the session view seam, and make entry conversion deterministic (@nikomatt69)
- Stop describing deleted code as current (@nikomatt69)
- Make the entry id the sort key, and fold user parts (@nikomatt69)
- Collapse the two v2 projections into one (@nikomatt69)
- Stop double-journaling session events (@nikomatt69)
- Persist entries as a first-class projection (@nikomatt69)
- Event-source the session write path (@nikomatt69)
- Flatten SessionEntry into a type-discriminated union (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(session/v2): flatten SessionEntry into a type-discriminated union
  - feat(sync): event-source the session write path
  - feat(session/v2): persist entries as a first-class projection
  - fix(sync): stop double-journaling session events
  - refactor(session/v2): collapse the two v2 projections into one
  - fix(session/v2): make the entry id the sort key, and fold user parts
  - docs(v2): stop describing deleted code as current
  - feat(tui): add the session view seam, and make entry conversion deterministic
  - test(simulation): add a golden-screen corpus for the session renderer
  - test(simulation): cover tool rendering in the golden corpus

## v1.235.0 (August 2026)

- No notable changes

## v1.233.0 (August 2026)

## Core

- Invoke bun by execPath, not by name (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(build): invoke bun by execPath, not by name

## v1.232.0 (August 2026)

## Core

- Canonicalize with the native realpath on Windows (@nikomatt69)
- Open and close the step for native LLM protocols (@nikomatt69)
- Rename the browser tool to browser_control (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(tool): rename the browser tool to browser_control
  - fix(session): open and close the step for native LLM protocols
  - fix(filesystem): canonicalize with the native realpath on Windows

## v1.230.0 (August 2026)

## Core

- Replace the running nikcli.exe on Windows (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(upgrade): replace the running nikcli.exe on Windows

## v1.229.0 (August 2026)

## Core

- Update classification handling and message structure in tests (@nikomatt69)
- Enhance cache policy and request handling across protocols (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(llm): enhance cache policy and request handling across protocols
  - fix(test): update message structure in OpenRouter tests to include optional role field
  - fix(session): update classification handling and message structure in tests

## v1.219.0 (July 2026)

## Core

- Discover project plugins, reload tui config, persist plugin state (@nikomatt69)
- Retry failed title generation and stop clobbering renames (@nikomatt69)
- Stop SSE reconnect loops on JSON-RPC errors (@nikomatt69)
- Enhance plugin system with memory storage and error handling (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(tui): enhance plugin system with memory storage and error handling
  - fix(mcp): stop SSE reconnect loops on JSON-RPC errors
  - fix(session): retry failed title generation and stop clobbering renames
  - feat(tui): discover project plugins, reload tui config, persist plugin state
  - feat(tui): add replaceable prompt footer slot
  - feat(nikcli): integrate v2 formatter runtime

## v1.218.0 (July 2026)

## Mobile

- Optimize modal rendering by controlling mount state (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(modal): optimize modal rendering by controlling mount state
  - chore(docker): update NIKCLI_VERSION to 1.216.0 in Dockerfiles

## v1.204.0 (July 2026)

## Core

- Add new package and integrate into workspace (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(computer-use): add new package and integrate into workspace

## v1.201.0 (July 2026)

## Core

- Selective port from opencode TUI v2 (reconnect, row grouping, serve, SSE) (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(tui): selective port from opencode TUI v2 (reconnect, row grouping, serve, SSE)
  - Merge pull request #164 from nikomatt69/feat/tui-v2-selective-port

## v1.200.0 (July 2026)

## Core

- Auto prompt-cache placement and OpenAI cache-write accounting (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(llm): auto prompt-cache placement and OpenAI cache-write accounting
  - Merge pull request #162 from nikomatt69/worktree-cache-improvements

## v1.199.0 (July 2026)

- No notable changes

## v1.196.0 (July 2026)

## Mobile

- Split AnimatedTabButton into native + JS layers (@nikomatt69)
- Use translateX instead of left on SessionComposer mode pill (@nikomatt69)
- Give repeated option/question/pattern lists unique keys
- Make Deny/Allow buttons in approval bar a11y-compliant
- Evict stale entries from CommandPaletteSheet itemScales
- Enable native driver on transform-only animations in ComposerToolDrawer
- Run SessionComposer mode pill transform on UI thread
- Serialize persisted preference writes to prevent races
- Clear stale selectedAnswers on question request swap
- Serialize host config writes to prevent RMW races
- Handle network failures in GitHub device-flow poll
- Stop loop form data-loss from 5s polling
- Add useHostResource hook and pilot in agents.tsx
- Extract useCopiedFeedback hook and migrate 4 sites
- Remove dead code and unused dependencies

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(mobile): use translateX instead of left on SessionComposer mode pill
  - fix(mobile): split AnimatedTabButton into native + JS layers

## v1.194.0 (July 2026)

## Core

- Enhance agent guidelines and add new scripts (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(nikcli): enhance agent guidelines and add new scripts

## v1.188.0 (July 2026)

## Core

- Complete opencode reliability ports (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(nikcli): complete opencode reliability ports

## v1.187.0 (July 2026)

## Core

- Implement queued message wrapping and improve shutdown handling (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(nikcli): implement queued message wrapping and improve shutdown handling

## v1.176.0 (July 2026)

- No notable changes

## v1.175.0 (July 2026)

## Mobile

- Notify RN when the terminal WASM engine fails to load (@nikomatt69)
- Enhance user interaction and animations (@nikomatt69)
- Enhance user experience and media handling (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(login, message-bubble, attachment-picker): enhance user experience and media handling
  - feat(bottom-sheet, error-banner, toast-host): enhance user interaction and animations
  - fix(mobile): notify RN when the terminal WASM engine fails to load

## v1.174.0 (July 2026)

## Core

- Standardize import statements and improve code consistency (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(identity, nikcli): standardize import statements and improve code consistency

## v1.169.0 (July 2026)

## Core

- Integrate terminal-control package and enhance GitHub workflow (@nikomatt69)
- Add all-events module to register bus events for Effect Schema (@nikomatt69)
- Document the BusEvent.define→schema sweep (landed in cce9da311) (@nikomatt69)
- Add missing semicolons and improve type definitions in inference-dashboard (@nikomatt69)
- Event-union groundwork — walker z.enum, BusEvent.schema, Session.Info to Effect (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(schema): Event-union groundwork — walker z.enum, BusEvent.schema, Session.Info to Effect
  - fix: add missing semicolons and improve type definitions in inference-dashboard
  - docs(schema): document the BusEvent.define→schema sweep (landed in cce9da311)
  - feat(bus): add all-events module to register bus events for Effect Schema
  - feat(terminal-control): integrate terminal-control package and enhance GitHub workflow

## v1.167.0 (July 2026)

## Core

- Migrate message-v2/SessionStatus/Todo/FileDiff to Effect Schema, wire into PublicApi (@nikomatt69)
- Embedded in-process SDK over the real Hono router (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(sdk-next): embedded in-process SDK over the real Hono router
  - feat(schema): migrate message-v2/SessionStatus/Todo/FileDiff to Effect Schema, wire into PublicApi

## v1.162.0 (July 2026)

## Core

- Enhance CodeMode with tool call tracking and execution limits (@nikomatt69)
- Enhance Promise client with relative imports and text response handling (@nikomatt69)
- Add new package for HTTP API code generation (@nikomatt69)
- Deprecate exec_code in favor of code_mode (@nikomatt69)
- Implement confined code execution with CodeMode (@nikomatt69)
- Update acorn and eventsource versions (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(dependencies): update acorn and eventsource versions
  - feat(nikcli): implement confined code execution with CodeMode
  - feat(nikcli): deprecate exec_code in favor of code_mode
  - feat(httpapi-codegen): add new package for HTTP API code generation
  - feat(httpapi-codegen): enhance Promise client with relative imports and text response handling
  - feat(nikcli): enhance CodeMode with tool call tracking and execution limits

## v1.160.0 (July 2026)

## Core

- Update TypeScript native preview and add xterm packages (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(dependencies): update TypeScript native preview and add xterm packages

## v1.143.0 (July 2026)

## Core

- Add Island plugin to internal TUI plugins and enhance IslandBridge functionality (@nikomatt69)
- Integrate IslandBridge for improved event handling (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat(nikcli): integrate IslandBridge for improved event handling
  - feat(nikcli): add Island plugin to internal TUI plugins and enhance IslandBridge functionality

## v1.137.0 (July 2026)

## Core

- Snapshot projections for sessions, cold-start endpoint, SDK regen (@claude)

**Thank you to 2 community contributors:**

- @claude:
  - feat(sync): snapshot projections for sessions, cold-start endpoint, SDK regen
  - merge: live-main v1.135.0, regenerate openapi.json from merged tree
- @nikomatt69:
  - feat(sync): snapshot projections for sessions, cold-start endpoint, SDK regen (#136)

## v1.135.0 (July 2026)

## Core

- Journal local sessions, idempotent remote sync, bootstrap wiring (@claude)
- Instance hot reload and unified sync backend for workspaces (@claude)

**Thank you to 2 community contributors:**

- @claude:
  - feat: instance hot reload and unified sync backend for workspaces
  - merge: live-main unified sync architecture into hot-reload branch
  - merge: live-main v1.134.0, keep hot-reload config state and restore event filter
  - feat(sync): journal local sessions, idempotent remote sync, bootstrap wiring
  - feat(sync): enforce token scopes, rate-limit and audit hub event pushes
- @nikomatt69:
  - feat: instance hot reload + workspace event catch-up on unified sync log (#133)
  - feat(sync): local session journaling, idempotent remote sync, bootstrap wiring (#134)
  - feat(sync): enforce token scopes, rate-limit and audit hub event pushes (#135)

## v1.134.0 (July 2026)

## Core

- Add missing semicolons and improve type declarations in content modules (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix: add missing semicolons and improve type declarations in content modules

## v1.133.0 (June 2026)

## Desktop

- Integrate account management features into the application (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - feat: integrate account management features into the application

## v1.132.0 (June 2026)

- No notable changes

## v1.129.0 (June 2026)

## Desktop

- Enhance dialog components with summary cards and status pills (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor: enhance dialog components with summary cards and status pills

## v1.128.0 (June 2026)

## Desktop

- Enhance desktop release workflow and version handling (@nikomatt69)
- Implement directory commands in the layout component (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - Implement directory commands in the layout component
  - fix: enhance desktop release workflow and version handling

## v1.124.0 (June 2026)

## Desktop

- Implement directory commands in the layout component (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - Implement directory commands in the layout component

## v1.122.0 (June 2026)

- No notable changes

## v1.120.0 (June 2026)

- No notable changes

## v1.119.0 (June 2026)

## Desktop

- Add download/install instructions for unsigned releases (@nikomatt69)
- Update macOS signing configuration for desktop release (@nikomatt69)
- Enhance side panel and resizing logic (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - refactor(desktop): enhance side panel and resizing logic
  - chore(ci): update macOS signing configuration for desktop release
  - docs(desktop): add download/install instructions for unsigned releases

## v1.116.0 (June 2026)

- No notable changes

## v1.115.0 (June 2026)

## Desktop

- Drop AppImage + avoid bun-run remap so Linux/Windows desktop builds pass (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(ci): drop AppImage + avoid bun-run remap so Linux/Windows desktop builds pass

## v1.113.0 (June 2026)

## Desktop

- Unblock desktop build/bundle/sign on all platforms (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(ci): unblock desktop build/bundle/sign on all platforms

## v1.112.0 (June 2026)

## Desktop

- Slim CLI sidecar artifact + fix sidecar path so desktop builds pass (@nikomatt69)

**Thank you to 1 community contributor:**

- @nikomatt69:
  - fix(ci): slim CLI sidecar artifact + fix sidecar path so desktop builds pass

## v1.111.0 (June 2026)

- No notable changes

## v1.108.0 (June 2026)

- No notable changes

## v1.107.0 (June 2026)

- No notable changes

## v1.106.0 (June 2026)

- No notable changes

## v1.5.0 (May 2026)

### Highlights

- **Effect Schema Migration Phase P**: Completed migration of core domains to Effect Schema for improved type safety and composability.
- **New modules migrated**: Sync, Workspace, SessionStatus, File.Node/Content, Sandbox.Ref/State, BackgroundRun, Log.Level, ModelsDev, Provider.Model/Info
- **Additional migrations**: Connectors, Vcs.Info, Worktree, Project, ProviderAuth, MCP resources/auth, BusEvent, Delegation, Bus
- **Docker improvements**: Added wake notification for background tasks, Dockerfile updates

### Migration Notes

This release continues the Effect Schema migration pattern established in previous versions. Key changes include:

- Schema definitions now use `effect`'s `Schema` module instead of Zod for internal validation
- Service interfaces remain unchanged; consumers of existing APIs should experience no breaking changes
- New Effect-based error types provide better stack traces and cause chain debugging

### Commits

- feat(effect): Integrate Sync and Workspace modules as Effect Services
- feat(docker): Update Dockerfile and add wake notification for background tasks
- feat(effect): Phase P — SessionStatus.Info + session domain Inputs
- feat(effect): Phase P — Workspace.Info, Restore, SessionRestore, ConnectionStatus
- feat(effect): Phase P — File.Node/Content + Workspace.Config
- feat(effect): Phase P — Sandbox.Ref/State + BackgroundRun.Record
- feat(effect): Phase P — Log.Level + spec consolidation
- feat(effect): Phase P — ModelsDev.Model + ModelsDev.Provider + Monitor.Record
- feat(effect): Phase P — Provider.Model + Provider.Info to Effect Schema
- feat(effect): Phase P — Connectors.Entry, Vcs.Info, Worktree schemas + DeepMutable shared

---

## Week of February 3, 2026

### Highlights

- Added end-to-end connectors management in `nikcli`, including CLI/TUI flows, connector auth, and API routes.
- Improved connector validation and shared helpers to make connector setup and usage more reliable.
- Integrated `@nikcli-ai/sdk` across the app stack and expanded deployment/setup documentation.
- Added a new mobile package with events, sessions, settings, and SSE-driven realtime updates.
- Released `v0.0.2` and updated install/publish scripts for smoother release operations.
