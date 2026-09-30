export type TestResult = { file: string; name: string; status: "pass" | "fail" | "skip"; ms?: number }
export type Summary = { pass: number; fail: number; skip: number; files?: number; total?: number; ms?: number }
export type Line = { stream: "stdout" | "stderr"; line: string }

type Target = { results: TestResult[]; summary?: Summary; currentFile: string }

// bun prints `path/file.test.ts:` before each file's `(pass) name [1.00ms]` lines
const FILE = /^(\S.*\.(?:test|spec)\.[cm]?[tj]sx?):\s*$/
const CASE = /^\((pass|fail|skip|todo)\)\s+(.*?)(?:\s+\[([\d.]+)(ms|s)\])?\s*$/
const COUNT = /^\s*(\d+)\s+(pass|fail|skip|todo)\s*$/
const RAN = /^Ran (\d+) tests? across (\d+) files?\.(?:\s*\[([\d.]+)(ms|s)\])?/

export function parseLine(run: Target, l: Line) {
  const text = l.line.replace(/\x1b\[[0-9;]*m/g, "")
  const file = FILE.exec(text)
  if (file) return void (run.currentFile = file[1])
  const c = CASE.exec(text)
  if (c) {
    const status = c[1] === "todo" ? "skip" : (c[1] as TestResult["status"])
    const ms = c[3] ? Number(c[3]) * (c[4] === "s" ? 1000 : 1) : undefined
    run.results.push({ file: run.currentFile, name: c[2], status, ms })
    return
  }
  const n = COUNT.exec(text)
  if (n) {
    const s = (run.summary ??= { pass: 0, fail: 0, skip: 0 })
    const key = n[2] === "todo" ? "skip" : (n[2] as "pass" | "fail" | "skip")
    s[key] = Number(n[1])
    return
  }
  const r = RAN.exec(text)
  if (r) {
    const s = (run.summary ??= { pass: 0, fail: 0, skip: 0 })
    s.total = Number(r[1])
    s.files = Number(r[2])
    if (r[3]) s.ms = Number(r[3]) * (r[4] === "s" ? 1000 : 1)
  }
}

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" }
const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);/g, (m, _n, code) =>
    code ? String.fromCharCode(Number(code)) : (ENT[m] ?? m),
  )

function attrs(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of src.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = decode(m[2])
  return out
}

/** Per-test results from bun's `--reporter=junit` file: file, describe path, name, status and timing. */
export function parseJunit(xml: string): { results: TestResult[]; summary: Summary } {
  const results: TestResult[] = []
  for (const m of xml.matchAll(/<testcase\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1])
    const body = m[2] ?? ""
    const status: TestResult["status"] = /<(failure|error)\b/.test(body)
      ? "fail"
      : /<skipped\b/.test(body)
        ? "skip"
        : "pass"
    const name = a.classname && a.classname !== a.name ? `${a.classname} › ${a.name}` : a.name
    results.push({ file: a.file ?? "", name, status, ms: a.time !== undefined ? Number(a.time) * 1000 : undefined })
  }
  const count = (s: TestResult["status"]) => results.filter((r) => r.status === s).length
  return {
    results,
    summary: {
      pass: count("pass"),
      fail: count("fail"),
      skip: count("skip"),
      total: results.length,
      files: new Set(results.map((r) => r.file)).size,
    },
  }
}
