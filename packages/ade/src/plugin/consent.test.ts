import { describe, expect, test } from "bun:test"
import { consentFingerprint, consentQuestion, hasConsent, withConsent } from "./consent"

const plugin = (spec: string, entry = `file:///C:/repo/${spec}`) => ({ spec, entry })

describe("plugin consent", () => {
  test("nothing runs until approved", () => {
    expect(hasConsent(null, "C:/repo", [plugin("a.js")])).toBe(false)
    expect(hasConsent("not json", "C:/repo", [plugin("a.js")])).toBe(false)
  })

  test("an approval covers the same plugins in any order, for that project only", () => {
    const store = withConsent(null, "C:/repo", [plugin("a.js"), plugin("b.js")])
    expect(hasConsent(store, "C:/repo", [plugin("b.js"), plugin("a.js")])).toBe(true)
    expect(hasConsent(store, "C:/other", [plugin("a.js"), plugin("b.js")])).toBe(false)
  })

  test("a new plugin or a moved entrypoint asks again", () => {
    const store = withConsent(null, "C:/repo", [plugin("a.js")])
    expect(hasConsent(store, "C:/repo", [plugin("a.js"), plugin("b.js")])).toBe(false)
    expect(hasConsent(store, "C:/repo", [plugin("a.js", "file:///C:/repo/evil.js")])).toBe(false)
  })

  test("approvals of other projects are kept", () => {
    const first = withConsent(null, "C:/one", [plugin("a.js")])
    const both = withConsent(first, "C:/two", [plugin("b.js")])
    expect(hasConsent(both, "C:/one", [plugin("a.js")])).toBe(true)
    expect(consentFingerprint([plugin("b.js"), plugin("a.js")])).toBe("file:///C:/repo/a.js\nfile:///C:/repo/b.js")
  })

  test("the question names every plugin", () => {
    const text = consentQuestion("C:/repo", [plugin("a.js"), plugin("b.js")])
    expect(text).toContain("a.js")
    expect(text).toContain("b.js")
  })
})
