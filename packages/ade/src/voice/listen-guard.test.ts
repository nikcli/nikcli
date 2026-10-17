import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createListenGuard, pollListenGuard, SLEEP_GAP_MS, LOCK_POLL_MS } from "./listen-guard"

function world() {
  const state = {
    at: 0,
    locked: false,
    hidden: false,
    dictating: false,
    latched: false,
    wanted: true,
    listening: true,
    paused: false,
    halted: false,
    calls: [] as string[],
    locks: 0,
  }
  const guard = createListenGuard({
    now: () => state.at,
    isLocked: async () => {
      state.locks += 1
      return state.locked
    },
    isHidden: () => state.hidden,
    isDictating: () => state.dictating,
    isLatched: () => state.latched,
    shouldListen: () => state.wanted,
    isListening: () => state.listening,
    isPaused: () => state.paused,
    isHalted: () => state.halted,
    pause: async () => {
      state.calls.push("pause")
      state.listening = false
      state.paused = true
    },
    resume: async () => {
      state.calls.push("resume")
      state.listening = true
      state.paused = false
    },
    restart: async () => {
      state.calls.push("restart")
    },
  })
  const tick = async (after = LOCK_POLL_MS) => {
    state.at += after
    await guard.tick()
  }
  return { state, tick }
}

describe("always-on listening and the state of the PC", () => {
  test("pauses when the PC is locked and comes back by itself at the unlock", async () => {
    const { state, tick } = world()
    await tick()
    expect(state.calls).toEqual([])
    state.locked = true
    await tick()
    await tick()
    expect(state.calls).toEqual(["pause"])
    state.locked = false
    await tick()
    expect(state.calls).toEqual(["pause", "resume"])
    expect(state.listening).toBe(true)
  })

  test("after the PC slept, the microphone is opened again", async () => {
    const { state, tick } = world()
    await tick(SLEEP_GAP_MS + 60_000)
    expect(state.calls).toEqual(["restart"])
  })

  test("waking straight into the lock screen pauses, and the unlock resumes", async () => {
    const { state, tick } = world()
    state.locked = true
    await tick(SLEEP_GAP_MS + 60_000)
    state.locked = false
    await tick()
    expect(state.calls).toEqual(["pause", "resume"])
  })

  test("switched off, or closed by hand, it is left alone", async () => {
    const { state, tick } = world()
    state.listening = false
    await tick()
    state.locked = true
    await tick()
    state.locked = false
    await tick()
    expect(state.calls).toEqual([])

    state.wanted = false
    state.paused = true
    await tick()
    expect(state.calls).toEqual([])
  })

  test("a lock check that fails is read as locked", async () => {
    const calls: string[] = []
    const guard = createListenGuard({
      now: () => 0,
      isLocked: () => Promise.reject(new Error("no answer")),
      shouldListen: () => true,
      isListening: () => true,
      isPaused: () => false,
      isHalted: () => false,
      pause: async () => void calls.push("pause"),
      resume: async () => void calls.push("resume"),
      restart: async () => {},
    })
    await guard.tick()
    expect(calls).toEqual(["pause"])
  })

  test("at the lock any open microphone closes, dictation or listening switched off included; nothing reopens it", async () => {
    const { state, tick } = world()
    state.wanted = false
    state.locked = true
    await tick()
    expect(state.calls).toEqual(["pause"])
    state.locked = false
    await tick()
    expect(state.calls).toEqual(["pause"])
  })
})

describe("listening that stopped itself to stop spending", () => {
  test("is not brought back by the guard, at a tick or at an unlock", async () => {
    const { state, tick } = world()
    // The cap on requests, or half an hour with nobody calling it: stopped and held.
    state.halted = true
    state.listening = false
    state.paused = true
    await tick()
    await tick()
    expect(state.calls).toEqual([])

    // A lock and an unlock do not lift it either.
    state.locked = true
    await tick()
    state.locked = false
    await tick()
    expect(state.calls).toEqual([])

    // The user starts it again: the halt is lifted, and the guard goes back to its job.
    state.halted = false
    await tick()
    expect(state.calls).toEqual(["resume"])
  })

  /* G11 review, M1: no microphone open in a window hidden in the tray. */
  test("hidden in the tray, listening closes and stays closed; it comes back with the window", async () => {
    const { state, tick } = world()
    state.hidden = true
    await tick()
    expect(state.calls).toEqual(["pause"])
    expect(state.listening).toBe(false)
    await tick()
    await tick()
    expect(state.calls).toEqual(["pause"])
    state.hidden = false
    await tick()
    expect(state.calls).toEqual(["pause", "resume"])
    expect(state.listening).toBe(true)
  })
})

