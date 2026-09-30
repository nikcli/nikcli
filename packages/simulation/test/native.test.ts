import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import {
  bootNativeDevice,
  captureNativeDevice,
  nativeFrames,
  openNativeUrl,
  parseAndroidAvds,
  parseAndroidDevices,
  parseIosDevices,
  runNativeCommand,
  type NativeDevice,
} from "../src/native";

const ios: NativeDevice = {
  id: "A1B2C3D4-1111-2222-3333-123456789ABC",
  label: "iPhone",
  platform: "ios",
  state: "Shutdown",
};

test("parses available simctl devices across runtimes without inventing devices", () => {
  expect(
    parseIosDevices(
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
            {
              udid: ios.id,
              name: "iPhone 17",
              state: "Booted",
              isAvailable: true,
            },
            {
              udid: "unavailable",
              name: "Old phone",
              state: "Shutdown",
              isAvailable: false,
            },
          ],
          "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [],
        },
      }),
    ),
  ).toEqual([{ ...ios, label: "iPhone 17", state: "Booted" }]);
  expect(parseIosDevices('{"devices":{}}')).toEqual([]);
});

test("rejects malformed simctl data and identifiers", () => {
  for (const input of [
    "null",
    "{}",
    '{"devices":{"runtime":{}}}',
    '{"devices":{"runtime":[{"isAvailable":true}]}}',
  ]) {
    expect(() => parseIosDevices(input)).toThrow();
  }
  expect(() =>
    parseIosDevices(
      JSON.stringify({
        devices: {
          runtime: [
            {
              udid: "--help",
              name: "bad",
              state: "Booted",
              isAvailable: true,
            },
          ],
        },
      }),
    ),
  ).toThrow("identifier");
});

test("parses idle Android AVDs and deduplicates CRLF output", () => {
  expect(
    parseAndroidAvds("Pixel_9_API_36\r\nTablet.35\r\nPixel_9_API_36\r\n"),
  ).toEqual([
    {
      id: "avd:Pixel_9_API_36",
      label: "Pixel_9_API_36",
      platform: "android",
      state: "Shutdown",
    },
    {
      id: "avd:Tablet.35",
      label: "Tablet.35",
      platform: "android",
      state: "Shutdown",
    },
  ]);
  expect(parseAndroidAvds("")).toEqual([]);
  expect(() => parseAndroidAvds("Pixel;touch /tmp/injected")).toThrow(
    "identifier",
  );
});

test("discovers running Android emulator serials, not USB hardware or adb chatter", () => {
  expect(
    parseAndroidDevices(`* daemon started successfully *
List of devices attached
emulator-5554 device product:sdk_gphone model:sdk_gphone
emulator-5556 offline
emulator-5558 unauthorized
physical-phone device
`),
  ).toEqual([
    {
      id: "emulator-5554",
      label: "emulator-5554",
      platform: "android",
      state: "Booted",
    },
    {
      id: "emulator-5556",
      label: "emulator-5556",
      platform: "android",
      state: "offline",
    },
    {
      id: "emulator-5558",
      label: "emulator-5558",
      platform: "android",
      state: "unauthorized",
    },
  ]);
});

test("validates devices before any OS command", async () => {
  for (const device of [
    { ...ios, id: "booted" },
    { ...ios, label: "" },
    { ...ios, platform: "web" },
    { ...ios, platform: "android", id: "avd:Pixel;whoami" },
    { ...ios, platform: "android", id: "--help" },
  ] as NativeDevice[]) {
    await expect(bootNativeDevice(device)).rejects.toThrow(
      "Invalid native device",
    );
    await expect(captureNativeDevice(device)).rejects.toThrow(
      "Invalid native device",
    );
    await expect(openNativeUrl(device, "https://example.com")).rejects.toThrow(
      "Invalid native device",
    );
  }
});

test("validates native URLs before SDK discovery", async () => {
  for (const url of [
    "",
    "--help",
    "relative/path",
    "https://example.com\nwhoami",
    "https://example.com\u0000",
  ]) {
    await expect(openNativeUrl(ios, url)).rejects.toThrow("Invalid native URL");
  }
});

test("already aborted operations never launch OS commands", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before launch"));
  await expect(bootNativeDevice(ios, controller.signal)).rejects.toThrow(
    "cancelled before launch",
  );
  await expect(captureNativeDevice(ios, controller.signal)).rejects.toThrow(
    "cancelled before launch",
  );
  await expect(
    openNativeUrl(ios, "myapp://home", controller.signal),
  ).rejects.toThrow("cancelled before launch");
  await expect(
    runNativeCommand("missing-executable", [], controller.signal),
  ).rejects.toThrow("cancelled before launch");
});

test("native commands preserve binary output and pass arguments without shell evaluation", async () => {
  const argument = "$(whoami); 'quoted' & https://example.com?a=1&b=2";
  const bytes = await runNativeCommand(process.execPath, [
    "-e",
    "process.stdout.write(process.argv[1])",
    argument,
  ]);
  expect(new TextDecoder().decode(bytes)).toBe(argument);
  const binary = await runNativeCommand(process.execPath, [
    "-e",
    "process.stdout.write(Buffer.from([0,137,255,10]))",
  ]);
  expect([...binary]).toEqual([0, 137, 255, 10]);
});

test("native commands surface stderr and missing executable errors", async () => {
  await expect(
    runNativeCommand(process.execPath, [
      "-e",
      "console.error('SDK failure');process.exit(7)",
    ]),
  ).rejects.toThrow("exited 7: SDK failure");
  await expect(
    runNativeCommand("/nonexistent/nikcli-native-command", []),
  ).rejects.toThrow("Cannot run");
});

test("command timeout kills and reaps the owned process", async () => {
  const start = Date.now();
  await expect(
    runNativeCommand(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      undefined,
      80,
    ),
  ).rejects.toThrow("timed out");
  expect(Date.now() - start).toBeLessThan(3000);
});

test("cancellation kills and reaps a running owned command", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  try {
    await expect(
      runNativeCommand(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        controller.signal,
      ),
    ).rejects.toThrow("aborted");
  } finally {
    clearTimeout(timer);
  }
});

test("Effect frame stream validates intervals and devices without an independent runtime", async () => {
  const invalidInterval = await Effect.runPromise(
    Effect.exit(Stream.runCollect(nativeFrames(ios, 0))),
  );
  expect(invalidInterval._tag).toBe("Failure");
  const invalidDevice = await Effect.runPromise(
    Effect.exit(Stream.runCollect(nativeFrames({ ...ios, id: "invalid" }))),
  );
  expect(invalidDevice._tag).toBe("Failure");
});
