import { describe, expect, test } from "bun:test"
import {
  HISTORY_LIMIT,
  canStep,
  currentEntry,
  redactHistory,
  redactUrl,
  restoreHistory,
  startHistory,
  step,
  visit,
} from "./history"

const A = "https://a.test/"
const B = "https://b.test/"
const C = "https://c.test/"

describe("browser history", () => {
  test("a visit becomes the current entry", () => {
    const history = visit(startHistory(A), B)
    expect(history).toEqual({ entries: [A, B], index: 1 })
    expect(currentEntry(history)).toBe(B)
  })

  test("loading the page already shown adds nothing", () => {
    const history = startHistory(A)
    expect(visit(history, A)).toBe(history)
  })

  test("back and forward walk the list and stop at its ends", () => {
    const history = visit(visit(startHistory(A), B), C)
    const back = step(history, -1)
    expect(currentEntry(back)).toBe(B)
    expect(currentEntry(step(back, 1))).toBe(C)
    expect(step(history, 1)).toBe(history)
    const first = step(step(history, -1), -1)
    expect(canStep(first, -1)).toBe(false)
    expect(step(first, -1)).toBe(first)
  })

  test("a visit after going back drops what was ahead", () => {
    const history = visit(step(visit(visit(startHistory(A), B), C), -1), A)
    expect(history).toEqual({ entries: [A, B, A], index: 2 })
    expect(canStep(history, 1)).toBe(false)
  })

  test("the list is bounded", () => {
    let history = startHistory("https://0.test/")
    for (let i = 1; i < HISTORY_LIMIT + 10; i++) history = visit(history, `https://${i}.test/`)
    expect(history.entries).toHaveLength(HISTORY_LIMIT)
    expect(currentEntry(history)).toBe(`https://${HISTORY_LIMIT + 9}.test/`)
  })
})

describe("restoreHistory", () => {
  test("keeps a saved history whose current entry is the pane's URL", () => {
    expect(restoreHistory(B, { entries: [A, B, C], index: 1 })).toEqual({ entries: [A, B, C], index: 1 })
  })

  test("starts over from the URL on anything else", () => {
    for (const saved of [
      undefined,
      "x",
      { entries: [A, B], index: 0 },
      { entries: [A, 3], index: 0 },
      { entries: [B], index: 1 },
      { entries: [B], index: 0.5 },
      { entries: [B] },
    ]) {
      expect(restoreHistory(B, saved)).toEqual({ entries: [B], index: 0 })
    }
  })

  test("an oversized history keeps its tail, and its current entry if it is there", () => {
    const entries = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => `https://${i}.test/`)
    const last = entries.length - 1
    expect(restoreHistory(entries[last], { entries, index: last })).toEqual({
      entries: entries.slice(-HISTORY_LIMIT),
      index: HISTORY_LIMIT - 1,
    })
    expect(restoreHistory(entries[0], { entries, index: 0 })).toEqual({ entries: [entries[0]], index: 0 })
  })
})

describe("redactUrl", () => {
  test("drops the query parameters that carry credentials", () => {
    expect(redactUrl("http://localhost:8888/lab?token=abc123")).toBe("http://localhost:8888/lab")
    expect(redactUrl("https://app.test/cb?code=xyz&state=s1")).toBe("https://app.test/cb?state=s1")
    expect(redactUrl("https://a.test/?api_key=1&apiKey=2&X-Amz-Signature=3&sessionid=4&password=5&auth=6&page=2")).toBe(
      "https://a.test/?page=2",
    )
    expect(redactUrl("https://a.test/?client_secret=1&xsrfToken=2&q=ok")).toBe("https://a.test/?q=ok")
  })

  test("keeps parameters that only resemble one", () => {
    const url = "https://a.test/?zipcode=40127&monkey=1&author=x&keyword=y"
    expect(redactUrl(url)).toBe(url)
  })

  test("drops a fragment carrying an OAuth token, keeps an ordinary anchor", () => {
    expect(redactUrl("https://a.test/cb#access_token=t&token_type=bearer")).toBe("https://a.test/cb")
    expect(redactUrl("https://a.test/#/cb?id_token=t")).toBe("https://a.test/")
    expect(redactUrl("https://bastelli-cmp.vercel.app/#top")).toBe("https://bastelli-cmp.vercel.app/#top")
    expect(redactUrl("https://a.test/#section=2")).toBe("https://a.test/#section=2")
  })

  test("drops credentials in the address itself", () => {
    expect(redactUrl("https://user:pw@a.test/x")).toBe("https://a.test/x")
  })

  test("an unreadable URL keeps only what precedes its query", () => {
    expect(redactUrl("not a url?token=1")).toBe("not a url")
  })

  test("a redacted history still restores on its redacted URL", () => {
    const history = visit(startHistory("http://localhost:8888/?token=a"), "http://localhost:8888/tree?token=a")
    const saved = redactHistory(history)
    expect(saved.entries).toEqual(["http://localhost:8888/", "http://localhost:8888/tree"])
    expect(restoreHistory(redactUrl(currentEntry(history)), saved)).toEqual(saved)
  })
})

describe("redactUrl on the path", () => {
  test("a token in the path leaves only the site", () => {
    expect(redactUrl("https://app.test/reset/a8f3k2m9x1")).toBe("https://app.test/")
    expect(redactUrl("https://app.test/auth/magic-link/Zx81Qm0pLr")).toBe("https://app.test/")
    expect(redactUrl("https://files.test/s/k3J9dLq0PzX8vB2nR7tY5wQ1/report.pdf?x=1")).toBe("https://files.test/")
    expect(redactUrl("http://localhost:3000/invite/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2ln")).toBe("http://localhost:3000/")
  })

  test("ordinary paths are kept as written", () => {
    for (const url of [
      "https://bastelli-cmp.vercel.app/#top",
      "https://a.test/docs/getting-started/installation-guide",
      "https://a.test/reset",
      "https://a.test/share/settings",
      "https://a.test/blog/2026/09/17/post",
      "http://localhost:5173/users/42/edit",
    ]) {
      expect(redactUrl(url)).toBe(url)
    }
  })

  test("a history keeps its shape when an entry is reduced to its site", () => {
    const history = visit(startHistory("https://app.test/"), "https://app.test/reset/a8f3k2m9x1")
    const saved = redactHistory(history)
    expect(saved).toEqual({ entries: ["https://app.test/", "https://app.test/"], index: 1 })
    expect(restoreHistory(redactUrl(currentEntry(history)), saved)).toEqual(saved)
  })
})
