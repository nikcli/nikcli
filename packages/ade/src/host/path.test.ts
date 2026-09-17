import { describe, it, expect } from "bun:test"
import { normalizePath, joinPath, basename, dirname, isAbsolutePath, toDisplayPath, pathEquals } from "./path"

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("C:\\Users\\nik\\code")).toBe("C:/Users/nik/code")
  })
  it("strips trailing slash", () => {
    expect(normalizePath("C:/Users/nik/")).toBe("C:/Users/nik")
  })
  it("preserves root C:/", () => {
    expect(normalizePath("C:/")).toBe("C:/")
    expect(normalizePath("C:\\")).toBe("C:/")
  })
  it("preserves unix root", () => {
    expect(normalizePath("/")).toBe("/")
  })
})

describe("joinPath", () => {
  it("joins and normalises", () => {
    expect(joinPath("C:/Users", "nik", "code")).toBe("C:/Users/nik/code")
  })
  it("skips empty parts", () => {
    expect(joinPath("", "a", "", "b")).toBe("a/b")
  })
})

describe("basename", () => {
  it("returns the last segment", () => {
    expect(basename("C:/Users/nik/code")).toBe("code")
    expect(basename("C:\\Users\\nik\\code")).toBe("code")
  })
  it("handles no separator", () => {
    expect(basename("file.txt")).toBe("file.txt")
  })
})

describe("dirname", () => {
  it("returns the parent directory", () => {
    expect(dirname("C:/Users/nik/code")).toBe("C:/Users/nik")
  })
  it("stops at drive root", () => {
    expect(dirname("C:/Users")).toBe("C:/")
  })
  it("returns . for bare filename", () => {
    expect(dirname("file.txt")).toBe(".")
  })
  it("returns / for unix root child", () => {
    expect(dirname("/usr")).toBe("/")
  })
})

describe("isAbsolutePath", () => {
  it("recognises Windows drive paths", () => {
    expect(isAbsolutePath("C:\\")).toBe(true)
    expect(isAbsolutePath("C:/")).toBe(true)
    expect(isAbsolutePath("D:\\folder")).toBe(true)
  })
  it("recognises Unix root", () => {
    expect(isAbsolutePath("/usr/bin")).toBe(true)
  })
  it("recognises UNC paths", () => {
    expect(isAbsolutePath("\\\\server\\share")).toBe(true)
  })
  it("rejects relative paths", () => {
    expect(isAbsolutePath("foo/bar")).toBe(false)
    expect(isAbsolutePath("./foo")).toBe(false)
  })
})

describe("toDisplayPath", () => {
  it("replaces home with ~", () => {
    expect(toDisplayPath("C:/Users/nik/code", "C:/Users/nik")).toBe("~/code")
  })
  it("returns ~ for exact home", () => {
    expect(toDisplayPath("C:\\Users\\nik", "C:/Users/nik")).toBe("~")
  })
  it("leaves unrelated paths untouched", () => {
    expect(toDisplayPath("D:/other", "C:/Users/nik")).toBe("D:/other")
  })
})

describe("pathEquals", () => {
  it("matches despite case and separators", () => {
    expect(pathEquals("C:\\Users\\Nik", "c:/users/nik")).toBe(true)
  })
  it("rejects different paths", () => {
    expect(pathEquals("C:/a", "C:/b")).toBe(false)
  })
})
