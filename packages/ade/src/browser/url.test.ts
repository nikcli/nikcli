import { describe, expect, test } from "bun:test"
import { isValidBrowserUrl, normalizeUrl } from "./url"

describe("normalizeUrl", () => {
  describe("port shorthands", () => {
    test("normalizes numeric string into localhost URL", () => {
      expect(normalizeUrl("3000")).toBe("http://localhost:3000")
      expect(normalizeUrl("5173")).toBe("http://localhost:5173")
      expect(normalizeUrl("8080")).toBe("http://localhost:8080")
      expect(normalizeUrl("80")).toBe("http://localhost:80")
    })

    test("normalizes numeric string with path and query", () => {
      expect(normalizeUrl("3000/api/v1")).toBe("http://localhost:3000/api/v1")
      expect(normalizeUrl("5173/dashboard?tab=analytics#overview")).toBe(
        "http://localhost:5173/dashboard?tab=analytics#overview",
      )
    })

    test("normalizes colon-prefixed port shorthand", () => {
      expect(normalizeUrl(":3000")).toBe("http://localhost:3000")
      expect(normalizeUrl(":5173")).toBe("http://localhost:5173")
      expect(normalizeUrl(":8080/settings")).toBe("http://localhost:8080/settings")
    })

    test("refuses ports outside 1..65535", () => {
      expect(normalizeUrl("0")).toBeUndefined()
      expect(normalizeUrl("65536")).toBeUndefined()
      expect(normalizeUrl("99999")).toBeUndefined()
      expect(normalizeUrl(":0")).toBeUndefined()
      expect(normalizeUrl(":65536")).toBeUndefined()
      expect(normalizeUrl(":-1")).toBeUndefined()
      expect(normalizeUrl("-500")).toBeUndefined()
    })
  })

  describe("hosts and domains without scheme", () => {
    test("normalizes localhost and IP addresses", () => {
      expect(normalizeUrl("localhost")).toBe("http://localhost/")
      /*
       * The canonical form, which is what `new URL` produces: an empty path
       * is written as `/`. The function used to validate the parsed URL and
       * then return the raw string it was handed, so anything `new URL`
       * would have percent-encoded came out intact — see the escaping test
       * below for why that mattered.
       */
      expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000/")
      expect(normalizeUrl("localhost:5173/app")).toBe("http://localhost:5173/app")
      expect(normalizeUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/")
      expect(normalizeUrl("0.0.0.0:3000")).toBe("http://0.0.0.0:3000/")
      expect(normalizeUrl("[::1]:3000")).toBe("http://[::1]:3000/")
    })

    test("normalizes domain names", () => {
      expect(normalizeUrl("example.com")).toBe("http://example.com/")
      expect(normalizeUrl("example.com/test")).toBe("http://example.com/test")
      expect(normalizeUrl("sub.domain.org:8080/path?query=1")).toBe("http://sub.domain.org:8080/path?query=1")
      expect(normalizeUrl("my-app.local:3000")).toBe("http://my-app.local:3000/")
    })

    test("refuses invalid ports in host strings", () => {
      expect(normalizeUrl("localhost:0")).toBeUndefined()
      expect(normalizeUrl("localhost:65536")).toBeUndefined()
      expect(normalizeUrl("localhost:99999")).toBeUndefined()
      expect(normalizeUrl("example.com:70000")).toBeUndefined()
    })
  })

  describe("explicit http and https schemes", () => {
    test("preserves valid http and https URLs", () => {
      expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000/")
      expect(normalizeUrl("https://x.dev/a?b=c")).toBe("https://x.dev/a?b=c")
      expect(normalizeUrl("http://127.0.0.1:8080/api")).toBe("http://127.0.0.1:8080/api")
      // The default port for the scheme is dropped, as every browser does.
      expect(normalizeUrl("https://example.com:443/test#anchor")).toBe("https://example.com/test#anchor")
      expect(normalizeUrl("http://[::1]:3000")).toBe("http://[::1]:3000/")
    })

    test("handles case-insensitive scheme matching", () => {
      // Canonicalised, scheme included: `HTTP:` and `http:` are the same
      // scheme, and returning the typed casing meant two spellings of one
      // address compared unequal everywhere downstream.
      expect(normalizeUrl("HTTP://localhost:3000")).toBe("http://localhost:3000/")
      expect(normalizeUrl("HTTPS://x.dev/a?b=c")).toBe("https://x.dev/a?b=c")
    })

    test("refuses explicit http/https with invalid ports", () => {
      expect(normalizeUrl("http://localhost:0")).toBeUndefined()
      expect(normalizeUrl("http://localhost:65536")).toBeUndefined()
      expect(normalizeUrl("https://example.com:99999")).toBeUndefined()
    })

    /*
     * The function validated the parsed URL and returned the *raw* string,
     * so every character `new URL` would have percent-encoded survived.
     * `loadMirror` interpolates the result into `<base href="…">` with no
     * escaping, so a double quote closed the attribute and the rest became
     * markup in a document that — before the sandbox was fixed — ran in
     * ADE's own origin.
     */
    test("escapes what an attribute would otherwise let out", () => {
      const out = normalizeUrl('http://localhost:3000/"><script>alert(1)</script>')
      expect(out).toBeDefined()
      expect(out).not.toContain('"')
      expect(out).not.toContain("<")
      expect(out).not.toContain(">")
      expect(out).toContain("%22")
    })

    /*
     * `http://localhost:3000@evil.com/` is a valid URL whose host is
     * evil.com — everything before the `@` is a username. The address bar
     * showed the part the eye stops at, the frame loaded the other site, and
     * the whole string reached the agent's prompt through
     * `formatSelectionContext`, telling the agent it was on localhost too.
     */
    test("refuses the userinfo form, which is a disguise and not a credential", () => {
      expect(normalizeUrl("http://localhost:3000@evil.com/")).toBeUndefined()
      expect(normalizeUrl("https://user:pass@example.com/")).toBeUndefined()
      expect(normalizeUrl("localhost:3000@evil.com")).toBeUndefined()
    })
  })

  describe("rejected schemes and dangerous inputs", () => {
    test("rejects javascript: scheme in any case or format", () => {
      expect(normalizeUrl("javascript:alert(1)")).toBeUndefined()
      expect(normalizeUrl("JAVASCRIPT:void(0)")).toBeUndefined()
      expect(normalizeUrl("javascript:/*comment*/alert(1)")).toBeUndefined()
      expect(normalizeUrl("  javascript:alert(document.cookie)  ")).toBeUndefined()
      expect(normalizeUrl("java\u0000script:alert(1)")).toBeUndefined()
    })

    test("rejects data: scheme", () => {
      expect(normalizeUrl("data:text/html,<h1>test</h1>")).toBeUndefined()
      expect(normalizeUrl("DATA:text/plain;base64,SGVsbG8=")).toBeUndefined()
    })

    test("rejects file: scheme", () => {
      expect(normalizeUrl("file:///etc/passwd")).toBeUndefined()
      expect(normalizeUrl("file:///C:/Windows/System32")).toBeUndefined()
      expect(normalizeUrl("FILE:///path/to/file")).toBeUndefined()
    })

    test("rejects vbscript: scheme", () => {
      expect(normalizeUrl("vbscript:msgbox('hi')")).toBeUndefined()
      expect(normalizeUrl("VBSCRIPT:test")).toBeUndefined()
    })

    test("rejects other non-http schemes", () => {
      expect(normalizeUrl("ftp://ftp.example.com/file")).toBeUndefined()
      expect(normalizeUrl("ws://localhost:3000")).toBeUndefined()
      expect(normalizeUrl("wss://localhost:3000")).toBeUndefined()
      expect(normalizeUrl("blob:https://example.com/uuid")).toBeUndefined()
      expect(normalizeUrl("about:blank")).toBeUndefined()
      expect(normalizeUrl("chrome://settings")).toBeUndefined()
      expect(normalizeUrl("mailto:test@example.com")).toBeUndefined()
    })
  })

  describe("malformed and empty inputs", () => {
    test("refuses empty or whitespace strings", () => {
      expect(normalizeUrl("")).toBeUndefined()
      expect(normalizeUrl("   ")).toBeUndefined()
      expect(normalizeUrl("\t\n")).toBeUndefined()
    })

    test("refuses strings with spaces in host", () => {
      expect(normalizeUrl("foo bar:3000")).toBeUndefined()
      expect(normalizeUrl("not a url at all")).toBeUndefined()
    })

    test("refuses incomplete scheme inputs", () => {
      expect(normalizeUrl("http://")).toBeUndefined()
      expect(normalizeUrl("https://")).toBeUndefined()
      expect(normalizeUrl("http:// ")).toBeUndefined()
    })
  })
})

describe("isValidBrowserUrl", () => {
  test("returns true for valid URLs", () => {
    expect(isValidBrowserUrl("3000")).toBe(true)
    expect(isValidBrowserUrl(":5173")).toBe(true)
    expect(isValidBrowserUrl("localhost:3000")).toBe(true)
    expect(isValidBrowserUrl("https://x.dev/a?b=c")).toBe(true)
    expect(isValidBrowserUrl("example.com")).toBe(true)
  })

  test("returns false for invalid or rejected URLs", () => {
    expect(isValidBrowserUrl("")).toBe(false)
    expect(isValidBrowserUrl("javascript:alert(1)")).toBe(false)
    expect(isValidBrowserUrl("file:///etc/passwd")).toBe(false)
    expect(isValidBrowserUrl("65536")).toBe(false)
    expect(isValidBrowserUrl("ftp://example.com")).toBe(false)
  })
})