/*
 * From the tray the system-wide dictation chord is the only way to dictate, and
 * the guard closed what it opened within one tick: pressed, and nothing happened.
 */
describe("a microphone the user opens while ADE is in the tray", () => {
  test("a dictation stays open, tick after tick", async () => {
    const { state, tick } = world()
    state.hidden = true
    state.dictating = true
    await tick()
    await tick()
    expect(state.calls).toEqual([])
    expect(state.listening).toBe(true)
  })

  test("so does one opened with listening switched off", async () => {
    const { state, tick } = world()
    state.hidden = true
    state.wanted = false
    await tick()
    expect(state.calls).toEqual([])
  })

  test("a lock still closes it", async () => {
    const { state, tick } = world()
    state.hidden = true
    state.dictating = true
    state.locked = true
    await tick()
    expect(state.calls).toEqual(["pause"])
  })

  test("the dictation handing back to listening by itself: that closes at the next tick", async () => {
    const { state, tick } = world()
    state.hidden = true
    state.dictating = true
    await tick()
    state.dictating = false
    await tick()
    expect(state.calls).toEqual(["pause"])
  })

  test("a dictation left open by a tap, as a switch, closes: nobody is holding it", async () => {
    const { state, tick } = world()
    state.hidden = true
    state.wanted = false
    state.dictating = true
    state.latched = true
    await tick()
    expect(state.calls).toEqual(["pause"])
  })

  test("the workbench says which microphone is a dictation, and which a tap left open", () => {
    const source = readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8")
    expect(source).toContain('isDictating: () => voiceEngine.activeMode() === "transcription"')
    expect(source).toContain("isLatched: () => voiceEngine.isLatched()")
  })
})

describe("the lock is not asked for nothing", () => {
  test("with the voice off and nothing open, the session is not asked at all", async () => {
    const { state, tick } = world()
    // Switched off by the user, and stopped by itself on top of that.
    state.wanted = false
    state.listening = false
    state.halted = true
    await tick()
    await tick(LOCK_POLL_MS)
    // Even a tick that looks like a wake-up asks nothing: there is no
    // microphone to reopen and nothing the user is waiting for.
    await tick(SLEEP_GAP_MS + 60_000)
    expect(state.locks).toBe(0)
    expect(state.calls).toEqual([])
  })

  test("an open microphone still asks, so a lock closes the dictation", async () => {
    const { state, tick } = world()
    state.wanted = false
    state.listening = true
    await tick()
    expect(state.locks).toBe(1)
    state.locked = true
    await tick()
    expect(state.calls).toEqual(["pause"])
  })

  test("a voice the user wants listening still asks, so the unlock is not missed", async () => {
    const { state, tick } = world()
    state.listening = false
    state.paused = true
    state.locked = true
    await tick()
    expect(state.locks).toBe(1)
    // A lock while it is only paused changes nothing to close.
    expect(state.calls).toEqual([])
    state.locked = false
    await tick()
    expect(state.calls).toEqual(["resume"])
  })
})

describe("the guard in a hidden window", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }

  /** The guard as the workbench builds it, and the calls it makes. */
  function polled(locked: boolean) {
    const calls: string[] = []
    let ticks = 0
    const guard = createListenGuard({
      now: () => Date.now(),
      isLocked: async () => locked,
      shouldListen: () => true,
      isListening: () => true,
      isPaused: () => false,
      isHalted: () => false,
      pause: async () => void calls.push("pause"),
      resume: async () => void calls.push("resume"),
      restart: async () => {},
    })
    return {
      calls,
      ticks: () => ticks,
      stop: pollListenGuard(
        {
          tick: async () => {
            ticks++
            await guard.tick()
          },
        },
        () => true,
        100,
      ),
    }
  }

  test("keeps ticking while hidden, because listening to ADE does not stop when the window does", async () => {
    const { ticks, stop } = polled(false)
    jest.advanceTimersByTime(350)
    await flush()
    stop()
    // With the default of `every` this is zero, and a minimised ADE would never
    // notice the lock.
    expect(ticks()).toBeGreaterThanOrEqual(1)
    expect(ticks()).toBeLessThanOrEqual(3)
  })

  test("a lock on a hidden window closes the microphone", async () => {
    const { calls, stop } = polled(true)
    jest.advanceTimersByTime(250)
    await flush()
    stop()
    expect(calls).toContain("pause")
  })
})
