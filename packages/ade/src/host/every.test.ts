import { afterEach, beforeEach, expect, test, jest } from "bun:test"
import { every } from "./every"

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test("ticks on the delay while visible", async () => {
  let count = 0
  const stop = every(100, () => count++, { isHidden: () => false, onVisible: () => () => {} })
  jest.advanceTimersByTime(350)
  await flush()
  stop()
  expect(count).toBeGreaterThanOrEqual(1)
  expect(count).toBeLessThanOrEqual(3)
})

test("pauses while hidden and catches up when shown", async () => {
  let hidden = true
  let show: () => void = () => {}
  let count = 0
  const stop = every(100, () => count++, {
    isHidden: () => hidden,
    onVisible: (listener) => {
      show = listener
      return () => {}
    },
  })
  jest.advanceTimersByTime(1000)
  await flush()
  expect(count).toBe(0)
  hidden = false
  show()
  await flush()
  expect(count).toBe(1)
  stop()
})

test("a slower delay keeps it going while hidden", async () => {
  let count = 0
  const stop = every(100, () => count++, { whenHidden: 1000, isHidden: () => true, onVisible: () => () => {} })
  jest.advanceTimersByTime(900)
  await flush()
  expect(count).toBe(0)
  jest.advanceTimersByTime(200)
  await flush()
  expect(count).toBe(1)
  stop()
})

test("stops for good", async () => {
  let count = 0
  const stop = every(100, () => count++, { isHidden: () => false, onVisible: () => () => {} })
  stop()
  jest.advanceTimersByTime(1000)
  await flush()
  expect(count).toBe(0)
})
