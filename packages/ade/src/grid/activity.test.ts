import { afterEach, describe, expect, test } from "bun:test"
import { resetLocaleForTests } from "../i18n"
import { ACTIVITY_CODES, activityLabel, exitedActivity, isReadyActivity, normalizeActivity } from "./activity"

afterEach(() => resetLocaleForTests("it"))

describe("pane activity", () => {
  test("the Italian sentences earlier builds stored read as their codes", () => {
    expect(normalizeActivity("Disponibile")).toBe("ready")
    expect(normalizeActivity("In esecuzione")).toBe("running")
    expect(normalizeActivity("Sessione ripresa")).toBe("resumed")
    expect(normalizeActivity("Connessione fallita")).toBe("connectFailed")
    expect(normalizeActivity("Uscito con 1")).toBe("exited:1")
    expect(normalizeActivity("Uscito con -1073741510")).toBe("exited:-1073741510")
    expect(normalizeActivity("Uscito con null")).toBe("exited:null")
    expect(exitedActivity(null)).toBe("exited:?")
  })

  test("codes and free text pass through, and normalizing twice changes nothing", () => {
    for (const code of ACTIVITY_CODES) expect(normalizeActivity(code)).toBe(code)
    expect(normalizeActivity("Editing main.ts")).toBe("Editing main.ts")
    expect(normalizeActivity(normalizeActivity("Fatto"))).toBe("done")
    expect(normalizeActivity(undefined)).toBeUndefined()
  })

  test("ready is recognised in either form, and nothing else is", () => {
    expect(isReadyActivity("ready")).toBe(true)
    expect(isReadyActivity("Disponibile")).toBe(true)
    expect(isReadyActivity("running")).toBe(false)
    expect(isReadyActivity(undefined)).toBe(false)
  })

  test("the label follows the language; free text is shown as written", () => {
    expect(activityLabel("ready")).toBe("Disponibile")
    expect(activityLabel(exitedActivity(2))).toBe("Uscito con 2")
    resetLocaleForTests("en")
    expect(activityLabel("ready")).toBe("Ready")
    expect(activityLabel("Disponibile")).toBe("Ready")
    expect(activityLabel("Uscito con 2")).toBe("Exited with 2")
    expect(activityLabel("Editing main.ts")).toBe("Editing main.ts")
    for (const code of ACTIVITY_CODES) expect(activityLabel(code)).not.toBe(code)
  })
})
