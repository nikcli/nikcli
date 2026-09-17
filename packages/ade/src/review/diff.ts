export interface FileDiff {
  path: string
  oldPath?: string
  status: "added" | "modified" | "deleted" | "renamed"
  added: number
  removed: number
  binary: boolean
  hunks: Hunk[]
}

export interface Hunk {
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface DiffLine {
  kind: "context" | "add" | "remove"
  text: string
  oldNumber?: number
  newNumber?: number
}

/**
 * Undoes `core.quotePath`, which is on by default.
 *
 * Git wraps a path in double quotes as soon as it contains a byte outside
 * printable ASCII, and escapes those bytes as three-digit octal — so
 * `città.ts` arrives as `"citt\303\240.ts"`. The octal is UTF-8 *bytes*, not
 * code points, so they are collected and decoded together; decoding them one
 * at a time produces two mojibake characters instead of one accented letter.
 *
 * An unquoted path is returned untouched, which is the common case.
 */
export function unquotePath(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed

  const body = trimmed.slice(1, -1)
  const bytes: number[] = []
  const decoder = new TextDecoder()
  let out = ""

  const flush = () => {
    if (bytes.length === 0) return
    out += decoder.decode(new Uint8Array(bytes))
    bytes.length = 0
  }

  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "\\") {
      flush()
      out += body[i]
      continue
    }

    const next = body[i + 1]
    const octal = body.slice(i + 1, i + 4)
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8))
      i += 3
      continue
    }

    flush()
    // The named escapes git emits alongside the octal ones.
    const SIMPLE: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" }
    out += SIMPLE[next] ?? next ?? ""
    i += 1
  }

  flush()
  return out
}

/** Strips the `a/` or `b/` git puts in front of a path in its headers. */
function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "")
}

/**
 * The two paths on a `diff --git` line.
 *
 * Splitting on spaces is what this used to do, and a path with a space in it
 * came back cut in half — `dir/my file.ts` parsed as `dir/my`, which matches
 * no row in the file list. Git does not quote a space (only bytes outside
 * printable ASCII), so the separator has to be found rather than assumed:
 * the remainder is `a/<x> b/<y>`, and the split is the ` b/` that leaves a
 * well-formed `a/` path in front of it.
 *
 * Best-effort by design. It is the fallback: `--- ` and `+++ ` each carry one
 * path on a line of their own, with nothing to disambiguate, and those
 * overwrite whatever this returns.
 */
export function parseGitHeaderPaths(line: string): { aPath: string; bPath: string } {
  const rest = line.slice("diff --git ".length)

  // Quoted: the first path ends at its closing quote, so there is no ambiguity.
  if (rest.startsWith('"')) {
    const end = findClosingQuote(rest)
    if (end > 0) {
      return {
        aPath: stripPrefix(unquotePath(rest.slice(0, end + 1))),
        bPath: stripPrefix(unquotePath(rest.slice(end + 1))),
      }
    }
  }

  const candidates: number[] = []
  for (let at = rest.indexOf(" b/"); at !== -1; at = rest.indexOf(" b/", at + 1)) {
    if (rest.startsWith("a/", 0) && at > 1) candidates.push(at)
  }

  // Same path on both sides is the overwhelmingly common case, so a split that
  // makes the halves equal is almost certainly the right one.
  const equal = candidates.find((at) => rest.slice(2, at) === rest.slice(at + 3))
  const at = equal ?? candidates[candidates.length - 1]
  if (at === undefined) return { aPath: "", bPath: "" }

  return {
    aPath: unquotePath(rest.slice(0, at)).replace(/^a\//, ""),
    bPath: unquotePath(rest.slice(at + 1)).replace(/^b\//, ""),
  }
}

/** Index of the quote that closes the one at position 0, or -1. */
function findClosingQuote(text: string): number {
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1
      continue
    }
    if (text[i] === '"') return i
  }
  return -1
}

/**
 * True when a line inside an open hunk is part of that hunk's content.
 *
 * This exists because the header checks used to run first, and a *removed*
 * line is its content with `-` glued to the front: remove `-- commento` from
 * a SQL, Lua or Haskell file and the line on the wire is `--- commento`,
 * which the parser read as a file header. The line vanished, `removed`
 * stayed a count short, and every `oldNumber` after it in the hunk was off by
 * one — so the review pointed at the wrong lines of the right file.
 */
