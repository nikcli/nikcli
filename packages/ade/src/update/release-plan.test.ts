import { describe, expect, test } from "bun:test"
import { invalidSubjects, parseSubject, planRelease, releaseNotes, type Commit } from "./release-plan"

let n = 0
const commit = (subject: string, body = ""): Commit => ({ sha: `sha${++n}`, subject, body })

describe("parseSubject", () => {
  test("reads type, scope, breaking mark and description", () => {
    expect(parseSubject("feat(ade): talk to bots")).toEqual({
      type: "feat",
      scope: "ade",
      breaking: false,
      description: "talk to bots",
    })
    expect(parseSubject("fix!: drop the old store")).toEqual({
      type: "fix",
      breaking: true,
      description: "drop the old store",
    })
    expect(parseSubject("perf(ade,voice): idle less")?.scope).toBe("ade,voice")
  })

  test("refuses subjects outside the format", () => {
    expect(parseSubject("Fix the sidebar")).toBeUndefined()
    expect(parseSubject("feature(ade): x")).toBeUndefined()
    expect(parseSubject("feat(ade):no space")).toBeUndefined()
    expect(parseSubject("feat(ADE): upper-case scope")).toBeUndefined()
  })
})

describe("invalidSubjects", () => {
  test("names the offenders and leaves merge commits alone", () => {
    const bad = commit("wip")
    const found = invalidSubjects([commit("fix(ade): ok"), commit("Merge branch 'x' into feat/ade"), bad])
    expect(found).toEqual([{ sha: bad.sha, subject: "wip" }])
  })
})

describe("planRelease", () => {
  test("nothing a user would notice means no release", () => {
    expect(
      planRelease("ade-v0.2.0", [commit("docs(ade): rules"), commit("test(ade): more"), commit("chore: bump")]),
    ).toBeUndefined()
    expect(planRelease("ade-v0.2.0", [])).toBeUndefined()
  })

  test("fix and perf move the patch, feat the minor", () => {
    expect(planRelease("ade-v0.2.0", [commit("fix(ade): a")])?.version).toBe("0.2.1")
    expect(planRelease("ade-v0.2.3", [commit("perf(ade): a")])?.version).toBe("0.2.4")
    expect(planRelease("ade-v0.2.3", [commit("fix(ade): a"), commit("feat(ade): b")])?.version).toBe("0.3.0")
  })

  test("a breaking change moves the major after 1.0 and the minor before it", () => {
    expect(planRelease("ade-v1.4.2", [commit("feat(ade)!: new layout")])?.version).toBe("2.0.0")
    expect(planRelease("ade-v1.4.2", [commit("fix(ade): a", "BREAKING CHANGE: settings reset")])?.version).toBe("2.0.0")
    expect(planRelease("ade-v0.4.2", [commit("feat(ade)!: new layout")])).toMatchObject({
      version: "0.5.0",
      bump: "major",
    })
  })

  test("the skip marker keeps a commit from causing a release", () => {
    expect(planRelease("ade-v0.2.0", [commit("feat(ade): half done [skip release]")])).toBeUndefined()
    expect(planRelease("ade-v0.2.0", [commit("fix(ade): a", "not yet\n\n[skip release]")])).toBeUndefined()
  })

  test("no previous release starts from 0.0.0", () => {
    expect(planRelease(undefined, [commit("feat(ade): first")])?.version).toBe("0.1.0")
  })
})

describe("releaseNotes", () => {
  test("groups what a user notices and leaves out the rest", () => {
    const notes = releaseNotes([
      commit("feat(ade): talk to bots"),
      commit("docs(ade): rules"),
      commit("fix(voice): name the rename shortcut"),
      commit("feat!: new store"),
    ])
    expect(notes).toBe(
      "### Novità\n\n- **ade:** talk to bots\n- new store ⚠️\n\n### Correzioni\n\n- **voice:** name the rename shortcut",
    )
  })
})
