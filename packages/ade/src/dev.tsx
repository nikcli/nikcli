/**
 * Standalone harness: mounts the ADE surface into the page's root.
 *
 * Kept apart from the surface itself so importing ADE never renders anything.
 */
import { render } from "solid-js/web"
import { AdeSurface } from "./ade-surface"
import { isTestIdentifier } from "./host/build-identity"

const root = document.getElementById("root")
if (root) render(() => <AdeSurface />, root)

// ADE Test runs next to the official app, so it has to be told apart at a
// glance: the stylesheet tints the title-bar mark and badges it while this
// attribute is set. Outside Tauri there is no identifier and nothing changes.
if ("__TAURI_INTERNALS__" in window) {
  void import("@tauri-apps/api/app")
    .then(({ getIdentifier }) => getIdentifier())
    .then((identifier) => {
      if (!isTestIdentifier(identifier)) return
      document.documentElement.dataset.adeBuild = "test"
      // Set by `bun run test:app`: which worktree this instance is running.
      const label = import.meta.env.VITE_ADE_TEST_LABEL
      if (label) document.documentElement.style.setProperty("--ade-test-label", JSON.stringify(` ${label}`))
    })
    .catch(() => {})
}