function isHunkContent(line: string): boolean {
  return (
    line.startsWith("+") ||
    line.startsWith("-") ||
    line.startsWith(" ") ||
    line === "" ||
    line.startsWith("\\ No newline at end of file")
  )
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let currentFile: FileDiff | null = null
  let currentHunk: Hunk | null = null
  let oldLineCounter = 0
  let newLineCounter = 0

  /*
   * Carriage returns are stripped before anything else. Git on Windows hands
   * back CRLF, and a trailing \r turns every parsed path into a string that
   * matches nothing — the file list renders, and clicking a row selects a file
   * that, as far as every comparison is concerned, does not exist.
   */
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))

  /*
   * A diff that ends with a newline — every diff git writes — splits into a
   * final empty string that is not a line of anything. It was read as an
   * empty context line and appended to the last hunk with invented old and
   * new numbers, so every file's last hunk claimed one line more than the
   * file had.
   */
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith("diff --git")) {
      currentFile = {
        path: "",
        status: "modified",
        added: 0,
        removed: 0,
        binary: false,
        hunks: [],
      }
      files.push(currentFile)
      currentHunk = null

      // Provisional: `--- ` and `+++ ` below carry one path each on a line of
      // their own and overwrite these, which is the only unambiguous reading.
      const { aPath, bPath } = parseGitHeaderPaths(line)
      currentFile.path = bPath || aPath

      // Check extended headers for rename and status
      let j = i + 1
      while (
        j < lines.length &&
        !lines[j].startsWith("--- ") &&
        !lines[j].startsWith("diff --git") &&
        !lines[j].startsWith("Binary files")
      ) {
        const extLine = lines[j]
        if (extLine.startsWith("new file mode")) {
          currentFile.status = "added"
        } else if (extLine.startsWith("deleted file mode")) {
          currentFile.status = "deleted"
        } else if (extLine.startsWith("rename from ")) {
          currentFile.status = "renamed"
          currentFile.oldPath = unquotePath(extLine.slice(12))
        } else if (extLine.startsWith("rename to ")) {
          currentFile.path = unquotePath(extLine.slice(10))
        }
        j++
      }
      // Leave i at the end of the extended headers so the next iteration will process '---' or 'Binary files'
      i = j - 1
    } else if (line.startsWith("@@ ") && currentFile) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLineCounter = parseInt(match[1], 10)
        newLineCounter = parseInt(match[2], 10)
        currentHunk = {
          header: line,
          oldStart: oldLineCounter,
          newStart: newLineCounter,
          lines: [],
        }
        currentFile.hunks.push(currentHunk)
      }
    } else if (currentHunk && isHunkContent(line)) {
      /*
       * Content before headers, deliberately. Inside an open hunk a line
       * beginning `--- ` or `+++ ` can only be a removed or added line whose
       * own text starts with `--` or `++` — a comment in SQL, Lua or Haskell.
       * A new file's real headers always arrive after a `diff --git`, which
       * closes the hunk above.
       */
      if (line.startsWith("\\ No newline at end of file")) {
        // Just ignore
      } else if (line.startsWith("+")) {
        currentHunk.lines.push({
          kind: "add",
          text: line.slice(1),
          newNumber: newLineCounter++,
        })
        currentFile!.added++
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({
          kind: "remove",
          text: line.slice(1),
          oldNumber: oldLineCounter++,
        })
        currentFile!.removed++
      } else if (line.startsWith(" ") || line === "") {
        const text = line.length > 0 ? line.slice(1) : line
        currentHunk.lines.push({
          kind: "context",
          text: text,
          oldNumber: oldLineCounter++,
          newNumber: newLineCounter++,
        })
      }
    } else if (line.startsWith("--- ") && currentFile) {
      if (line === "--- /dev/null") {
        currentFile.status = "added"
      } else if (!currentFile.path) {
        // A deletion has no `+++ b/…` to read, so this is the only name.
        currentFile.path = stripPrefix(unquotePath(line.slice(4)))
      }
    } else if (line.startsWith("+++ ") && currentFile) {
      if (line === "+++ /dev/null") {
        currentFile.status = "deleted"
      } else {
        /*
         * The authoritative name. One path, the whole rest of the line, with
         * no second path to disambiguate it — so unlike the `diff --git`
         * line this is right even when the path contains spaces.
         *
         * Not applied to a rename, where the extended header already named
         * the destination and this would only repeat it.
         */
        if (currentFile.status !== "renamed") {
          currentFile.path = stripPrefix(unquotePath(line.slice(4)))
        }
      }
    } else if (line.startsWith("Binary files") && currentFile) {
      currentFile.binary = true
    } else if (currentHunk) {
      // Anything else ends the hunk: it is neither content nor a header this
      // parser knows, so continuing to number lines against it would be guessing.
      currentHunk = null
    }

    i++
  }

  return files
}
