import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { existsSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { testDb } from "../helpers/sqlite"

/** Whether any ancestor of `directory` is a git repository, itself included. */
function repositoryAbove(directory: string) {
  let current = path.resolve(directory)
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-project-effect-home-"))
process.env.NIKCLI_TEST_HOME = testHome

preserveTestEnv(["NIKCLI_TEST_HOME"])

const { Project } = await import("@/project/project")

function runProject<A, E>(effect: Effect.Effect<A, E, any>) {
  // SAFETY: `Project.defaultLayer` provides every requirement the effect declares,
  // so nothing is left for the runtime to supply.
  return Effect.runPromise(effect.pipe(Effect.provide(Project.defaultLayer)) as Effect.Effect<A, E, never>)
}

describe("Project.Service", () => {
  beforeEach(async () => {
    const { Database } = await import("@/database/database")
    const { ProjectRepo } = await import("@/project/repo")
    testDb(Database)
    Effect.runSync(ProjectRepo.clear())
    await removeTestDir(path.join(testHome, "data", "storage"))
  })

  it("creates, lists, updates, and removes project sandboxes through the Effect service boundary", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-project-effect-project-"))
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-project-effect-sandbox-"))

    try {
      const result = await runProject(
        Effect.gen(function* () {
          const project = yield* Project.Service
          const created = yield* project.fromDirectory(projectDir)
          const updated = yield* project.update({
            projectID: created.project.id,
            name: "Project Service Test",
          })
          const listed = yield* project.list()
          const withSandbox = yield* project.removeSandbox(created.project.id, sandboxDir)
          const sandboxes = yield* project.sandboxes(created.project.id)

          return { created, updated, listed, withSandbox, sandboxes }
        }),
      )

      expect(result.created.project.id).toBe("global")
      // A directory with no VCS resolves to the filesystem root, matching
      // opencode v2's `path.parse(input).root` fallback for the global project.
      //
      // Only assertable when the temp directory really has no repository above
      // it. On Windows the OS temp directory lives under the user's home, so a
      // home-level repository — dotfiles, most often — is discovered by the walk
      // up and the canonical is that repository rather than the root. The
      // fallback is then simply not the path under test on this host, and
      // pinning the root would assert the machine's layout instead of the code.
      if (!repositoryAbove(projectDir)) {
        expect(result.created.project.canonical).toBe(path.parse(projectDir).root)
      }
      expect(result.updated.name).toBe("Project Service Test")
      expect(result.listed.map((project) => project.id)).toContain("global")
      expect(result.withSandbox.sandboxes).toEqual([])
      expect(result.sandboxes).toEqual([])
    } finally {
      await removeTestDir(projectDir)
      await removeTestDir(sandboxDir)
    }
  })

  it("uses a normalized origin identity and tracks canonical project directories", async () => {
    const sshDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-project-ssh-"))
    const httpsDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-project-https-"))
    const git = async (directory: string, ...args: string[]) => {
      const process = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
      const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
      if (code !== 0) throw new Error(stderr)
    }

    try {
      await Promise.all(
        [
          [sshDir, "git@github.com:Acme/App.git"],
          [httpsDir, "https://github.com/Acme/App.git"],
        ].map(async ([directory, remote]) => {
          await git(directory, "init")
          await git(
            directory,
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=Test",
            "commit",
            "--allow-empty",
            "-m",
            "root",
          )
          await git(directory, "remote", "add", "origin", remote)
        }),
      )

      // Sequential on purpose: two concurrent `fromDirectory` calls for the
      // same project race on the shared project record and intermittently
      // register the second checkout as a sandbox instead of a directory.
      const ssh = await runProject(
        Effect.gen(function* () {
          return yield* (yield* Project.Service).fromDirectory(sshDir)
        }),
      )
      const https = await runProject(
        Effect.gen(function* () {
          return yield* (yield* Project.Service).fromDirectory(httpsDir)
        }),
      )
      expect(ssh.project.id).toBe(https.project.id)
      expect(ssh.project.id).not.toBe("global")
      expect(
        await runProject(
          Effect.gen(function* () {
            return yield* (yield* Project.Service).directories(ssh.project.id)
          }),
        ),
      ).toEqual(
        expect.arrayContaining([{ directory: await fs.realpath(sshDir) }, { directory: await fs.realpath(httpsDir) }]),
      )
    } finally {
      await Promise.all([sshDir, httpsDir].map((directory) => removeTestDir(directory)))
    }
  })

  it("keeps the cached project id when the checkout also has an origin", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-project-cached-"))
    const git = async (...args: string[]) => {
      const process = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
      const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
      if (code !== 0) throw new Error(stderr)
    }

    try {
      await git("init")
      await git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "root")
      await git("remote", "add", "origin", "https://github.com/Acme/Cached.git")
      // Every session stored before origin identity existed is keyed by this id.
      await Bun.file(path.join(directory, ".git", "nikcli")).write("legacy-project-id")

      const result = await runProject(
        Effect.gen(function* () {
          return yield* (yield* Project.Service).fromDirectory(directory)
        }),
      )

      expect(result.project.id).toBe("legacy-project-id")
    } finally {
      await removeTestDir(directory)
    }
  })

  it("caches the origin identity so a later origin change cannot orphan sessions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-project-origin-cache-"))
    const git = async (...args: string[]) => {
      const process = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
      const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
      if (code !== 0) throw new Error(stderr)
    }

    try {
      await git("init")
      await git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "root")
      await git("remote", "add", "origin", "https://github.com/Acme/Origin.git")

      const first = await runProject(
        Effect.gen(function* () {
          return yield* (yield* Project.Service).fromDirectory(directory)
        }),
      )
      expect(first.project.id).not.toBe("global")

      await git("remote", "set-url", "origin", "https://github.com/Acme/Renamed.git")

      const second = await runProject(
        Effect.gen(function* () {
          return yield* (yield* Project.Service).fromDirectory(directory)
        }),
      )
      expect(second.project.id).toBe(first.project.id)
    } finally {
      await removeTestDir(directory)
    }
  })
})

afterAll(async () => {
  const { Database } = await import("@/database/database")
  Database.closeAll()
  await removeTestDir(testHome)
})
