import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react"
import {
  ActivityIndicator,
  Animated,
  Linking,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native"
import {
  Code2,
  ExternalLink,
  FolderOpen,
  Github,
  Globe,
  Image as ImageIcon,
  MonitorPlay,
  RefreshCw,
  Share2,
  X,
} from "lucide-react-native"
import { Image } from "expo-image"
import { useVideoPlayer, VideoView } from "expo-video"
import { WebView } from "react-native-webview"
import * as WebBrowser from "expo-web-browser"
import * as Clipboard from "expo-clipboard"
import { ActionSheet, type ActionSheetRef } from "@/components/BottomSheet"
import { EmptyState } from "@/components/ui/EmptyState"
import {
  kindLabel,
  labelForUrl,
  previewDocumentHtml,
  previewSourceText,
  type SessionPreview,
} from "@/lib/session-artifacts"
import { triggerHaptic } from "@/lib/haptics"
import { usePressAnimation } from "@/lib/animation"
import { useUIStore } from "@/lib/store"
import { hexToRgba, useAppTheme } from "@/lib/theme"

export type { SessionPreview } from "@/lib/session-artifacts"

/** Workspace context for the project tied to this session (repo, paths, quick actions). */
export type SessionProjectPanel = {
  sessionTitle: string
  workspacePrimary: string
  pathDetail?: string
  branchLabel?: string
  githubUrl?: string
  onBrowseWorkspace?(): void
}

function sourceLabel(source: SessionPreview["source"]) {
  return source === "local" ? "Local" : "Remote"
}

function formatBytes(value: number | undefined) {
  if (value === undefined) return null
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

function artifactDetail(preview: SessionPreview) {
  if (!preview.artifact) return null
  return [preview.artifact.filename, `v${preview.artifact.version}`, formatBytes(preview.artifact.size)]
    .filter(Boolean)
    .join(" · ")
}

async function openPreviewExternally(url: string) {
  try {
    await WebBrowser.openBrowserAsync(url)
    return
  } catch {
    /* WebView in-app sheet failed — try system handler */
  }
  try {
    await Linking.openURL(url)
  } catch {
    /* ignore */
  }
}

function statusTone(status: "loading" | "ready" | "failed", palette: ReturnType<typeof useAppTheme>["palette"]) {
  if (status === "ready") return { label: "Ready", color: palette.success }
  if (status === "failed") return { label: "Can't load", color: palette.warn }
  return { label: "Loading…", color: palette.muted }
}

function kindIcon(kind: SessionPreview["kind"], color: string) {
  if (kind === "url") return <Globe size={13} color={color} strokeWidth={2.2} />
  if (kind === "svg" || kind === "image") return <ImageIcon size={13} color={color} strokeWidth={2.2} />
  if (kind === "mermaid" || kind === "video") return <MonitorPlay size={13} color={color} strokeWidth={2.2} />
  return <Code2 size={13} color={color} strokeWidth={2.2} />
}

function SectionHeader(props: {
  icon: ReactNode
  title: string
  right?: string
  palette: ReturnType<typeof useAppTheme>["palette"]
}) {
  return (
    <View style={{ marginBottom: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {props.icon}
        <Text style={{ color: props.palette.ink, fontSize: 13, fontWeight: "800" }}>{props.title}</Text>
      </View>
      {props.right ? (
        <Text style={{ color: props.palette.muted, fontSize: 11, fontWeight: "700" }}>{props.right}</Text>
      ) : null}
    </View>
  )
}

function ProjectWorkspaceCard(props: {
  project: SessionProjectPanel
  isDark: boolean
  palette: ReturnType<typeof useAppTheme>["palette"]
}) {
  const { project, isDark, palette } = props
  const metaLine = [project.branchLabel, project.pathDetail].filter(Boolean).join(" · ")

  return (
    <View
      style={{
        marginBottom: 14,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: isDark ? hexToRgba(palette.ink, 0.1) : hexToRgba(palette.border, 0.86),
        backgroundColor: isDark ? "rgba(255,255,255,0.045)" : "rgba(255,255,255,0.86)",
        padding: 14,
        gap: 10,
      }}
    >
      <View style={{ gap: 4, minWidth: 0 }}>
        <Text numberOfLines={2} style={{ color: palette.ink, fontSize: 16, fontWeight: "800" }}>
          {project.sessionTitle}
        </Text>
        <Text numberOfLines={2} selectable style={{ color: palette.accentLight, fontSize: 13, fontWeight: "700" }}>
          {project.workspacePrimary}
        </Text>
        {metaLine ? (
          <Text numberOfLines={2} selectable style={{ color: palette.muted, fontSize: 11, fontWeight: "600" }}>
            {metaLine}
          </Text>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {project.onBrowseWorkspace ? (
          <Pressable
            onPress={project.onBrowseWorkspace}
            accessibilityRole="button"
            accessibilityLabel="Open files for this session"
            style={({ pressed }) => ({
              borderRadius: 12,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: isDark ? hexToRgba(palette.ink, 0.1) : hexToRgba(palette.border, 0.72),
              opacity: pressed ? 0.7 : 1,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <View
              style={{
                minHeight: 44,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 12,
              }}
            >
              <FolderOpen size={14} color={palette.ink} strokeWidth={2.2} />
              <Text style={{ color: palette.ink, fontSize: 12, fontWeight: "700" }}>Files</Text>
            </View>
          </Pressable>
        ) : null}
        {project.githubUrl ? (
          <Pressable
            onPress={() => void Linking.openURL(project.githubUrl!)}
            accessibilityRole="button"
            accessibilityLabel="Open repository on GitHub"
            style={({ pressed }) => ({
              borderRadius: 12,
              borderCurve: "continuous",
              backgroundColor: hexToRgba(palette.ink, 0.1),
              opacity: pressed ? 0.7 : 1,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <View
              style={{
                minHeight: 44,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 12,
              }}
            >
              <Github size={14} color={palette.accentLight} strokeWidth={2.2} />
              <Text style={{ color: palette.accentLight, fontSize: 12, fontWeight: "800" }}>GitHub</Text>
            </View>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

function PreviewViewport(props: {
  preview: SessionPreview
  reloadKey: number
  isDark: boolean
  scrollEnabled?: boolean
  active?: boolean
  onLoadStart(): void
  onLoad(): void
  onError(): void
}) {
  const documentHtml = useMemo(() => previewDocumentHtml(props.preview, props.isDark), [props.isDark, props.preview])
  const mediaUrl = props.preview.previewUrl ?? props.preview.viewerUrl ?? props.preview.url

  if (props.preview.kind === "image" && mediaUrl) {
    return (
      <Image
        key={`${props.preview.id}:${props.reloadKey}`}
        source={{ uri: mediaUrl }}
        contentFit="contain"
        transition={180}
        onLoadStart={props.onLoadStart}
        onLoad={props.onLoad}
        onError={props.onError}
        style={{ flex: 1, width: "100%", backgroundColor: "transparent" }}
      />
    )
  }

  if (props.preview.kind === "video" && mediaUrl) {
    return (
      <ArtifactVideoViewport
        key={`${props.preview.id}:${props.reloadKey}`}
        uri={mediaUrl}
        controls={props.scrollEnabled ?? false}
        active={props.active ?? false}
        onLoadStart={props.onLoadStart}
        onLoad={props.onLoad}
        onError={props.onError}
      />
    )
  }

  if (mediaUrl) {
    return (
      <WebView
        key={`${props.preview.id}:${props.reloadKey}`}
        source={{ uri: mediaUrl }}
        startInLoadingState
        scrollEnabled={props.scrollEnabled ?? false}
        setSupportMultipleWindows={false}
        onLoadStart={props.onLoadStart}
        onLoad={props.onLoad}
        onError={props.onError}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    )
  }

  if (!documentHtml) return null

  return (
    <WebView
      key={`${props.preview.id}:${props.reloadKey}`}
      originWhitelist={["*"]}
      source={{ html: documentHtml, baseUrl: "" }}
      scrollEnabled={props.scrollEnabled ?? false}
      setSupportMultipleWindows={false}
      javaScriptEnabled
      domStorageEnabled={false}
      onLoadStart={props.onLoadStart}
      onLoad={props.onLoad}
      onError={props.onError}
      style={{ flex: 1, backgroundColor: "transparent" }}
    />
  )
}

function ArtifactVideoViewport(props: {
  uri: string
  controls: boolean
  active: boolean
  onLoadStart(): void
  onLoad(): void
  onError(): void
}) {
  const player = useVideoPlayer(props.uri)

  useEffect(() => {
    props.onLoadStart()
    if (player.status === "readyToPlay") props.onLoad()
    if (player.status === "error") props.onError()

    const subscription = player.addListener("statusChange", ({ status }) => {
      if (status === "readyToPlay") props.onLoad()
      if (status === "error") props.onError()
    })
    return () => subscription.remove()
  }, [player])

  useEffect(() => {
    if (!props.active) player.pause()
  }, [player, props.active])

  return (
    <VideoView
      player={player}
      nativeControls={props.controls}
      contentFit="contain"
      style={{ flex: 1, width: "100%", backgroundColor: "transparent" }}
    />
  )
}

export function ArtifactMicroThumb(props: { preview: SessionPreview }) {
  const { isDark, palette } = useAppTheme()

  return (
    <View
      style={{
        width: 56,
        height: 40,
        overflow: "hidden",
        borderRadius: 6,
        borderWidth: 1,
        borderColor: isDark ? hexToRgba(palette.ink, 0.1) : hexToRgba(palette.border, 0.72),
        backgroundColor: palette.surfaceMuted,
      }}
    >
      <PreviewViewport
        preview={props.preview}
        reloadKey={0}
        isDark={isDark}
        onLoadStart={() => undefined}
        onLoad={() => undefined}
        onError={() => undefined}
      />
    </View>
  )
}

export function InlineArtifactCard(props: { preview: SessionPreview; onPress(): void }) {
  const { palette, isDark } = useAppTheme()
  const press = usePressAnimation()
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading")

  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <Pressable
        onPress={() => {
          void triggerHaptic("selection")
          props.onPress()
        }}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={`Open ${kindLabel(props.preview.kind)} artifact`}
        style={({ pressed }) => ({ opacity: pressed ? 0.88 : 1 })}
      >
        <View
          className="overflow-hidden rounded-[8px] border border-border/80 bg-background/55"
          style={{ marginTop: 8 }}
        >
          <View
            style={{
              height: 168,
              overflow: "hidden",
              backgroundColor: palette.surfaceMuted,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: hexToRgba(palette.ink, 0.08),
            }}
          >
            <PreviewViewport
              preview={props.preview}
              reloadKey={0}
              isDark={isDark}
              onLoadStart={() => setStatus("loading")}
              onLoad={() => setStatus("ready")}
              onError={() => setStatus("failed")}
            />
            {status !== "ready" ? (
              <View
                pointerEvents="none"
                style={[
                  StyleSheet.absoluteFill,
                  {
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    backgroundColor: isDark ? "rgba(8,8,8,0.76)" : "rgba(248,250,252,0.84)",
                  },
                ]}
              >
                {status === "loading" ? <ActivityIndicator color={palette.accentLight} /> : null}
                <Text style={{ color: palette.ink, fontSize: 11, fontWeight: "700" }}>
                  {status === "failed" ? "Preview unavailable" : "Loading preview…"}
                </Text>
              </View>
            ) : null}
          </View>
          <View className="flex-row items-center justify-between gap-3 px-3 py-2.5">
            <View className="min-w-0 flex-1 flex-row items-center gap-2">
              {kindIcon(props.preview.kind, palette.accentLight)}
              <Text numberOfLines={1} className="flex-1 text-[12px] font-semibold text-ink">
                {props.preview.title}
              </Text>
            </View>
            <Text className="text-[11px] font-semibold text-muted">
              {props.preview.artifact ? `v${props.preview.artifact.version}` : "Expand"}
            </Text>
          </View>
        </View>
      </Pressable>
    </Animated.View>
  )
}

export function SessionPreviewStrip({
  previews,
  project,
  onSelectPreview,
}: {
  previews: SessionPreview[]
  project?: SessionProjectPanel | null
  onSelectPreview?(preview: SessionPreview): void
}) {
  const { palette, isDark } = useAppTheme()
  const [reloadKeys, setReloadKeys] = useState<Record<string, number>>({})
  const [previewStates, setPreviewStates] = useState<Record<string, "loading" | "ready" | "failed">>({})
  const visible = useMemo(() => previews.slice(0, 6), [previews])
  const publishedCount = visible.filter((item) => item.artifact).length
  const liveCount = visible.filter((item) => item.kind === "url" && !item.artifact).length
  const generatedCount = visible.length - publishedCount - liveCount

  if (!project && !visible.length) return null

  return (
    <View style={{ marginBottom: 12 }}>
      {project ? (
        <>
          <SectionHeader
            icon={<FolderOpen size={15} color={palette.accentLight} strokeWidth={2.2} />}
            title="Session project"
            palette={palette}
          />
          <ProjectWorkspaceCard project={project} isDark={isDark} palette={palette} />
        </>
      ) : null}

      {visible.length ? (
        <>
          <SectionHeader
            icon={<MonitorPlay size={15} color={palette.accentLight} strokeWidth={2.2} />}
            title="Artifacts & previews"
            right={[
              publishedCount ? `${publishedCount} published` : null,
              liveCount ? `${liveCount} live` : null,
              generatedCount ? `${generatedCount} generated` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            palette={palette}
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 12, paddingRight: 16 }}
          >
            {visible.map((preview) => (
              <PreviewCard
                key={preview.id}
                preview={preview}
                reloadKey={reloadKeys[preview.id] ?? 0}
                status={previewStates[preview.id] ?? "loading"}
                isDark={isDark}
                palette={palette}
                onLoadStart={() => setPreviewStates((current) => ({ ...current, [preview.id]: "loading" }))}
                onLoad={() => setPreviewStates((current) => ({ ...current, [preview.id]: "ready" }))}
                onError={() => setPreviewStates((current) => ({ ...current, [preview.id]: "failed" }))}
                onReload={() =>
                  setReloadKeys((current) => ({ ...current, [preview.id]: (current[preview.id] ?? 0) + 1 }))
                }
                onOpen={() => onSelectPreview?.(preview)}
              />
            ))}
          </ScrollView>
        </>
      ) : null}
    </View>
  )
}

export type SessionPreviewSheetProps = {
  title: string
  previews: SessionPreview[]
  project?: SessionProjectPanel | null
  onSelectPreview?(preview: SessionPreview): void
}

export const SessionPreviewSheet = forwardRef<ActionSheetRef, SessionPreviewSheetProps>(function SessionPreviewSheet(
  { title, previews, project, onSelectPreview },
  ref,
) {
  const { palette, isDark } = useAppTheme()
  const hasContent = Boolean(project || previews.length)

  return (
    <ActionSheet ref={ref} snapPoints={["92%"]}>
      <View className="border-b border-border px-5 pb-4">
        <Text className="text-[12px] font-medium text-muted">Session preview</Text>
        <Text className="mt-1.5 text-lg font-bold leading-6 tracking-tight text-ink" numberOfLines={2}>
          {title || "Session"}
        </Text>
        <View
          className="mt-2 self-start rounded-full px-2.5 py-1"
          style={{
            borderWidth: 1,
            borderColor: hexToRgba(palette.ink, isDark ? 0.12 : 0.18),
            backgroundColor: hexToRgba(palette.ink, isDark ? 0.08 : 0.09),
          }}
        >
          <Text className="text-[10px] font-semibold tracking-wide" style={{ color: palette.accentLight }}>
            Published pages, images, video, live URLs & generated previews
          </Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {hasContent ? (
          <SessionPreviewStrip previews={previews} project={project} onSelectPreview={onSelectPreview} />
        ) : (
          <EmptyState
            title="No artifacts yet"
            description="Published nikcli-ai.dev artifacts, dev server links, and generated previews from the chat appear here."
          />
        )}
      </ScrollView>
    </ActionSheet>
  )
})

export type ArtifactViewerSheetProps = {
  preview: SessionPreview | null
}

export const ArtifactViewerSheet = forwardRef<ActionSheetRef, ArtifactViewerSheetProps>(function ArtifactViewerSheet(
  { preview },
  forwardedRef,
) {
  const { palette, isDark } = useAppTheme()
  const [tab, setTab] = useState<"preview" | "source">("preview")
  const [reloadKey, setReloadKey] = useState(0)
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading")
  const [visible, setVisible] = useState(false)
  const sheetRef = useRef<ActionSheetRef>(null)

  useImperativeHandle(
    forwardedRef,
    () => ({
      present: () => sheetRef.current?.present(),
      dismiss: (onDismissed?: () => void) => sheetRef.current?.dismiss(onDismissed),
    }),
    [],
  )

  const sourceText = preview ? previewSourceText(preview) : ""
  const statusMeta = statusTone(status, palette)

  useEffect(() => {
    setTab("preview")
    setReloadKey(0)
    setStatus("loading")
  }, [preview?.id])

  async function copySource() {
    if (!sourceText) return
    await Clipboard.setStringAsync(sourceText)
    void triggerHaptic("success")
    useUIStore.getState().showToast({ message: "Copied to clipboard", kind: "success" })
  }

  async function shareSource() {
    if (!preview) return
    if (preview.url) {
      await Share.share({ url: preview.url, message: preview.url })
      return
    }
    await Share.share({ message: sourceText })
  }

  return (
    <ActionSheet ref={sheetRef} snapPoints={["94%"]} onVisibilityChange={setVisible}>
      {preview ? (
        <>
          <View className="border-b border-border px-5 pb-4">
            <View className="flex-row items-start justify-between gap-3">
              <View className="min-w-0 flex-1">
                <Text className="text-[12px] font-medium text-muted">{kindLabel(preview.kind)} artifact</Text>
                <Text className="mt-1.5 text-lg font-bold leading-6 tracking-tight text-ink" numberOfLines={2}>
                  {preview.title}
                </Text>
                {preview.artifact ? (
                  <>
                    <Text className="mt-1 text-[11px] font-semibold text-muted" numberOfLines={1}>
                      {artifactDetail(preview)}
                    </Text>
                    {preview.artifact.description ? (
                      <Text className="mt-1 text-[12px] leading-4 text-soft" numberOfLines={2}>
                        {preview.artifact.description}
                      </Text>
                    ) : null}
                  </>
                ) : null}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <View style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: statusMeta.color }} />
                  <Text style={{ color: statusMeta.color, fontSize: 10, fontWeight: "800" }}>{statusMeta.label}</Text>
                </View>
                <Pressable
                  onPress={() => {
                    void triggerHaptic("selection")
                    sheetRef.current?.dismiss()
                  }}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Close artifact"
                  style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    borderCurve: "continuous",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: hexToRgba(palette.ink, isDark ? 0.1 : 0.08),
                    opacity: pressed ? 0.65 : 1,
                    transform: [{ scale: pressed ? 0.97 : 1 }],
                  })}
                >
                  <X size={15} color={palette.soft} strokeWidth={2.4} />
                </Pressable>
              </View>
            </View>

            <View className="mt-3 flex-row rounded-[8px] border border-border bg-surface p-1">
              {(["preview", "source"] as const).map((value) => {
                const active = tab === value
                return (
                  <Pressable
                    key={value}
                    onPress={() => {
                      setTab(value)
                      void triggerHaptic("selection")
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={({ pressed }) => ({
                      flex: 1,
                      borderRadius: 8,
                      borderCurve: "continuous",
                      opacity: pressed ? 0.8 : 1,
                      backgroundColor: active ? hexToRgba(palette.ink, isDark ? 0.1 : 0.08) : "transparent",
                      transform: [{ scale: pressed ? 0.97 : 1 }],
                    })}
                  >
                    <View style={{ minHeight: 44, alignItems: "center", justifyContent: "center" }}>
                      <Text
                        style={{
                          color: active ? palette.ink : palette.muted,
                          fontSize: 12,
                          fontWeight: active ? "800" : "600",
                          textTransform: "capitalize",
                        }}
                      >
                        {value === "source" && preview.artifact ? "link" : value}
                      </Text>
                    </View>
                  </Pressable>
                )
              })}
            </View>
          </View>

          <View style={{ flex: 1, minHeight: 320 }}>
            {tab === "preview" ? (
              <View style={{ flex: 1, backgroundColor: palette.surfaceMuted }}>
                <PreviewViewport
                  preview={preview}
                  reloadKey={reloadKey}
                  isDark={isDark}
                  scrollEnabled
                  active={visible && tab === "preview"}
                  onLoadStart={() => setStatus("loading")}
                  onLoad={() => setStatus("ready")}
                  onError={() => setStatus("failed")}
                />
              </View>
            ) : (
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
                keyboardShouldPersistTaps="handled"
              >
                <Text
                  selectable
                  style={{
                    color: palette.codeText,
                    fontFamily: "Menlo",
                    fontSize: 12,
                    lineHeight: 18,
                  }}
                >
                  {sourceText}
                </Text>
              </ScrollView>
            )}
          </View>

          <View
            style={{
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: hexToRgba(palette.ink, 0.08),
              paddingHorizontal: 12,
              paddingTop: 10,
              paddingBottom: 20,
              flexDirection: "row",
              gap: 8,
            }}
          >
            <ActionChip label="Copy" icon={Code2} onPress={() => void copySource()} palette={palette} isDark={isDark} />
            <ActionChip
              label="Share"
              icon={Share2}
              onPress={() => void shareSource()}
              palette={palette}
              isDark={isDark}
            />
            <ActionChip
              label="Reload"
              icon={RefreshCw}
              onPress={() => {
                setReloadKey((value) => value + 1)
                setStatus("loading")
                void triggerHaptic("selection")
              }}
              palette={palette}
              isDark={isDark}
            />
            {preview.viewerUrl || preview.url ? (
              <ActionChip
                label="Browser"
                icon={ExternalLink}
                accent
                onPress={() => void openPreviewExternally(preview.viewerUrl ?? preview.url!)}
                palette={palette}
                isDark={isDark}
              />
            ) : null}
          </View>
        </>
      ) : null}
    </ActionSheet>
  )
})

function ActionChip(props: {
  label: string
  icon: typeof Code2
  onPress(): void
  palette: ReturnType<typeof useAppTheme>["palette"]
  isDark: boolean
  accent?: boolean
}) {
  const Icon = props.icon
  const press = usePressAnimation()
  return (
    <Animated.View style={{ flex: 1, transform: [{ scale: press.scale }] }}>
      <Pressable
        onPress={props.onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={props.label}
        style={({ pressed }) => ({
          alignSelf: "stretch",
          borderRadius: 12,
          borderCurve: "continuous",
          borderWidth: props.accent ? 0 : StyleSheet.hairlineWidth,
          borderColor: props.isDark ? hexToRgba(props.palette.ink, 0.12) : hexToRgba(props.palette.border, 0.85),
          backgroundColor: props.accent ? props.palette.ink : hexToRgba(props.palette.ink, props.isDark ? 0.06 : 0.05),
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <View
          style={{
            minHeight: 44,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            paddingHorizontal: 8,
          }}
        >
          <Icon size={14} color={props.accent ? props.palette.background : props.palette.ink} strokeWidth={2.2} />
          <Text
            numberOfLines={1}
            style={{
              color: props.accent ? props.palette.background : props.palette.ink,
              fontSize: 12.5,
              fontWeight: props.accent ? "800" : "700",
            }}
          >
            {props.label}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  )
}

function PreviewCard(props: {
  preview: SessionPreview
  reloadKey: number
  status: "loading" | "ready" | "failed"
  isDark: boolean
  palette: ReturnType<typeof useAppTheme>["palette"]
  onLoadStart(): void
  onLoad(): void
  onError(): void
  onReload(): void
  onOpen?(): void
}) {
  const cardPress = usePressAnimation()
  const reloadPress = usePressAnimation()
  const browserPress = usePressAnimation()
  const status = statusTone(props.status, props.palette)
  const subtitle =
    props.preview.kind === "url" && props.preview.url ? labelForUrl(props.preview.url) : props.preview.title
  const browserUrl = props.preview.viewerUrl ?? (props.preview.kind === "url" ? props.preview.url : undefined)
  const detail = artifactDetail(props.preview)

  return (
    <View
      style={{
        width: 286,
        overflow: "hidden",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: props.isDark ? hexToRgba(props.palette.ink, 0.1) : hexToRgba(props.palette.border, 0.86),
        backgroundColor: props.isDark ? "rgba(255,255,255,0.045)" : "rgba(255,255,255,0.86)",
      }}
    >
      <Animated.View style={{ transform: [{ scale: cardPress.scale }] }}>
        <Pressable
          onPress={() => {
            void triggerHaptic("selection")
            props.onOpen?.()
          }}
          onPressIn={cardPress.onPressIn}
          onPressOut={cardPress.onPressOut}
          accessibilityRole="button"
          accessibilityLabel={`Open ${kindLabel(props.preview.kind)} preview`}
          style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1 })}
        >
          <View
            style={{
              height: 168,
              overflow: "hidden",
              backgroundColor: props.palette.surfaceMuted,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: hexToRgba(props.palette.ink, 0.08),
            }}
          >
            <PreviewViewport
              preview={props.preview}
              reloadKey={props.reloadKey}
              isDark={props.isDark}
              onLoadStart={props.onLoadStart}
              onLoad={props.onLoad}
              onError={props.onError}
            />
            {props.status !== "ready" ? (
              <View
                pointerEvents="none"
                style={[
                  StyleSheet.absoluteFill,
                  {
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    paddingHorizontal: 18,
                    backgroundColor: props.isDark ? "rgba(8,8,8,0.76)" : "rgba(248,250,252,0.84)",
                  },
                ]}
              >
                {props.status === "loading" ? <ActivityIndicator color={props.palette.accentLight} /> : null}
                <Text style={{ color: props.palette.ink, fontSize: 12, fontWeight: "800", textAlign: "center" }}>
                  {props.status === "failed" ? "Can't load preview" : "Loading…"}
                </Text>
                <Text numberOfLines={1} style={{ color: props.palette.muted, fontSize: 10, textAlign: "center" }}>
                  {subtitle}
                </Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      </Animated.View>

      <View style={{ padding: 12, gap: 10 }}>
        <View style={{ minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              {kindIcon(props.preview.kind, props.palette.accentLight)}
              <Text
                style={{
                  color: props.palette.accentLight,
                  fontSize: 10,
                  fontWeight: "800",
                  textTransform: "uppercase",
                }}
              >
                {props.preview.kind === "url" ? sourceLabel(props.preview.source) : kindLabel(props.preview.kind)}
              </Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <View style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: status.color }} />
              <Text style={{ color: status.color, fontSize: 10, fontWeight: "800" }}>{status.label}</Text>
            </View>
          </View>
          <Text numberOfLines={1} style={{ marginTop: 3, color: props.palette.ink, fontSize: 13, fontWeight: "800" }}>
            {subtitle}
          </Text>
          {detail ? (
            <Text
              numberOfLines={1}
              style={{ marginTop: 3, color: props.palette.muted, fontSize: 10, fontWeight: "600" }}
            >
              {detail}
            </Text>
          ) : null}
        </View>

        <View style={{ flexDirection: "row", gap: 8 }}>
          <Animated.View style={{ flex: 1, transform: [{ scale: reloadPress.scale }] }}>
            <Pressable
              onPress={() => {
                props.onReload()
                void triggerHaptic("selection")
              }}
              onPressIn={reloadPress.onPressIn}
              onPressOut={reloadPress.onPressOut}
              accessibilityRole="button"
              accessibilityLabel="Reload this preview"
              style={({ pressed }) => ({
                borderRadius: 12,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: props.isDark ? hexToRgba(props.palette.ink, 0.1) : hexToRgba(props.palette.border, 0.72),
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View
                style={{
                  minHeight: 44,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <RefreshCw size={13} color={props.palette.ink} strokeWidth={2.2} />
                <Text style={{ color: props.palette.ink, fontSize: 12, fontWeight: "700" }}>Reload</Text>
              </View>
            </Pressable>
          </Animated.View>
          <Animated.View style={{ flex: 1, transform: [{ scale: browserPress.scale }] }}>
            <Pressable
              onPress={() => {
                if (browserUrl) {
                  void openPreviewExternally(browserUrl)
                  return
                }
                props.onOpen?.()
              }}
              onPressIn={browserPress.onPressIn}
              onPressOut={browserPress.onPressOut}
              accessibilityRole="button"
              accessibilityLabel={browserUrl ? "Open in browser" : "Open full preview"}
              style={({ pressed }) => ({
                borderRadius: 12,
                borderCurve: "continuous",
                backgroundColor: hexToRgba(props.palette.ink, 0.1),
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View
                style={{
                  minHeight: 44,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <ExternalLink size={13} color={props.palette.accentLight} strokeWidth={2.2} />
                <Text style={{ color: props.palette.accentLight, fontSize: 12, fontWeight: "800" }}>
                  {browserUrl ? "Browser" : "Open"}
                </Text>
              </View>
            </Pressable>
          </Animated.View>
        </View>
      </View>
    </View>
  )
}
