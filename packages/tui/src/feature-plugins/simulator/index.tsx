/**
 * Native simulator — internal TUI plugin.
 *
 * `/simulator` turns a real iOS simulator or Android emulator on inside the
 * session sidebar: the device's own screen, captured by the OS, painted over
 * the grid the same way the browser preview paints a live WebView. Nothing is
 * discovered, booted or captured until the command is run, so a TUI that never
 * opens the simulator pays nothing for it.
 *
 * The sidebar is not always on screen, and `ctx.ui` has no "is the sidebar
 * visible" query. The slot component is: it only ever mounts while the sidebar
 * is rendered, so its own mount count *is* that answer — which is how the
 * command knows to fall back to a dialog instead of toggling a panel nobody
 * can see.
 */
import { Plugin } from "@nikcli-ai/plugin/v2/tui";
import { SimulatorSidebar } from "@tui/component/simulator-sidebar";
import { createSignal, onCleanup, onMount, Show } from "solid-js";

export default Plugin.define({
  id: "internal:simulator",
  setup(ctx) {
    const [enabled, setEnabled] = createSignal(false);
    let mounted = 0;

    function Slot() {
      onMount(() => mounted++);
      onCleanup(() => mounted--);
      return (
        <Show when={enabled()}>
          <SimulatorSidebar onClose={() => setEnabled(false)} />
        </Show>
      );
    }

    ctx.ui.slot("sidebar.content", () => <Slot />);
    ctx.ui.command({
      name: "simulator.toggle",
      title: "Native simulator",
      namespace: "Tool",
      description:
        "Show an installed iOS simulator or Android emulator in the sidebar",
      slash: { name: "simulator" },
      run() {
        if (!enabled()) setEnabled(true);
        // Mounted > 0 means the sidebar slot is live, so the panel is already
        // on screen. Otherwise the sidebar is hidden or off this route, and
        // the same component goes in a dialog rather than nowhere.
        if (mounted > 0) return;
        ctx.ui.dialog.replace(() => (
          <SimulatorSidebar onClose={() => ctx.ui.dialog.clear()} />
        ));
      },
    });
  },
});
