/**
 * Which pane a file opened from the tree or the search results goes to.
 *
 * By extension, and only for the formats the panel can show: a model goes to
 * the 3D panel, a video the video panel plays goes to a video panel, and
 * everything else to the editor. An `.mkv` or an `.avi` is not in the video
 * list (`PLAYABLE_EXTENSIONS`), so it opens as it did before rather than in a
 * panel that refuses it.
 */

import { pathEquals } from "../host/path"
import { isModel } from "../model3d/model"
import { isPlayable } from "../video/video"

export type FileRoute = "model" | "video" | "editor"

export function routeForFile(path: string): FileRoute {
  if (isModel(path)) return "model"
  if (isPlayable(path)) return "video"
  return "editor"
}

/**
 * The pane already showing `path` in the panel `route` names, if any.
 *
 * Compared as paths, not strings: the tree and the search can spell the same
 * file with different case or separators on Windows, and a second click must
 * focus the pane it opened rather than open another.
 */
export function paneShowing<P extends { id: string; mode?: string; videoPath?: string; modelPath?: string }>(
  panes: readonly P[],
  route: "video" | "model",
  path: string,
): P | undefined {
  return panes.find((pane) => {
    const shown = route === "video" ? pane.videoPath : pane.modelPath
    return pane.mode === route && !!shown && pathEquals(shown, path)
  })
}
