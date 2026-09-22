import { describe, expect, it } from "bun:test"
import { UserFacingError, userFacingParts } from "@nikcli-ai/util/user-error"
import { Effect, Exit } from "effect"

describe("UserFacingError (Schema.TaggedError)", () => {
  it("constructs with the documented field shape", () => {
    const err = new UserFacingError({
      title: "Auth session expired",
      what: "Provider rejected the refresh token.",
      try: "Run `nikcli auth login` to reconnect.",
      docs: "https://nikcli-ai.dev/docs/auth",
    })
    expect(err._tag).toBe("UserFacingError")
    expect(err.name).toBe("UserFacingError")
    expect(err.title).toBe("Auth session expired")
    expect(err.what).toBe("Provider rejected the refresh token.")
    expect(err.try).toBe("Run `nikcli auth login` to reconnect.")
    expect(err.docs).toBe("https://nikcli-ai.dev/docs/auth")
    // The `trySuggestion` alias is kept for back-compat with call sites that
    // read the legacy property name (FormatError, userFacingParts, TUI toast).
    expect(err.trySuggestion).toBe("Run `nikcli auth login` to reconnect.")
  })

  it("extends Error so `instanceof` and `try/catch` paths still work", () => {
    const err = new UserFacingError({
      title: "t",
      what: "w",
      try: "tr",
    })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(UserFacingError)
  })

  it("formats title / what / try / docs as a one-shot CLI string", () => {
    const err = new UserFacingError({
      title: "Title",
      what: "what happened",
      try: "what to try",
      docs: "https://docs",
    })
    expect(err.format()).toBe(
      ["Title", "  What: what happened", "  Try:  what to try", "  Docs: https://docs"].join("\n"),
    )
  })

  it("userFacingParts returns the structured fields for a UserFacingError", () => {
    const err = new UserFacingError({
      title: "t",
      what: "w",
      try: "tr",
    })
    expect(userFacingParts(err)).toEqual({ title: "t", what: "w", try: "tr" })
  })

  it("userFacingParts returns null for non-UserFacingError values", () => {
    expect(userFacingParts(new Error("nope"))).toBeNull()
    expect(userFacingParts("nope")).toBeNull()
    expect(userFacingParts(null)).toBeNull()
  })

  it("can be caught via Effect.catchTag with the _tag literal", async () => {
    const program = Effect.fail(new UserFacingError({ title: "t", what: "w", try: "tr" })).pipe(
      Effect.catchTag("UserFacingError", (err) => Effect.succeed(`caught: ${err.title}`)),
    )
    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe("caught: t")
    }
  })
})
