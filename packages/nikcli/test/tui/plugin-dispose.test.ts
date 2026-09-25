import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  activatePluginEntry,
  createPluginScope,
  deactivatePluginEntry,
} from "@tui/plugin/runtime";
import type { TuiPlugin, TuiPluginApi } from "@nikcli-ai/plugin/tui";
import { TUI_SRC } from "./tui-source";

/**
 * Dispose order is the whole point of this file.
 *
 * The scope walks its cleanups newest-first, and the host's own
 * deregistrations — the command list, the routes, the event listeners, the
 * plugin host entry — are *in* that queue alongside whatever the plugin
 * registered. Stopping at the first callback that hangs or throws therefore
 * left a disposed plugin still wired into the TUI: its commands in the palette,
 * its routes resolvable, its listeners receiving events.
 */
function scope(timeoutMs: number) {
  return createPluginScope(
    { spec: "test://plugin" } as Parameters<typeof createPluginScope>[0],
    "test",
    timeoutMs,
  );
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function activation(plugin: TuiPlugin) {
  const commands = new Set<unknown>();
  let registrations = 0;
  const state = {
    api: {
      command: {
        register(cb: unknown) {
          registrations++;
          commands.add(cb);
          return () => {
            commands.delete(cb);
          };
        },
      },
      theme: {},
    },
    slots: {},
  } as Parameters<typeof activatePluginEntry>[0];
  const entry = {
    id: "test",
    load: { spec: "test://plugin" },
    meta: {},
    plugin,
    enabled: true,
  } as Parameters<typeof activatePluginEntry>[1];
  return { state, entry, commands, registrations: () => registrations };
}

describe("plugin activation ownership", () => {
  test.each([false, true])(
    "late activation cannot replace a newer generation (reject=%s)",
    async (reject) => {
      const entered = barrier();
      const resume = barrier();
      const apis: TuiPluginApi[] = [];
      const h = activation(async (api) => {
        apis.push(api);
        api.command.register(() => []);
        if (apis.length !== 1) return;
        entered.release();
        await resume.promise;
        if (reject) throw new Error("late setup failure");
      });
      const old = activatePluginEntry(h.state, h.entry, false);
      await entered.promise;
      try {
        await deactivatePluginEntry(h.state, h.entry, false);
        expect(apis[0].lifecycle.signal.aborted).toBe(true);
        expect(h.commands.size).toBe(0);
        await activatePluginEntry(h.state, h.entry, false);
        const current = h.entry.scope;
        resume.release();
        await old;
        expect(h.entry.scope).toBe(current);
        expect(apis[1].lifecycle.signal.aborted).toBe(false);
        expect(() => apis[0].command.register(() => [])).toThrow();
        expect(h.registrations()).toBe(2);
        expect(h.commands.size).toBe(1);
      } finally {
        resume.release();
        await old;
        await deactivatePluginEntry(h.state, h.entry, false);
      }
      expect(h.commands.size).toBe(0);
    },
  );

  test("concurrent activation shares setup and its failure result", async () => {
    const entered = barrier();
    const resume = barrier();
    let calls = 0;
    const h = activation(async (api) => {
      calls++;
      api.command.register(() => []);
      entered.release();
      await resume.promise;
      throw new Error("setup failure");
    });
    const first = activatePluginEntry(h.state, h.entry, false);
    await entered.promise;
    const second = activatePluginEntry(h.state, h.entry, false);
    resume.release();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(calls).toBe(1);
    expect(h.entry.scope).toBeUndefined();
    expect(h.commands.size).toBe(0);
  });
});

describe("plugin scope dispose", () => {
  test("host registrations are revoked before waiting on plugin cleanup", async () => {
    const s = scope(500);
    const entered = barrier();
    const resume = barrier();
    let active = true;
    s.track(() => {
      active = false;
    });
    s.lifecycle.onDispose(async () => {
      entered.release();
      await resume.promise;
    });
    const disposing = s.dispose();
    await entered.promise;
    try {
      expect(active).toBe(false);
    } finally {
      resume.release();
      await disposing;
    }
  });

  test("a cleanup continuing after timeout cannot retain a late tracked resource", async () => {
    const s = scope(0);
    const resume = barrier();
    const finished = barrier();
    let active = 0;
    let releases = 0;
    s.lifecycle.onDispose(async () => {
      await resume.promise;
      active++;
      const off = s.track(() => {
        active--;
        releases++;
      });
      off();
      finished.release();
    });
    await s.dispose();
    expect(releases).toBe(0);
    resume.release();
    await finished.promise;
    expect(active).toBe(0);
    expect(releases).toBe(1);
  });

  test("a hung callback does not strand the cleanups queued before it", async () => {
    const ran: string[] = [];
    const s = scope(20);

    // Registered first, so it runs *last*: it is the one a `break` dropped.
    s.lifecycle.onDispose(() => {
      ran.push("host-unregister");
    });
    s.lifecycle.onDispose(() => new Promise<void>(() => {}));

    await s.dispose();
    expect(ran).toEqual(["host-unregister"]);
  });

  test("a throwing callback does not stop the queue either", async () => {
    const ran: string[] = [];
    const s = scope(500);

    s.lifecycle.onDispose(() => {
      ran.push("host-unregister");
    });
    s.lifecycle.onDispose(() => {
      throw new Error("plugin cleanup blew up");
    });

    await s.dispose();
    expect(ran).toEqual(["host-unregister"]);
  });

  test("every remaining cleanup still runs once the budget is spent", async () => {
    const ran: string[] = [];
    const s = scope(10);

    s.lifecycle.onDispose(() => {
      ran.push("a");
    });
    s.lifecycle.onDispose(() => {
      ran.push("b");
    });
    // Two hangs: the first eats the budget, the second gets no wait at all —
    // both must still be *invoked*, and both must still be followed by a and b.
    s.lifecycle.onDispose(() => new Promise<void>(() => {}));
    s.lifecycle.onDispose(() => new Promise<void>(() => {}));

    await s.dispose();
    expect(ran).toEqual(["b", "a"]);
  });

  test("tracked host disposers run in reverse registration order", async () => {
    const ran: string[] = [];
    const s = scope(500);

    s.track(() => ran.push("first"));
    s.track(() => ran.push("second"));

    await s.dispose();
    expect(ran).toEqual(["second", "first"]);
  });

  test("the lifecycle signal is aborted before any cleanup runs", async () => {
    const s = scope(500);
    let abortedDuringCleanup = false;
    s.lifecycle.onDispose(() => {
      abortedDuringCleanup = s.lifecycle.signal.aborted;
    });

    await s.dispose();
    expect(abortedDuringCleanup).toBe(true);
  });

  test("repeated dispose cycles leave no residual owner callbacks", async () => {
    for (let cycle = 0; cycle < 20; cycle++) {
      const ran: string[] = [];
      const s = scope(50);
      s.lifecycle.onDispose(() => {
        ran.push("cleanup");
      });
      await s.dispose();
      expect(ran).toEqual(["cleanup"]);
      expect(s.lifecycle.signal.aborted).toBe(true);
      s.lifecycle.onDispose(() => {
        ran.push("late");
      });
      await s.dispose();
      expect(ran).toEqual(["cleanup"]);
    }
  });

  test("a shared deadline bounds several wedged plugins together, not one budget each", async () => {
    // Shutdown disposes plugins one after another. With only the per-plugin
    // budget, four wedged plugins held exit for four budgets.
    const ran: string[] = [];
    const scopes = Array.from({ length: 4 }, (_, index) => {
      const s = scope(300);
      s.lifecycle.onDispose(() => {
        ran.push(`host-unregister-${index}`);
      });
      s.lifecycle.onDispose(() => new Promise<void>(() => {}));
      return s;
    });

    const started = performance.now();
    const deadline = Date.now() + 150;
    for (const s of scopes) await s.dispose(deadline);
    const elapsed = performance.now() - started;

    // One shared budget plus scheduling slack — far below 4 x 300 ms.
    expect(elapsed).toBeLessThan(600);
    // Spending the budget skips the wait, never the host's deregistrations.
    expect(ran).toEqual([
      "host-unregister-0",
      "host-unregister-1",
      "host-unregister-2",
      "host-unregister-3",
    ]);
  });

  test("a deadline further out than the scope's own budget does not extend it", async () => {
    const s = scope(20);
    s.lifecycle.onDispose(() => new Promise<void>(() => {}));
    const started = performance.now();
    await s.dispose(Date.now() + 60_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("runtime shutdown hands every plugin the same deadline", async () => {
    // Pinned against the source because `TuiPluginRuntime.dispose` needs a live
    // host to reach; the scope behaviour it relies on is covered above.
    const src = await Bun.file(path.join(TUI_SRC, "plugin/runtime.ts")).text();
    const body = src.slice(src.indexOf("export async function dispose()"));
    const deadline = body.indexOf(
      "const deadline = Date.now() + SHUTDOWN_BUDGET_MS",
    );
    const loop = body.indexOf(
      "await deactivatePluginEntry(state, plugin, false, deadline)",
    );
    expect(deadline).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(deadline);
  });
});
