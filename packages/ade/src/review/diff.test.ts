import { describe, it, expect } from "bun:test"
import { parseGitHeaderPaths, parseUnifiedDiff, unquotePath } from "./diff"

describe("parseUnifiedDiff", () => {
  it("parses a simple modified file", () => {
    const diffText = `diff --git a/file.txt b/file.txt
index 1234567..890abcd 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line 1
-line 2
+line 2 changed
 line 3`
    const files = parseUnifiedDiff(diffText)
    expect(files.length).toBe(1)
    expect(files[0].path).toBe("file.txt")
    expect(files[0].status).toBe("modified")
    expect(files[0].added).toBe(1)
    expect(files[0].removed).toBe(1)
    expect(files[0].hunks.length).toBe(1)
    expect(files[0].hunks[0].lines.length).toBe(4)
    expect(files[0].hunks[0].lines[2].text).toBe("line 2 changed")
  })

  it("parses added and deleted files", () => {
    const diffText = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1234567..0000000
--- a/old.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye`
    const files = parseUnifiedDiff(diffText)
    expect(files.length).toBe(2)
    expect(files[0].status).toBe("added")
    expect(files[1].status).toBe("deleted")
  })

  it("parses renamed files", () => {
    const diffText = `diff --git a/old_name.txt b/new_name.txt
similarity index 100%
rename from old_name.txt
rename to new_name.txt`
    const files = parseUnifiedDiff(diffText)
    expect(files.length).toBe(1)
    expect(files[0].status).toBe("renamed")
    expect(files[0].oldPath).toBe("old_name.txt")
    expect(files[0].path).toBe("new_name.txt")
  })

  it("parses binary files", () => {
    const diffText = `diff --git a/image.png b/image.png
index 123..456 100644
Binary files a/image.png and b/image.png differ`
    const files = parseUnifiedDiff(diffText)
    expect(files.length).toBe(1)
    expect(files[0].binary).toBe(true)
  })

  it("handles No newline at end of file", () => {
    const diffText = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,2 @@
-foo
\\ No newline at end of file
+foo
+bar
\\ No newline at end of file`
    const files = parseUnifiedDiff(diffText)
    expect(files[0].added).toBe(2)
    expect(files[0].removed).toBe(1)
  })

  /*
   * A removed line is its own text with `-` glued to the front, so removing
   * `-- commento` from a SQL, Lua or Haskell file puts `--- commento` on the
   * wire. The header checks ran first, so the line vanished, `removed` stayed
   * a count short, and every `oldNumber` after it slipped by one — the review
   * then pointed at the wrong lines of the right file.
   */
  it("does not mistake a removed comment for a file header", () => {
    const diffText = `diff --git a/schema.sql b/schema.sql
--- a/schema.sql
+++ b/schema.sql
@@ -1,4 +1,4 @@
 CREATE TABLE t (
-- vecchio commento
+++ nuovo, con tre più
 );
`
    const files = parseUnifiedDiff(diffText)
    expect(files[0].removed).toBe(1)
    expect(files[0].added).toBe(1)

    const lines = files[0].hunks[0].lines
    expect(lines.map((l) => l.kind)).toEqual(["context", "remove", "add", "context"])
    expect(lines[1].text).toBe("- vecchio commento")
    expect(lines[2].text).toBe("++ nuovo, con tre più")
    // The numbering after the removal is the thing that actually broke.
    expect(lines[3].oldNumber).toBe(3)
  })

  it("keeps a path that contains spaces whole", () => {
    const diffText = `diff --git a/src/my file.ts b/src/my file.ts
--- a/src/my file.ts
+++ b/src/my file.ts
@@ -1,1 +1,1 @@
-a
+b`
    expect(parseUnifiedDiff(diffText)[0].path).toBe("src/my file.ts")
  })

  it("a rename to a path with spaces keeps both names", () => {
    const diffText = `diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt`
    const files = parseUnifiedDiff(diffText)
    expect(files[0].oldPath).toBe("old name.txt")
    expect(files[0].path).toBe("new name.txt")
  })

  /*
   * Git writes a trailing newline, so `split("\n")` leaves a final empty
   * string that is not a line of anything. It was appended to the last hunk
   * as an empty context line with invented numbers.
   */
  it("a trailing newline does not invent a line", () => {
    const withNewline = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 a
-b
+c
`
    const files = parseUnifiedDiff(withNewline)
    expect(files[0].hunks[0].lines).toHaveLength(3)
    expect(files[0].hunks[0].lines.map((l) => l.kind)).toEqual(["context", "remove", "add"])
  })

  it("a deleted file is still named, having no +++ to read", () => {
    const diffText = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye`
    const files = parseUnifiedDiff(diffText)
    expect(files[0].status).toBe("deleted")
    expect(files[0].path).toBe("gone.txt")
  })
})

describe("unquotePath", () => {
  it("leaves an ordinary path alone", () => {
    expect(unquotePath("src/a.ts")).toBe("src/a.ts")
    expect(unquotePath("src/my file.ts")).toBe("src/my file.ts")
  })

  /*
   * `core.quotePath` is on by default and escapes UTF-8 *bytes* in octal, so
   * the bytes have to be decoded together: one at a time gives two mojibake
   * characters where there should be one accented letter.
   */
  it("decodes octal escapes as UTF-8, not as separate characters", () => {
    expect(unquotePath('"citt\\303\\240.ts"')).toBe("città.ts")
    expect(unquotePath('"src/\\303\\250.ts"')).toBe("src/è.ts")
  })

  it("handles the named escapes alongside them", () => {
    expect(unquotePath('"a\\"b.ts"')).toBe('a"b.ts')
    expect(unquotePath('"a\\\\b.ts"')).toBe("a\\b.ts")
  })
})

describe("parseGitHeaderPaths", () => {
  it("splits the ordinary case", () => {
    expect(parseGitHeaderPaths("diff --git a/src/a.ts b/src/a.ts")).toEqual({
      aPath: "src/a.ts",
      bPath: "src/a.ts",
    })
  })

  it("splits a path containing a space", () => {
    expect(parseGitHeaderPaths("diff --git a/my file.ts b/my file.ts")).toEqual({
      aPath: "my file.ts",
      bPath: "my file.ts",
    })
  })

  /*
   * The nastiest shape: a directory literally called `b`, so " b/" occurs
   * more than once and the naive split picks the wrong one.
   */
  it("splits when the path itself contains a directory named b", () => {
    expect(parseGitHeaderPaths("diff --git a/x b/y.ts b/x b/y.ts")).toEqual({
      aPath: "x b/y.ts",
      bPath: "x b/y.ts",
    })
  })

  it("splits a quoted path", () => {
    expect(parseGitHeaderPaths('diff --git "a/citt\\303\\240.ts" "b/citt\\303\\240.ts"')).toEqual({
      aPath: "città.ts",
      bPath: "città.ts",
    })
  })
})
