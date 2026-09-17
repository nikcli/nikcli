import { afterEach, expect, test } from "bun:test"
import { mayReroute, pickProvider, setProviderPicker } from "./provider-pick"

afterEach(() => setProviderPicker())

test("with no picker registered, spawn starts the agent asked for", async () => {
  expect(await pickProvider({ agent: "claude-code", from: "a" })).toEqual({ agent: "claude-code" })
})

test("a registered picker can send the session elsewhere, with a reason", async () => {
  setProviderPicker(async ({ agent }) =>
    agent === "claude-code" ? { agent: "codex", reason: "quota Claude esaurita fino alle 18:00" } : { agent },
  )
  expect(await pickProvider({ agent: "claude-code", from: "a" })).toEqual({
    agent: "codex",
    reason: "quota Claude esaurita fino alle 18:00",
  })
})

test("a picker that fails or answers nothing changes nothing", async () => {
  setProviderPicker(() => {
    throw new Error("ledger non leggibile")
  })
  expect(await pickProvider({ agent: "codex", from: "" })).toEqual({ agent: "codex" })
  setProviderPicker(() => ({ agent: "" }))
  expect(await pickProvider({ agent: "codex", from: "" })).toEqual({ agent: "codex" })
})
test("a spawn is routed by quota only when the caller chose nothing that belongs to one agent", () => {
  expect(mayReroute({})).toBe(true)
  expect(mayReroute({ model: "gpt-5" })).toBe(false)
  expect(mayReroute({ fork: true })).toBe(false)
  // Checked against the agent they name: rerouted first, they were refused on the substitute.
  expect(mayReroute({ profile: "revisore" })).toBe(false)
  expect(mayReroute({ effort: "max" })).toBe(false)
})
