/** Native notification when a long run ends while DevHub is in the background. */
export async function notifyIfBackground(title: string, body: string) {
  if (document.hasFocus()) return
  try {
    const n = await import("@tauri-apps/plugin-notification")
    if (!(await n.isPermissionGranted()) && (await n.requestPermission()) !== "granted") return
    n.sendNotification({ title, body })
  } catch {
    // Not running inside Tauri (plain browser dev) or notifications denied: silently skip.
  }
}
