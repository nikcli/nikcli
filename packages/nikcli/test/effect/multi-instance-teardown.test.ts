import { describe, expect, it } from "bun:test";
import { Cause, Effect, Exit, Fiber } from "effect";
import { InstanceScope } from "@/effect/instance-scope";
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref";
import { Instance } from "@/project/instance";
import {
  increment as lifecycleIncrement,
  reset,
  snapshot,
} from "@/effect/lifecycle-counters";
import { barrier, deferred } from "../helpers/barrier";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-eot02-"));
  const db = path.join(home, "nikcli.db");
  const previousHome = process.env.NIKCLI_TEST_HOME;
  const previousDb = process.env.NIKCLI_DB;
  const previousConfig = process.env.NIKCLI_DISABLE_PROJECT_CONFIG;
  process.env.NIKCLI_TEST_HOME = home;
  process.env.NIKCLI_DB = db;
  process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1";
  reset();
  try {
    return await fn(await fs.realpath(home));
  } finally {
    await Instance.disposeAll().catch(() => undefined);
    if (previousHome === undefined) delete process.env.NIKCLI_TEST_HOME;
    else process.env.NIKCLI_TEST_HOME = previousHome;
    if (previousDb === undefined) delete process.env.NIKCLI_DB;
    else process.env.NIKCLI_DB = previousDb;
    if (previousConfig === undefined)
      delete process.env.NIKCLI_DISABLE_PROJECT_CONFIG;
    else process.env.NIKCLI_DISABLE_PROJECT_CONFIG = previousConfig;
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe("EOT-02 multi-instance teardown", () => {
  it("two scopes on one directory settle independently and each bumps counters", async () => {
    await withTempHome(async (directory) => {
      const a = Effect.runPromise(
        InstanceScope.with({ directory }, Effect.succeed("a")),
      );
      const b = Effect.runPromise(
        InstanceScope.with({ directory }, Effect.succeed("b")),
      );
      const [av, bv] = await Promise.all([a, b]);
      expect(av).toBe("a");
      expect(bv).toBe("b");
      const snap = snapshot();
      expect(snap["scope.created"]).toBeGreaterThanOrEqual(2);
      expect(snap["scope.completed"]).toBeGreaterThanOrEqual(2);
      expect(snap["scope.interrupted"]).toBe(0);
    });
  });

  for (const sameDirectory of [true, false]) {
    it(`waits for owned finalizers without cancelling the peer (${sameDirectory ? "shared" : "distinct"} directory)`, async () => {
      await withTempHome(async (home) => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const other = path.join(home, "other");
        await fs.mkdir(other);
        const ready = barrier(2);
        const finalizing = barrier();
        const release = deferred();
        const finishPeer = deferred();
        const released: string[] = [];
        const contexts: {
          owner: string;
          directory: string;
          workspace: string | undefined;
          legacy: string;
        }[] = [];
        const before = snapshot();
        const start = (owner: string, directory: string) =>
          Effect.runFork(
            InstanceScope.with(
              { directory, workspaceID: owner },
              Effect.scoped(
                Effect.gen(function* () {
                  yield* Effect.acquireRelease(
                    Effect.succeed(owner),
                    (resource) =>
                      Effect.gen(function* () {
                        const instance = yield* InstanceRef;
                        const workspace = yield* WorkspaceRef;
                        contexts.push({
                          owner: resource,
                          directory: instance.directory,
                          workspace: workspace.id,
                          legacy: Instance.directory,
                        });
                        if (resource === "a") {
                          finalizing.arrive();
                          yield* Effect.promise(() => release.promise);
                        }
                        released.push(resource);
                      }),
                  );
                  ready.arrive();
                  if (owner === "a") return yield* Effect.never;
                  yield* Effect.promise(() => finishPeer.promise);
                  return owner;
                }),
              ),
            ),
          );
        const a = start("a", home);
        const b = start("b", sameDirectory ? home : other);
        let settled = false;
        try {
          await ready.wait();
          const interrupted = Effect.runPromise(Fiber.interrupt(a)).then(() => {
            settled = true;
          });
          await finalizing.wait();
          expect(settled).toBe(false);
          expect(released).toEqual([]);
          finishPeer.resolve();
          expect(await Effect.runPromise(Fiber.await(b))).toEqual(
            Exit.succeed("b"),
          );
          expect(released).toEqual(["b"]);
          expect(settled).toBe(false);
          release.resolve();
          await interrupted;
          const exit = await Effect.runPromise(Fiber.await(a));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          expect(released).toEqual(["b", "a"]);
          expect(contexts).toEqual([
            { owner: "a", directory: home, workspace: "a", legacy: home },
            {
              owner: "b",
              directory: sameDirectory ? home : other,
              workspace: "b",
              legacy: sameDirectory ? home : other,
            },
          ]);
          const after = snapshot();
          expect(after["scope.created"] - before["scope.created"]).toBe(2);
          expect(after["scope.completed"] - before["scope.completed"]).toBe(1);
          expect(after["scope.interrupted"] - before["scope.interrupted"]).toBe(
            1,
          );
        } finally {
          release.resolve();
          finishPeer.resolve();
          await Promise.all([
            Effect.runPromise(Fiber.interrupt(a)),
            Effect.runPromise(Fiber.interrupt(b)),
          ]);
        }
        expect(released).toEqual(["b", "a"]);
      });
    });
  }

  it("lifecycle counter increments are observable from outside the scope", () => {
    const before = snapshot();
    lifecycleIncrement("runtime.bridge.success", 5);
    const after = snapshot();
    expect(
      after["runtime.bridge.success"] - before["runtime.bridge.success"],
    ).toBe(5);
  });
});
