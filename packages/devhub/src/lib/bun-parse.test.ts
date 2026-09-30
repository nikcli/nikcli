import { expect, test } from "bun:test"
import { parseJunit, parseLine, type Line } from "./bun-parse"

const feed = (text: string) => {
  const run = { results: [], currentFile: "" } as Parameters<typeof parseLine>[0]
  for (const line of text.split("\n")) parseLine(run, { stream: "stderr", line } as Line)
  return run
}

test("parses a real junit report from bun test", async () => {
  const dir = `${import.meta.dir}/../../../httpapi-codegen`
  const out = `${import.meta.dir}/../../../../.devhub/junit-selftest.xml`
  await Bun.$`mkdir -p ${out.replace(/\/[^/]+$/, "")}`
  const proc = Bun.spawn(["bun", "test", "--timeout", "30000", "--reporter=junit", `--reporter-outfile=${out}`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const text = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
  await proc.exited
  const parsed = parseJunit(await Bun.file(out).text())
  const console = feed(text)
  expect(parsed.results.length).toBeGreaterThan(0)
  // bun's own console summary must agree with what we extracted from the junit file
  expect(console.summary?.pass).toBe(parsed.summary.pass)
  expect(console.summary?.total).toBe(parsed.summary.total)
  expect(parsed.results.every((r) => r.file.endsWith(".ts"))).toBe(true)
}, 120_000)

test("junit marks failures and skips", () => {
  const xml = `<testsuites><testsuite name="a.test.ts" file="a.test.ts">
    <testcase name="ok &amp; fine" classname="grp" time="0.002" file="a.test.ts" />
    <testcase name="bad" classname="bad" time="0.5" file="a.test.ts"><failure type="AssertionError" /></testcase>
    <testcase name="later" classname="later" time="0" file="a.test.ts"><skipped /></testcase></testsuite></testsuites>`
  const r = parseJunit(xml)
  expect(r.results.map((x) => [x.name, x.status])).toEqual([
    ["grp › ok & fine", "pass"],
    ["bad", "fail"],
    ["later", "skip"],
  ])
  expect(r.summary).toEqual({ pass: 1, fail: 1, skip: 1, total: 3, files: 1 })
})

test("parses failures, skips and timings", () => {
  const run = feed(
    [
      "test/a.test.ts:",
      "(pass) adds [0.50ms]",
      "(fail) breaks [12.00ms]",
      "(skip) later",
      "",
      " 1 pass",
      " 1 skip",
      " 1 fail",
      "Ran 3 tests across 1 file. [1.20s]",
    ].join("\n"),
  )
  expect(run.results).toEqual([
    { file: "test/a.test.ts", name: "adds", status: "pass", ms: 0.5 },
    { file: "test/a.test.ts", name: "breaks", status: "fail", ms: 12 },
    { file: "test/a.test.ts", name: "later", status: "skip", ms: undefined },
  ])
  expect(run.summary).toEqual({ pass: 1, fail: 1, skip: 1, total: 3, files: 1, ms: 1200 })
})
