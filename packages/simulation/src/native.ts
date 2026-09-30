import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";

export interface NativeDevice {
  id: string;
  label: string;
  platform: "ios" | "android";
  state: string;
}

const COMMAND_TIMEOUT = 30_000;
const BOOT_TIMEOUT = 180_000;
const MAX_OUTPUT = 32 * 1024 * 1024;

function aborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

export async function runNativeCommand(
  executable: string,
  args: string[],
  signal?: AbortSignal,
  timeout = COMMAND_TIMEOUT,
): Promise<Uint8Array> {
  aborted(signal);
  if (!executable || !Number.isFinite(timeout) || timeout <= 0)
    throw new Error("Invalid native command");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const cancel = () =>
      stop(new Error("Native command aborted", { cause: signal?.reason }));
    const timer = setTimeout(
      () => stop(new Error(`Native command timed out: ${executable}`)),
      timeout,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const) {
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT)
          return stop(new Error("Native command output exceeded 32 MB"));
        chunks.push(chunk);
      });
    }
    child.once("error", (error) => {
      cleanup();
      reject(
        new Error(`Cannot run ${executable}: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once("close", (code) => {
      cleanup();
      if (failure) return reject(failure);
      if (code !== 0)
        return reject(
          new Error(
            `${executable} exited ${code}: ${Buffer.concat(stderr).toString().trim()}`,
          ),
        );
      resolve(Buffer.concat(stdout));
    });
    if (signal?.aborted) cancel();
  });
}

function text(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes).trim();
}

export function parseIosDevices(output: string): NativeDevice[] {
  const data: unknown = JSON.parse(output);
  if (
    !data ||
    typeof data !== "object" ||
    !("devices" in data) ||
    !data.devices ||
    typeof data.devices !== "object"
  ) {
    throw new Error("Invalid simctl device list");
  }
  const devices: NativeDevice[] = [];
  for (const entries of Object.values(data.devices)) {
    if (!Array.isArray(entries)) throw new Error("Invalid simctl device list");
    for (const entry of entries) {
      if (!entry || entry.isAvailable !== true) continue;
      if (
        typeof entry.udid !== "string" ||
        typeof entry.name !== "string" ||
        typeof entry.state !== "string"
      ) {
        throw new Error("Invalid simctl device entry");
      }
      const device: NativeDevice = {
        id: entry.udid,
        label: entry.name,
        platform: "ios",
        state: entry.state,
      };
      validateDevice(device);
      devices.push(device);
    }
  }
  return devices;
}

export function parseAndroidAvds(output: string): NativeDevice[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ].map((name) => {
    const device: NativeDevice = {
      id: `avd:${name}`,
      label: name,
      platform: "android",
      state: "Shutdown",
    };
    validateDevice(device);
    return device;
  });
}

export function parseAndroidDevices(output: string): NativeDevice[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match =
      /^(emulator-\d+)\s+(device|offline|unauthorized)(?:\s|$)/.exec(
        line.trim(),
      );
    if (!match) return [];
    return [
      {
        id: match[1],
        label: match[1],
        platform: "android" as const,
        state: match[2] === "device" ? "Booted" : match[2],
      },
    ];
  });
}

function validateDevice(device: NativeDevice) {
  if (
    !device ||
    typeof device.label !== "string" ||
    !device.label.trim() ||
    typeof device.state !== "string"
  ) {
    throw new Error("Invalid native device");
  }
  if (
    device.platform === "ios" &&
    /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(device.id)
  )
    return;
  if (
    device.platform === "android" &&
    /^(emulator-\d+|avd:[A-Za-z0-9_.-]+)$/.test(device.id)
  )
    return;
  throw new Error("Invalid native device platform or identifier");
}

async function androidTools() {
  const roots = [
    ...new Set(
      [
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        join(homedir(), "Library/Android/sdk"),
        join(homedir(), "Android/Sdk"),
      ].filter((root): root is string => Boolean(root)),
    ),
  ];
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const root of roots) {
    const adb = join(root, "platform-tools", `adb${suffix}`);
    const emulator = join(root, "emulator", `emulator${suffix}`);
    try {
      await Promise.all([
        access(adb, constants.X_OK),
        access(emulator, constants.X_OK),
      ]);
      return { adb, emulator };
    } catch {}
  }
  throw new Error(
    "Android SDK not found: install platform-tools and emulator, and set ANDROID_HOME or ANDROID_SDK_ROOT",
  );
}

async function androidDevices(
  tools: Awaited<ReturnType<typeof androidTools>>,
  signal?: AbortSignal,
) {
  const [avds, running] = await Promise.all([
    runNativeCommand(tools.emulator, ["-list-avds"], signal)
      .then(text)
      .then(parseAndroidAvds),
    runNativeCommand(tools.adb, ["devices"], signal)
      .then(text)
      .then(parseAndroidDevices),
  ]);
  for (const device of running) {
    if (device.state !== "Booted") continue;
    const name = text(
      await runNativeCommand(
        tools.adb,
        ["-s", device.id, "emu", "avd", "name"],
        signal,
      ),
    ).split(/\r?\n/)[0];
    if (!name || name === "OK" || !/^[A-Za-z0-9_.-]+$/.test(name))
      throw new Error(`Invalid AVD name for ${device.id}`);
    device.label = name;
  }
  return [
    ...running,
    ...avds.filter(
      (avd) => !running.some((device) => device.label === avd.label),
    ),
  ];
}

export async function listNativeDevices(
  signal?: AbortSignal,
): Promise<NativeDevice[]> {
  aborted(signal);
  const results = await Promise.allSettled([
    process.platform === "darwin"
      ? runNativeCommand(
          "xcrun",
          ["simctl", "list", "devices", "available", "--json"],
          signal,
        )
          .then(text)
          .then(parseIosDevices)
      : Promise.reject(new Error("iOS simulators require macOS and Xcode")),
    androidTools().then((tools) => androidDevices(tools, signal)),
  ]);
  const devices = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (results.every((result) => result.status === "rejected")) {
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    throw new AggregateError(
      errors,
      `No native simulator SDK available: ${errors.map(String).join("; ")}`,
    );
  }
  return devices;
}

async function androidSerial(
  device: NativeDevice,
  adb: string,
  signal?: AbortSignal,
) {
  if (!device.id.startsWith("avd:")) return device.id;
  const running = parseAndroidDevices(
    text(await runNativeCommand(adb, ["devices"], signal)),
  );
  for (const item of running) {
    if (item.state !== "Booted") continue;
    const name = text(
      await runNativeCommand(
        adb,
        ["-s", item.id, "emu", "avd", "name"],
        signal,
      ),
    ).split(/\r?\n/)[0];
    if (name === device.id.slice(4)) return item.id;
  }
  return undefined;
}

function delay(signal: AbortSignal) {
  aborted(signal);
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(new Error("Native boot aborted", { cause: signal.reason }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 500);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export async function bootNativeDevice(
  device: NativeDevice,
  signal?: AbortSignal,
): Promise<void> {
  validateDevice(device);
  aborted(signal);
  const bounded = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(BOOT_TIMEOUT),
  ]);
  if (device.platform === "ios") {
    const devices = parseIosDevices(
      text(
        await runNativeCommand(
          "xcrun",
          ["simctl", "list", "devices", "available", "--json"],
          bounded,
        ),
      ),
    );
    const current = devices.find(
      (item) => item.id.toLowerCase() === device.id.toLowerCase(),
    );
    if (!current) throw new Error(`iOS simulator not available: ${device.id}`);
    if (current.state !== "Booted")
      await runNativeCommand("xcrun", ["simctl", "boot", device.id], bounded);
    await runNativeCommand(
      "xcrun",
      ["simctl", "bootstatus", device.id, "-b"],
      bounded,
      BOOT_TIMEOUT,
    );
    return;
  }
  const tools = await androidTools();
  let serial = await androidSerial(device, tools.adb, bounded);
  let owned: ReturnType<typeof spawn> | undefined;
  let launchError: Error | undefined;
  const kill = () => {
    if (!owned?.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-owned.pid, "SIGKILL");
      else owned.kill("SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  try {
    if (!serial) {
      const avds = parseAndroidAvds(
        text(await runNativeCommand(tools.emulator, ["-list-avds"], bounded)),
      );
      if (!avds.some((avd) => avd.id === device.id))
        throw new Error(`Android AVD not available: ${device.id}`);
      owned = spawn(tools.emulator, ["-avd", device.id.slice(4)], {
        stdio: "ignore",
        detached: true,
      });
      owned.once("error", (error) => {
        launchError = error;
      });
      owned.once("exit", (code) => {
        launchError = new Error(`Android emulator exited before boot: ${code}`);
      });
      bounded.addEventListener("abort", kill, { once: true });
      if (bounded.aborted) kill();
    }
    while (true) {
      aborted(bounded);
      if (launchError) throw launchError;
      serial ??= await androidSerial(device, tools.adb, bounded);
      if (serial) {
        const ready = text(
          await runNativeCommand(
            tools.adb,
            ["-s", serial, "shell", "getprop", "sys.boot_completed"],
            bounded,
          ),
        );
        if (ready === "1") break;
      }
      await delay(bounded);
    }
    owned?.unref();
  } catch (error) {
    kill();
    throw error;
  } finally {
    bounded.removeEventListener("abort", kill);
  }
}

export async function captureNativeDevice(
  device: NativeDevice,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  validateDevice(device);
  aborted(signal);
  if (device.platform === "android") {
    const tools = await androidTools();
    const serial = await androidSerial(device, tools.adb, signal);
    if (!serial) throw new Error(`Android AVD is not running: ${device.id}`);
    return runNativeCommand(
      tools.adb,
      ["-s", serial, "exec-out", "screencap", "-p"],
      signal,
    );
  }
  const directory = await mkdtemp(join(tmpdir(), "nikcli-native-"));
  try {
    const path = join(directory, "screenshot.png");
    await runNativeCommand(
      "xcrun",
      ["simctl", "io", device.id, "screenshot", "--type=png", path],
      signal,
    );
    return await readFile(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function openNativeUrl(
  device: NativeDevice,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  validateDevice(device);
  aborted(signal);
  if (
    typeof url !== "string" ||
    !url ||
    url.startsWith("-") ||
    /[\x00-\x20\x7f]/.test(url)
  )
    throw new Error("Invalid native URL");
  try {
    new URL(url);
  } catch {
    throw new Error("Invalid native URL");
  }
  if (device.platform === "ios") {
    await runNativeCommand(
      "xcrun",
      ["simctl", "openurl", device.id, url],
      signal,
    );
    return;
  }
  const tools = await androidTools();
  const serial = await androidSerial(device, tools.adb, signal);
  if (!serial) throw new Error(`Android AVD is not running: ${device.id}`);
  // adb shell joins arguments into a remote shell command; quote the URL there too.
  const quoted = `'${url.replaceAll("'", "'\\''")}'`;
  await runNativeCommand(
    tools.adb,
    [
      "-s",
      serial,
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      quoted,
    ],
    signal,
  );
}

/** Consume in the caller's Effect scope; interruption aborts the active OS capture. */
export function nativeFrames(
  device: NativeDevice,
  intervalMs = 250,
): Stream.Stream<Uint8Array, Error> {
  const capture = Effect.tryPromise({
    try: (signal) => captureNativeDevice(device, signal),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });
  if (!Number.isFinite(intervalMs) || intervalMs < 16 || intervalMs > 60_000) {
    return Stream.fromEffect(
      Effect.fail(
        new Error("Native frame interval must be between 16 and 60000 ms"),
      ),
    );
  }
  return Stream.fromEffectRepeat(
    Effect.gen(function* () {
      const frame = yield* capture;
      yield* Effect.sleep(intervalMs);
      return frame;
    }),
  );
}
