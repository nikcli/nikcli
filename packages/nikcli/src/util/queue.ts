export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: ((value: T) => void)[] = []
  private closed = false

  push(item: T) {
    if (this.closed) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve(item)
    else this.queue.push(item)
  }

  async next(): Promise<T> {
    if (this.closed && this.queue.length === 0) {
      throw new Error("Queue is closed")
    }
    if (this.queue.length > 0) return this.queue.shift()!
    return new Promise((resolve) => this.resolvers.push(resolve))
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      try {
        yield await this.next()
      } catch {
        break
      }
    }
  }

  close() {
    this.closed = true
    // Resolve any pending promises with a sentinel to unblock consumers
    for (const resolve of this.resolvers) {
      resolve(undefined as any)
    }
    this.resolvers = []
  }
}

export async function work<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>) {
  const pending = [...items]
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      // `pending.length` rather than `pop() === undefined`: an `undefined`
      // *item* is indistinguishable from an empty queue, so a worker that met
      // one stopped and everything behind it in that worker's share was
      // silently skipped. Nothing in `src` passes a nullable array today, which
      // is why it never showed — and why the next caller would have inherited
      // it. `workMap` below was never affected: it pops `{item, index}`
      // objects, which are never undefined.
      while (pending.length > 0) {
        await fn(pending.pop() as T)
      }
    }),
  )
}

/**
 * Like `work()` but collects and returns results. Returns results in the
 * same order as the input items array.
 */
export async function workMap<T, R>(concurrency: number, items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = Array.from<R | undefined>({ length: items.length })
  const pending = items.map((item, index) => ({ item, index }))
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const entry = pending.pop()
        if (entry === undefined) return
        results[entry.index] = await fn(entry.item)
      }
    }),
  )
  return results as R[]
}

/**
 * Counting semaphore that caps how many async operations run concurrently.
 * Callers past the limit wait (FIFO) until an in-flight operation releases a
 * permit. Used to bound the number of background agent loops running at once.
 */
export class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return
    }
    // At capacity: wait until a release hands us the freed permit. The active
    // count stays held across the hand-off so the slot is never double-booked.
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
