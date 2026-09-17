/**
 * The smoke, which is not smoke: it is lines of code with their letters
 * rearranged.
 *
 * Close enough to read as code — the punctuation, the indentation and the
 * shape of a statement all survive — and never actually readable, which is
 * the joke. A real line would invite the reader to parse it while the app is
 * loading; a random string of glyphs would look like noise. An anagram sits
 * exactly between the two.
 *
 * Deterministic, because the splash has to look the same twice. A seeded
 * generator also means the tests can assert the output rather than assert
 * that something changed.
 */

/**
 * The lines the smoke is made from.
 *
 * ADE's own, roughly: what the user would see if they opened the file behind
 * the window they are waiting for.
 */
export const CODE_LINES: readonly string[] = [
  "const session = await host.spawn({ command, cwd })",
  "export function quantize(value, x, y, levels = 2)",
  "if (!pane.task?.trim()) return { kind: 'fresh' }",
  "for (const line of lineStream.push(chunk)) onLine(line)",
  "registry.register('video', { verbs, run })",
  "await ready_rx.recv_timeout(READY_TIMEOUT)",
  "setWbStore(produce((w) => w.panes.push(pane)))",
  "match reader.read(&mut buffer) { Ok(0) => break,",
  "type AdeView = 'agent' | 'code' | 'chat' | 'bot'",
  "onCleanup(() => query.removeEventListener('change', on))",
  "impl Drop for Server { fn drop(&mut self) {",
  "const plan = planResume({ agentId, resumeId })",
  "@ade video seek 1:03",
  "git worktree add -b ade/session ../tree HEAD",
  "let mut slot = self.lock(); *slot = Slot::Starting",
]

/**
 * A small, fast, seedable generator.
 *
 * `Math.random` cannot be seeded, and the splash has to be reproducible: two
 * launches that scramble the same line differently would be a detail nobody
 * asked for and a test nobody can write.
 */
export function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** True for the characters that carry the *shape* of a line of code. */
function isStructure(character: string): boolean {
  return !/[A-Za-z0-9]/.test(character)
}

/**
 * Rearranges the letters of a line, leaving its structure where it was.
 *
 * Punctuation, spaces and brackets stay at their own indices; only the
 * alphanumerics move, and they move among themselves. That is what keeps the
 * result looking like code: `const session = await host.spawn({ command })`
 * still has its `=`, its dot, its braces and its word boundaries, and every
 * word in it is now nonsense.
 *
 * A Fisher–Yates shuffle drawing from `next`, so the same seed gives the same
 * line every time.
 */
export function anagramLine(line: string, seed: number): string {
  /*
   * Code points, not UTF-16 units and not grapheme clusters.
   *
   * `split("")` would cut an accented character in half and leave a
   * replacement glyph drifting in the smoke. `Intl.Segmenter` — what the lint
   * rule suggests — would be right for text a human wrote, and wrong here:
   * these are lines of source, where a combining mark is vanishingly rare and
   * a per-character shuffle is the whole effect.
   */
  // oxlint-disable-next-line no-misused-spread
  const characters = [...line]
  const movable: number[] = []
  for (let index = 0; index < characters.length; index++) {
    if (!isStructure(characters[index] ?? "")) movable.push(index)
  }

  const next = rng(seed)
  // Fisher–Yates over the movable positions, swapping the characters at them.
  for (let i = movable.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const a = movable[i]
    const b = movable[j]
    const held = characters[a]
    characters[a] = characters[b]
    characters[b] = held
  }
  return characters.join("")
}

/**
 * How long a puff is, in characters.
 *
 * A fragment, not a line. A whole line of source is around fifty characters,
 * which at the size the scene draws text covers about three quarters of its
 * width — six of those overlapping made a solid band across the picture with
 * the subject behind it, which is the opposite of smoke. Short pieces drift
 * apart instead of merging, and they still read as code because the anagram
 * is taken over the whole line first and only then cut.
 */
export const SMOKE_MIN = 10
export const SMOKE_MAX = 20

/**
 * The fragment a puff of smoke carries.
 *
 * Indexed rather than random so consecutive puffs are different lines: with
 * a draw from the whole list every few frames, the same line came up twice in
 * a row often enough to read as a bug. Where the cut falls is seeded too, so
 * two puffs from the same line are not the same piece of it.
 */
export function smokeLine(index: number, seed: number): string {
  const wrapped = ((index % CODE_LINES.length) + CODE_LINES.length) % CODE_LINES.length
  const source = CODE_LINES[wrapped] ?? ""
  const scrambled = anagramLine(source, seed)

  // Seeded off the wrapped index, not the raw one, so asking for line 3 and
  // for line 3 + a lap round the list gives the same puff rather than the
  // same words cut in a different place.
  const next = rng(seed * 31 + wrapped)
  const length = SMOKE_MIN + Math.floor(next() * (SMOKE_MAX - SMOKE_MIN + 1))
  if (scrambled.length <= length) return scrambled.trim()
  const start = Math.floor(next() * (scrambled.length - length + 1))
  // Trimmed, because a cut that lands on a space would otherwise give the
  // puff an invisible margin and put it off centre.
  return scrambled.slice(start, start + length).trim()
}
