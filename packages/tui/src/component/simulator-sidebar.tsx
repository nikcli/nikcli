import type { NativeDevice } from "@nikcli-ai/simulation/native";
import type { Component } from "solid-js";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useTheme } from "@tui/context/theme";
import { useDialog } from "@tui/ui/dialog";
import { DialogSelect } from "@tui/ui/dialog-select";
import { SESSION_SIDEBAR_WIDTH } from "@tui/ui/layout";
import { useAttempts } from "@tui/util/lifecycle";

type SurfaceProps = {
  device: NativeDevice;
  columns: number;
  rows: number;
  onStatus?: (status: string) => void;
};

function failure(error: unknown): string {
  if (error instanceof AggregateError)
    return error.errors.map(failure).join("; ");
  return error instanceof Error ? error.message : String(error);
}

export function SimulatorSidebar(props: { onClose: () => void }) {
  const { theme } = useTheme();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  const discovery = useAttempts();
  const activation = useAttempts();
  const [devices, setDevices] = createSignal<NativeDevice[]>([]);
  const [active, setActive] = createSignal<NativeDevice>();
  const [status, setStatus] = createSignal(
    "Discovering installed native devices...",
  );
  const [notice, setNotice] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [Surface, setSurface] = createSignal<Component<SurfaceProps>>();
  const columns = SESSION_SIDEBAR_WIDTH - 5;
  const rows = createMemo(() =>
    Math.max(
      1,
      Math.min(28, Math.floor(columns / 2), dimensions().height - 14),
    ),
  );

  async function refresh() {
    const attempt = discovery.start();
    setLoading(true);
    setNotice("");
    try {
      const backend = await import("@nikcli-ai/simulation/native");
      if (attempt.stale()) return;
      const available = await backend.listNativeDevices(attempt.signal);
      if (attempt.stale()) return;
      setDevices(available);
      const missing = [];
      if (!available.some((device) => device.platform === "ios")) {
        missing.push(
          "iOS: no available simulators. Install Xcode and an iOS simulator runtime (macOS required).",
        );
      }
      if (!available.some((device) => device.platform === "android")) {
        missing.push(
          "Android: no available emulators. Install Android SDK platform-tools/emulator, set ANDROID_HOME, and create an AVD.",
        );
      }
      setNotice(missing.join(" "));
      if (!active())
        setStatus(
          available.length
            ? "Choose a device to start its live screen."
            : "No installed native devices found.",
        );
    } catch (error) {
      if (!attempt.stale()) {
        setDevices([]);
        setNotice(failure(error));
      }
    } finally {
      if (!attempt.stale()) setLoading(false);
    }
  }

  async function choose(device: NativeDevice) {
    const attempt = activation.start();
    setActive(undefined);
    setStatus(`Starting ${device.label}...`);
    try {
      const backend = await import("@nikcli-ai/simulation/native");
      if (attempt.stale()) return;
      await backend.bootNativeDevice(device, attempt.signal);
      if (attempt.stale()) return;
      const surface = await import("./native-simulator-surface");
      if (attempt.stale()) return;
      setSurface(() => surface.NativeSimulatorSurface);
      setActive({ ...device, state: "Booted" });
      setStatus("Connecting live screen...");
    } catch (error) {
      if (!attempt.stale()) setStatus(failure(error));
    }
  }

  function picker() {
    if (activation.disposed) return;
    dialog.replace(() => (
      <DialogSelect
        title="Native simulator device"
        current={active()?.id}
        options={devices().map((device) => ({
          title: device.label,
          value: device.id,
          category: device.platform === "ios" ? "iOS" : "Android",
          description: `${device.state}${active()?.id === device.id ? " - active" : ""}`,
          searchText: device.id,
        }))}
        onSelect={(option) => {
          if (activation.disposed) return;
          const device = devices().find((item) => item.id === option.value);
          dialog.clear();
          if (device) void choose(device);
        }}
      />
    ));
  }

  onMount(() => void refresh());

  return (
    <box width={columns} flexShrink={0} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.foreground.default}>
          <b>Native Simulator</b>
        </text>
        <text fg={theme.foreground.muted} onMouseDown={props.onClose}>
          Close
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={theme.foreground.default} onMouseDown={picker}>
          Choose device
        </text>
        <text fg={theme.foreground.muted} onMouseDown={() => void refresh()}>
          {loading() ? "Refreshing..." : "Refresh"}
        </text>
      </box>
      <Show when={active()} keyed>
        {(device) => (
          <box>
            <text fg={theme.foreground.default}>
              {device.label} ({device.platform === "ios" ? "iOS" : "Android"})
            </text>
            <Show when={Surface()}>
              {(View) => {
                const Render = View();
                return (
                  <Render
                    device={device}
                    columns={columns}
                    rows={rows()}
                    onStatus={(value) => {
                      if (!activation.disposed && active() === device)
                        setStatus(value);
                    }}
                  />
                );
              }}
            </Show>
          </box>
        )}
      </Show>
      <text fg={theme.foreground.muted} wrapMode="word">
        {status()}
      </text>
      <Show when={notice()}>
        <text fg={theme.foreground.muted} wrapMode="word">
          {notice()}
        </text>
      </Show>
    </box>
  );
}
