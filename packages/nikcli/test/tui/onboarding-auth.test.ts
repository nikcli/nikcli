import { describe, expect, test } from "bun:test"
import { tuiSource } from "./tui-source"

describe("onboarding account step", () => {
  test("requires the shared web OAuth flow before onboarding can continue", async () => {
    const onboardingSource = await tuiSource("component/dialog-onboarding.tsx")
    const appSource = await tuiSource("app.tsx")
    expect(onboardingSource).toContain("<DialogAccountLogin")
    expect(onboardingSource).toContain("clearOnComplete={false}")
    expect(onboardingSource).not.toContain("UserDB.create(")
    expect(onboardingSource).not.toContain("Create a local account")
    expect(onboardingSource).not.toContain("Skip — I have an account")
    expect(onboardingSource).toMatch(
      /step\(\) !== STEP\.WELCOME\s*&&\s*step\(\) !== STEP\.ACCOUNT\s*&&\s*step\(\) !== STEP\.AI_PROVIDER/,
    )
    // Dismissing the wizard reopens it — onboarding is not skippable — but the
    // retry is bounded now: the old `do/while (!postUser)` was awaited inside
    // `onMount`, so a server that could not provision parked the whole startup
    // continuation behind it.
    expect(appSource).toMatch(/ensureOnboarded\(\{/)
    expect(appSource).toMatch(/runOnboarding:\s*\(\)\s*=>\s*DialogOnboarding\.run\(dialog\)/)
    expect(appSource).toMatch(/currentUser:\s*\(\)\s*=>\s*UserApi\.me\(sdk\)/)
    expect(appSource).not.toMatch(/while\s*\(!postUser\)/)
    // Account dialogs are on the startup path. Lazy-importing them during
    // plugin load flashed the sign-in chooser over "Loading plugins...".
    // Assembled rather than written out, because a string literal holding a
    // whole `import … from "…"` is rewritten by the module transform before
    // the assertion ever runs: the specifier came back as a resolved
    // `file:///…` URL, so the test failed comparing app.tsx against a path.
    // It only surfaced in a full-directory run, which made it read as a flake.
    const staticImport = (name: string, specifier: string) => `import { ${name} } from ` + `"${specifier}"`
    expect(appSource).toContain(staticImport("DialogOnboarding", "@tui/component/dialog-onboarding"))
    expect(appSource).toContain(staticImport("DialogLogin", "@tui/component/dialog-login"))
    expect(appSource).toContain(staticImport("DialogAccountLogin", "@tui/component/dialog-account-login"))
    expect(appSource).not.toMatch(/import\(["']@tui\/component\/dialog-(onboarding|login|account-login)["']\)/)
  })

  test("never records onboarding as complete without an account", async () => {
    const appSource = await tuiSource("app.tsx")
    // The flag is what stops the wizard appearing again, so it may only be set
    // on the branch that has a user. An incomplete run leaves it unset and the
    // next launch asks again.
    const marks = appSource.split('kv.set("onboarding_complete", true)')
    expect(marks.length - 1).toBe(1)
    const before = marks[0]
    expect(before.lastIndexOf('outcome.status === "complete"')).toBeGreaterThan(before.lastIndexOf("ensureOnboarded"))
  })
})
