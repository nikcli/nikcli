import type { Turn, ViewEntry } from "@tui/routes/session/view"

/**
 * Synthetic turns, built by hand.
 *
 * `ViewEntry` and `Turn` are structural on purpose — `view.ts` says so — so a
 * fixture names only the fields the renderers read. That is also the contract
 * check: if a story needs a field this file does not set, a component grew a
 * dependency that the type no longer documents.
 */

const SESSION = "storybook"
const T0 = 1_700_000_000_000

let counter = 0
function id(): string {
  counter += 1
  return `e${String(counter).padStart(4, "0")}`
}

export function entry(type: string, extra: Record<string, unknown> = {}): ViewEntry {
  return { id: id(), sessionID: SESSION, messageID: "m1", type, timestamp: T0, ...extra }
}

function turn(role: "user" | "assistant", body: ViewEntry[], extra: Partial<Turn> = {}): Turn {
  return {
    messageID: `m${role === "user" ? "1" : "2"}`,
    sessionID: SESSION,
    role,
    createdAt: T0,
    completedAt: T0 + 4200,
    compacted: false,
    body,
    ...extra,
  } as Turn
}

const SHORT = "Rename the theme resolver and keep the tests green."

const LONG = [
  "Two things to settle before the rename.",
  "",
  "`resolveColor` closes over `defs`, so hoisting it changes the call shape:",
  "",
  "```ts",
  "const resolve = createColorResolver(document, mode)",
  "```",
  "",
  "The second is that a component token must not throw — a typo in hand-edited",
  "JSON would otherwise take the whole palette down with it.",
].join("\n")

export const FIXTURES = {
  userShort: turn("user", [entry("user", { text: SHORT })]),

  userWithFiles: turn("user", [
    entry("user", {
      text: "Check this frame against the previous one.",
      files: [
        { mime: "image/png", filename: "frame.png" },
        { mime: "text/plain", filename: "notes.txt" },
      ],
    }),
  ]),

  assistantText: turn("assistant", [entry("text", { text: LONG, completed: T0 + 4000 })], {
    request: { agent: "build", mode: "normal", modelID: "grok-4.6", providerID: "xai" },
    complete: { finish: "stop", outputTokens: 694, cost: 0.004 },
  }),

  assistantStreaming: turn(
    "assistant",
    [entry("text", { text: "Reading `theme.tsx` to see whether the resolver is" })],
    { request: { agent: "build", mode: "normal", modelID: "grok-4.6", providerID: "xai" }, completedAt: undefined },
  ),

  reasoning: turn(
    "assistant",
    [entry("reasoning", { text: "The estimator duplicates the padding as a constant.", completed: T0 + 900 })],
    { request: { agent: "plan", mode: "normal", modelID: "grok-4.6", providerID: "xai" } },
  ),

  retry: turn("assistant", [entry("retry", { attempt: 2, error: { name: "TimeoutError" } })]),

  synthetic: turn("assistant", [entry("synthetic", { text: "Session resumed from a snapshot." })]),

  /** No renderer handles this type — the row must still be visible. */
  unknown: turn("assistant", [entry("invented-type")]),
} satisfies Record<string, Turn>

export type FixtureName = keyof typeof FIXTURES
