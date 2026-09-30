import { RGBA, type BoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  applyLiveCapabilities,
  detectCapabilities,
  encodeSixel,
  pickDecoder,
  resize,
} from "@nikcli-ai/tui-image";
import type { NativeDevice } from "@nikcli-ai/simulation/native";
import { BrowserFramePump, cellSize } from "@tui/util/browser-frames";
import {
  fitOverlayCells,
  registerNativeOverlay,
  type NativeOverlay,
} from "@tui/util/native-overlay";
import { useTheme } from "@tui/context/theme";

export function NativeSimulatorSurface(props: {
  device: NativeDevice;
  columns: number;
  rows: number;
  onStatus?: (status: string) => void;
}) {
  const renderer = useRenderer();
  const { theme } = useTheme();
  const pump = new BrowserFramePump();
  const [placeholder, setPlaceholder] = createSignal<string[]>([]);
  const [status, setStatus] = createSignal("Starting native simulator...");
  const [box, setBox] = createSignal<BoxRenderable>();
  let overlay: NativeOverlay | undefined;
  let unregister: (() => void) | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let disposed = false;
  let sequence = 0;

  const report = (value: string) => {
    setStatus(value);
    props.onStatus?.(value);
  };
  const clearImage = () => {
    unregister?.();
    unregister = undefined;
    overlay = undefined;
    setPlaceholder([]);
  };

  createEffect(() => {
    const device = props.device;
    const columns = props.columns;
    const rows = props.rows;
    const host = box();
    if (!host) return;
    controller?.abort();
    clearTimeout(timer);
    clearImage();
    const mine = ++generation;
    const abort = new AbortController();
    controller = abort;
    const current = () =>
      !disposed && !abort.signal.aborted && mine === generation;
    const capabilities = applyLiveCapabilities(
      detectCapabilities(),
      renderer.capabilities,
    );
    if (!capabilities.kitty && !capabilities.sixel) {
      report(
        "Live simulator needs Kitty graphics or Sixel (enable terminal images).",
      );
      return;
    }
    report(`Booting ${device.label}...`);
    void (async () => {
      const native = await import("@nikcli-ai/simulation/native");
      if (!current()) return;
      await native.bootNativeDevice(device, abort.signal);
      if (!current()) return;
      const decoder = await pickDecoder({ preferWasm: true });
      if (!current()) return;
      const capture = async () => {
        try {
          const png = await native.captureNativeDevice(device, abort.signal);
          if (!current()) return;
          const image = await decoder(png);
          if (!current()) return;
          if (image.width <= 0 || image.height <= 0)
            throw new Error("Native simulator returned an empty screen");
          const cell = cellSize(
            renderer.resolution,
            renderer.terminalWidth,
            renderer.terminalHeight,
          );
          const fitted = fitOverlayCells(
            image.width,
            image.height,
            { columns, rows },
            cell,
          );
          if (capabilities.kitty) {
            if (pump.setPlacement(fitted.columns, fitted.rows))
              setPlaceholder(pump.placeholder());
            pump.present({
              seq: ++sequence,
              width: image.width,
              height: image.height,
              pngBase64: Buffer.from(png).toString("base64"),
            });
          } else {
            const bytes = encodeSixel(
              resize(image, fitted.pixelWidth, fitted.pixelHeight),
            );
            if (!overlay) {
              overlay = {
                box: host,
                bytes,
                columns: fitted.columns,
                rows: fitted.rows,
                chromeBottom: 5,
              };
              unregister = registerNativeOverlay(renderer, overlay);
            } else {
              overlay.bytes = bytes;
              overlay.columns = fitted.columns;
              overlay.rows = fitted.rows;
              renderer.requestRender();
            }
          }
          report("Live native screen");
          timer = setTimeout(() => void capture(), 500);
        } catch (error) {
          if (!current()) return;
          clearImage();
          report(error instanceof Error ? error.message : String(error));
        }
      };
      await capture();
    })().catch((error: unknown) => {
      if (current())
        report(error instanceof Error ? error.message : String(error));
    });
  });

  onCleanup(() => {
    disposed = true;
    generation++;
    controller?.abort();
    clearTimeout(timer);
    unregister?.();
    pump.destroy();
  });

  return (
    <box ref={setBox} width={props.columns} height={props.rows} flexShrink={0}>
      <Show
        when={status() === "Live native screen"}
        fallback={
          <text fg={theme.foreground.muted} wrapMode="word">
            {status()}
          </text>
        }
      >
        <For each={placeholder()}>
          {(row) => (
            <text
              fg={RGBA.fromInts(pump.color.r, pump.color.g, pump.color.b, 255)}
            >
              {row}
            </text>
          )}
        </For>
      </Show>
    </box>
  );
}
