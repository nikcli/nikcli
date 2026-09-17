import { describe, expect, test } from "bun:test"
import { escapeAttribute, withLoadToken } from "./frame-url"

describe("withLoadToken", () => {
  test("the first load requests exactly the URL that was typed", () => {
    expect(withLoadToken("http://localhost:3000/app", 1)).toBe("http://localhost:3000/app")
    expect(withLoadToken("http://localhost:3000/app", 0)).toBe("http://localhost:3000/app")
  })

  /*
   * Reload rewrote `src` with the identical string, Solid wrote nothing, and
   * the frame did not renavigate — while the handshake timer fired anyway
   * and swapped a live page for a static mirror. So the button's only
   * visible effect was to downgrade the preview.
   */
  test("a reload produces a different string, which is the whole point", () => {
    const once = withLoadToken("http://localhost:3000/app", 2)
    const twice = withLoadToken("http://localhost:3000/app", 3)
    expect(once).not.toBe("http://localhost:3000/app")
    expect(twice).not.toBe(once)
  })

  test("an existing query is kept", () => {
    const out = withLoadToken("http://localhost:3000/app?tab=log", 2)
    expect(out).toContain("tab=log")
    expect(out).toContain("__ade_reload=2")
  })

  test("the marker is replaced, not stacked, across reloads", () => {
    const out = withLoadToken(withLoadToken("http://x.dev/", 2), 3)
    expect(out.match(/__ade_reload/g)).toHaveLength(1)
    expect(out).toContain("__ade_reload=3")
  })

  test("a hash survives", () => {
    expect(withLoadToken("http://x.dev/a#top", 2)).toContain("#top")
  })

  test("something unparseable is returned untouched rather than corrupted", () => {
    expect(withLoadToken("non un url", 2)).toBe("non un url")
  })
})

describe("escapeAttribute", () => {
  /*
   * `loadMirror` builds `<base href="…">` by hand. One unescaped quote
   * closes the attribute and the rest becomes markup — in a document that,
   * before the sandbox lost `allow-same-origin`, ran in ADE's own origin.
   */
  test("a quote cannot close the attribute", () => {
    const out = escapeAttribute('http://x.dev/"><script>alert(1)</script>')
    expect(out).not.toContain('"')
    expect(out).not.toContain("<")
    expect(out).not.toContain(">")
  })

  test("ampersands are escaped first, so nothing is double-escaped", () => {
    expect(escapeAttribute("http://x.dev/?a=1&b=2")).toBe("http://x.dev/?a=1&amp;b=2")
    expect(escapeAttribute('a&"b')).toBe("a&amp;&quot;b")
  })

  test("an ordinary URL survives unchanged", () => {
    expect(escapeAttribute("http://localhost:3000/app/")).toBe("http://localhost:3000/app/")
  })
})
