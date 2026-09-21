import { createMemo, type JSX, type ParentProps } from "solid-js"
import { createStandaloneTheme, ThemeContext } from "@tui/context/theme"
import { LocalContext } from "@tui/context/local"
import { SyncContext } from "@tui/context/sync"
import { context as SessionContext, type SessionViewContext } from "@tui/routes/session/session-context"
import type { ComponentPatchMap } from "@tui/context/component-tokens"
import { RGBA } from "@opentui/core"

/**
 * The four contexts a session component reads, supplied from fixtures.
 *
 * Deliberately not the real providers. `SyncProvider` bootstraps against the
 * server and `KVProvider` reads the user's `kv.json`, so mounting them here
 * would make a story depend on a running nikcli and on whatever the person last
 * did in the app — the two things a storybook exists to remove. `ThemeProvider`
 * additionally resolves the *active* theme, while the whole point here is to
 * drive it.
 *
 * What is NOT faked is the theme resolution itself: `createStandaloneTheme`
 * runs the same `resolveTheme` and `resolveComponents` the app runs. A story
 * therefore proves the real palette and the real component tokens, not a
 * lookalike — which is the only reason to trust what it shows.
 *
 * The surface below is small because it was measured, not guessed: across every
 * extracted part, the only reads are `local.agent.color`, `sync.data.config`,
 * `sync.data.permission`, and five fields of the session view context. Growing
 * this file is the signal that a component reached for something new.
 */

export type HarnessOptions = {
  /** A theme document, as `context/theme/*.json` stores one. */
  readonly document: unknown
  readonly mode: "dark" | "light"
  /** Component patches layered over the document, as the studio would write them. */
  readonly overrides?: ComponentPatchMap
  readonly width: number
  readonly height: number
  readonly showThinking?: boolean
  readonly showTimestamps?: boolean
  readonly showDetails?: boolean
  readonly conceal?: boolean
}

/** Agent colors, by the same names the app assigns. Stable so stories are stable. */
const AGENT_COLORS: Record<string, RGBA> = {
  build: RGBA.fromHex("#6fa3ff"),
  plan: RGBA.fromHex("#d9a14a"),
  explore: RGBA.fromHex("#7fc08f"),
}

const FALLBACK_AGENT_COLOR = RGBA.fromHex("#9a9a9a")

function fakeLocal() {
  return {
    agent: {
      color(id: string) {
        return AGENT_COLORS[id] ?? FALLBACK_AGENT_COLOR
      },
    },
  }
}

function fakeSync() {
  return {
    data: {
      // `tui.turn_tokens` off matches the app's default, so the token table
      // stays out of a story unless a story asks for it.
      config: { tui: {} },
      permission: [],
    },
  }
}

export function Harness(props: ParentProps<HarnessOptions>): JSX.Element {
  const theme = createMemo(() =>
    createStandaloneTheme({
      document: props.document,
      mode: props.mode,
      overrides: props.overrides,
    }),
  )

  const session = createMemo<SessionViewContext>(() => ({
    width: props.width,
    height: props.height,
    sessionID: "storybook",
    conceal: () => props.conceal ?? false,
    showThinking: () => props.showThinking ?? true,
    showTimestamps: () => props.showTimestamps ?? false,
    showDetails: () => props.showDetails ?? false,
    diffWrapMode: () => "word",
    messageCreatedAt: () => ({}),
    sync: fakeSync() as unknown as SessionViewContext["sync"],
  }))

  return (
    // The casts are the honest cost of not mounting the real providers: these
    // contexts type as the full provider return, and a story needs a fraction
    // of it. Each cast is one place to look when a component starts reading
    // something the harness does not supply — it will be `undefined`, loudly,
    // rather than silently wrong.
    <ThemeContext.Provider value={theme() as unknown as never}>
      <LocalContext.Provider value={fakeLocal() as unknown as never}>
        <SyncContext.Provider value={fakeSync() as unknown as never}>
          <SessionContext.Provider value={session()}>{props.children}</SessionContext.Provider>
        </SyncContext.Provider>
      </LocalContext.Provider>
    </ThemeContext.Provider>
  )
}
