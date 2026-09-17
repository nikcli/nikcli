import { describe, expect, test } from "bun:test"
import { isTestIdentifier } from "./build-identity"

describe("isTestIdentifier", () => {
  test("recognises the test build", () => {
    expect(isTestIdentifier("ai.nikcli.ade.test")).toBe(true)
  })

  test("leaves the official build alone", () => {
    expect(isTestIdentifier("ai.nikcli.ade")).toBe(false)
    expect(isTestIdentifier("ai.nikcli.ade.testing")).toBe(false)
  })
})
