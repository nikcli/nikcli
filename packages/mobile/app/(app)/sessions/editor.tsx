import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { router, useLocalSearchParams } from "expo-router"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { CaseSensitive } from "lucide-react-native"
import * as Clipboard from "expo-clipboard"
import * as SecureStore from "expo-secure-store"
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Ellipsis,
  Eye,
  Pencil,
  Save,
  Search,
  X,
} from "lucide-react-native"
import { AdaptiveBlur } from "@/components/GlassView"
import { ActionSheet, ActionSheetDivider, ActionSheetItem, useActionSheetRef } from "@/components/BottomSheet"
import { SkeletonBox } from "@/components/Skeleton"
import { ActionButton } from "@/components/ui/ActionButton"
import { EmptyState } from "@/components/ui/EmptyState"
import { EditorBreadcrumb } from "@/components/editor/EditorBreadcrumb"
import { FileSearchSheet } from "@/components/editor/FileSearchSheet"
import { GitFileStatusBadge } from "@/components/git/GitFileStatusBadge"
import { useCopiedFeedback } from "@/hooks/use-copied-feedback"
import { useServer } from "@/lib/server-context"
import { hexToRgba, useAppTheme, type ThemeColors } from "@/lib/theme"
import { triggerHaptic } from "@/lib/haptics"
import { detectLanguage, highlightCode, DRACULA, type Segment } from "@/lib/syntax"
import { PRESS_SPRING } from "@/lib/animation"
import { type as typeStyle } from "@/lib/typography"
import { useEditorStore } from "@/lib/useEditorStore"
import type { FileNode } from "@/lib/types"

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace"
const LINE_HEIGHT = 18
const FONT_SIZE = 12.5
const RECENT_SEARCHES_KEY = "editor_recent_searches"
const MAX_RECENT_SEARCHES = 5
const LARGE_FILE_CHAR_LIMIT = 250_000
const LARGE_FILE_LINE_LIMIT = 5_000

function lightSyntax(palette: ThemeColors): Record<string, string> {
  return {
    [DRACULA.keyword]: palette.accent,
    [DRACULA.string]: palette.success,
    [DRACULA.comment]: palette.muted,
    [DRACULA.builtin]: palette.warn,
    [DRACULA.number]: palette.accentLight,
    [DRACULA.operator]: palette.soft,
    [DRACULA.foreground]: palette.ink,
    [DRACULA.muted]: palette.muted,
  }
}

export default function EditorScreen() {
  const { palette, isDark } = useAppTheme()
  const { top, bottom } = useSafeAreaInsets()
  const { sessionId, filePath, absolute, directory, highlightLine } = useLocalSearchParams<{
    sessionId: string
    filePath: string
    absolute: string
    directory: string
    highlightLine?: string
  }>()
  const { client } = useServer()
  const { openFile, updateContent, markSaved, openFiles } = useEditorStore()

  const [mode, setMode] = useState<"view" | "edit">("view")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, markCopied] = useCopiedFeedback(1500)
  const [savedFeedback, setSavedFeedback] = useState(false)
  const [gitStatus, setGitStatus] = useState<FileNode["gitStatus"]>()
  const [findOpen, setFindOpen] = useState(false)
  const [fileSearchOpen, setFileSearchOpen] = useState(false)
  const [findQuery, setFindQuery] = useState("")
  const [activeFindIndex, setActiveFindIndex] = useState(0)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [recentSearches, setRecentSearches] = useState<string[]>([])

  const stored = absolute ? openFiles[absolute] : undefined
  const content = stored?.content ?? ""
  const dirty = stored?.dirty ?? false

  const targetLine = highlightLine ? parseInt(highlightLine, 10) : undefined
  const scrollRef = useRef<ScrollView>(null)
  const editInputRef = useRef<TextInput>(null)

  // ── Animation refs ─────────────────────────────────────────────
  const unsavedSheetRef = useActionSheetRef()
  const toolsSheetRef = useActionSheetRef()
  const findBarAnimRef = useRef<Animated.Value | null>(null)
  if (findBarAnimRef.current === null) findBarAnimRef.current = new Animated.Value(0)
  const findBarAnim = findBarAnimRef.current
  const backScaleRef = useRef<Animated.Value | null>(null)
  if (backScaleRef.current === null) backScaleRef.current = new Animated.Value(1)
  const backScale = backScaleRef.current
  const findScaleRef = useRef<Animated.Value | null>(null)
  if (findScaleRef.current === null) findScaleRef.current = new Animated.Value(1)
  const findScale = findScaleRef.current
  const modeScaleRef = useRef<Animated.Value | null>(null)
  if (modeScaleRef.current === null) modeScaleRef.current = new Animated.Value(1)
  const modeScale = modeScaleRef.current
  const moreScaleRef = useRef<Animated.Value | null>(null)
  if (moreScaleRef.current === null) moreScaleRef.current = new Animated.Value(1)
  const moreScale = moreScaleRef.current
  const saveScaleRef = useRef<Animated.Value | null>(null)
  if (saveScaleRef.current === null) saveScaleRef.current = new Animated.Value(1)
  const saveScale = saveScaleRef.current
  // Local toggle animation with useNativeDriver:false for color interpolation
  const modeProgressRef = useRef<Animated.Value | null>(null)
  if (modeProgressRef.current === null) modeProgressRef.current = new Animated.Value(mode === "edit" ? 1 : 0)
  const modeProgress = modeProgressRef.current
  useEffect(() => {
    Animated.spring(modeProgress, {
      toValue: mode === "edit" ? 1 : 0,
      damping: 18,
      stiffness: 200,
      mass: 0.5,
      useNativeDriver: false,
    }).start()
  }, [mode, modeProgress])

  const filename = useMemo(() => (filePath ?? "").split("/").pop() ?? "file", [filePath])
  const breadcrumbSegments = useMemo(() => {
    if (!filePath || !directory) return []
    const rel = filePath.replace(directory.replace(/\/$/, ""), "").replace(/^\//, "")
    return rel.split("/").filter(Boolean)
  }, [filePath, directory])

  const language = useMemo(() => detectLanguage(filename), [filename])
  const findMatches = useMemo(() => {
    const query = findQuery.trim()
    if (!query) return []
    const lines = content.split("\n")
    const matches: Array<{ line: string; lineNumber: number }> = []
    if (caseSensitive) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(query)) matches.push({ line: lines[i], lineNumber: i + 1 })
      }
      return matches
    }
    const lowerQuery = query.toLowerCase()
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lowerQuery)) matches.push({ line: lines[i], lineNumber: i + 1 })
    }
    return matches
  }, [content, findQuery, caseSensitive])
  const activeFindLine = findMatches[activeFindIndex]?.lineNumber

  const charCount = useMemo(() => content.length, [content])
  const wordCount = useMemo(() => (content.trim() ? content.trim().split(/\s+/).length : 0), [content])
  const lineCount = useMemo(() => content.split("\n").length, [content])
  const isLargeFile = content.length > LARGE_FILE_CHAR_LIMIT || lineCount > LARGE_FILE_LINE_LIMIT

  // Find bar toggle animation
  useEffect(() => {
    Animated.spring(findBarAnim, {
      toValue: findOpen ? 1 : 0,
      damping: 20,
      stiffness: 260,
      mass: 0.7,
      useNativeDriver: true,
    }).start()
  }, [findOpen, findBarAnim])

  const load = useCallback(async () => {
    if (!client || !absolute) return
    try {
      setLoading(true)
      setError(null)
      const scopedClient = directory ? client.withDirectory(directory) : client
      const [file, gitState] = await Promise.all([
        stored ? Promise.resolve(null) : scopedClient.readFile(absolute),
        scopedClient.getGitStatus().catch(() => null),
      ])
      if (file && file.type === "text") {
        openFile({
          path: filePath ?? absolute,
          absolute,
          content: file.content,
        })
      }
      if (gitState) {
        const all = [...(gitState.staged ?? []), ...(gitState.unstaged ?? [])]
        const entry = all.find((f) => f.path === filePath || f.path === absolute)
        if (entry) {
          setGitStatus(entry.status === "added" ? "added" : entry.status === "deleted" ? "deleted" : "modified")
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [absolute, client, directory, filePath, openFile, stored])

  useEffect(() => {
    void load()
    void (async () => {
      try {
        const storedSearches = await SecureStore.getItemAsync(RECENT_SEARCHES_KEY)
        if (storedSearches) {
          const parsed = JSON.parse(storedSearches)
          if (Array.isArray(parsed)) setRecentSearches(parsed)
        }
      } catch {
        // ignore
      }
    })()
  }, [load])

  // Scroll to highlighted line
  useEffect(() => {
    if (!loading && targetLine && targetLine > 1) {
      let innerFrame = 0
      const outerFrame = requestAnimationFrame(() => {
        innerFrame = requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({
            y: (targetLine - 1) * LINE_HEIGHT,
            animated: true,
          })
        })
      })
      return () => {
        cancelAnimationFrame(outerFrame)
        if (innerFrame) cancelAnimationFrame(innerFrame)
      }
    }
    return undefined
  }, [loading, targetLine])

  const handleFindQueryChange = useCallback((next: string) => {
    setFindQuery(next)
    setActiveFindIndex(0)
  }, [])

  function saveRecentSearch(query: string) {
    if (!query.trim()) return
    setRecentSearches((prev) => {
      const updated = [query, ...prev.filter((s) => s !== query)].slice(0, MAX_RECENT_SEARCHES)
      void SecureStore.setItemAsync(RECENT_SEARCHES_KEY, JSON.stringify(updated))
      return updated
    })
  }

  useEffect(() => {
    if (!loading && activeFindLine) {
      scrollRef.current?.scrollTo({
        y: Math.max(0, (activeFindLine - 2) * LINE_HEIGHT),
        animated: true,
      })
    }
  }, [activeFindLine, loading])

  function moveFind(delta: number) {
    if (!findMatches.length) return
    void triggerHaptic("selection")
    setActiveFindIndex((index) => (index + delta + findMatches.length) % findMatches.length)
  }

  function openFind() {
    void triggerHaptic("selection")
    setFindOpen(true)
    if (findQuery.trim()) {
      saveRecentSearch(findQuery)
    }
  }

  function openWorkspaceSearch() {
    void triggerHaptic("selection")
    setFileSearchOpen(true)
  }

  function openSearchResult(file: string, line: number) {
    const nextAbsolute = file.startsWith("/") ? file : directory ? `${directory.replace(/\/$/, "")}/${file}` : file
    router.push({
      pathname: "/sessions/editor" as never,
      params: {
        sessionId,
        filePath: file,
        absolute: nextAbsolute,
        directory: directory ?? "",
        highlightLine: String(line),
      },
    })
  }

  async function save(): Promise<boolean> {
    if (!client || !absolute) return false
    try {
      setSaving(true)
      setSavedFeedback(false)
      const scopedClient = directory ? client.withDirectory(directory) : client
      await scopedClient.writeFile(absolute, content)
      markSaved(absolute)
      setSavedFeedback(true)
      void triggerHaptic("success")
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      void triggerHaptic("error")
      return false
    } finally {
      setSaving(false)
    }
  }

  function handleBack() {
    if (dirty) {
      unsavedSheetRef.current?.present()
      return
    }
    router.back()
  }

  async function copyContent() {
    await Clipboard.setStringAsync(content)
    markCopied()
    void triggerHaptic("selection")
  }

  // Syntax-highlighted view with light-mode color remapping, grouped by line
  const highlightedLines = useMemo(() => {
    if (mode !== "view" || !content || isLargeFile) return null
    const segments = highlightCode(content)
    const syntax = isDark ? null : lightSyntax(palette)
    const mapped = syntax
      ? segments.map((seg) => ({
          text: seg.text,
          color: syntax[seg.color] ?? seg.color,
        }))
      : segments
    // Split into lines for performant rendering (avoids thousands of nested Text children)
    const lines: Array<Segment[]> = []
    let current: Segment[] = []
    for (const seg of mapped) {
      const parts = seg.text.split("\n")
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          lines.push(current)
          current = []
        }
        if (parts[i]) current.push({ ...seg, text: parts[i] })
      }
    }
    if (current.length || content.endsWith("\n")) lines.push(current)
    return lines
  }, [mode, content, isDark, isLargeFile, palette])

  // Line numbers
  const lineNumbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1), [lineCount])

  // ── Shared chrome button style ─────────────────────────────────
  const chromeButtonBase = {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderCurve: "continuous" as const,
    borderWidth: 1,
    borderColor: isDark ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.82)",
    backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.58)",
    overflow: "hidden" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  }

  function renderChromeButton(
    scale: Animated.Value,
    icon: React.ReactNode,
    onPress: () => void,
    opts?: {
      active?: boolean
      activeBg?: string
      activeBorder?: string
      label?: string
    },
  ) {
    return (
      <ChromeButton
        scale={scale}
        icon={icon}
        onPress={onPress}
        active={opts?.active ?? false}
        activeBg={opts?.activeBg ?? hexToRgba(palette.ink, isDark ? 0.15 : 0.1)}
        activeBorder={opts?.activeBorder ?? palette.accent}
        label={opts?.label}
        isDark={isDark}
        palette={palette}
        chromeButtonBase={chromeButtonBase}
      />
    )
  }

  // ── Line number renderer with accent pill ──────────────────────
  function renderLineNumbers(nums: number[], highlights: (number | undefined)[]) {
    return (
      <LineNumbers
        nums={nums}
        highlights={highlights}
        isDark={isDark}
        palette={palette}
        fontSize={FONT_SIZE}
        lineHeight={LINE_HEIGHT}
        fontFamily={MONO}
      />
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      {/* ── Header with glass treatment ── */}
      <View
        style={{
          paddingTop: top + 8,
          paddingBottom: 10,
          paddingHorizontal: 16,
          overflow: "hidden",
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: isDark ? hexToRgba(palette.ink, 0.07) : hexToRgba(palette.border, 0.8),
        }}
      >
        {/* Layer 1: Full-width glass background */}
        <AdaptiveBlur
          tint={isDark ? "dark" : "light"}
          intensity={isDark ? 90 : 80}
          style={StyleSheet.absoluteFill}
          fallbackColor={isDark ? "rgba(17,17,17,0.85)" : "rgba(247,246,242,0.80)"}
          pointerEvents="none"
        />
        {/* Layer 2: Semi-transparent overlay */}
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: isDark ? "rgba(0,0,0,0.32)" : "rgba(247,246,242,0.22)",
            },
          ]}
          pointerEvents="none"
        />

        {/* Inner glass card */}
        <View
          style={{
            overflow: "hidden",
            borderRadius: 20,
            borderWidth: 1,
            borderColor: isDark ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.80)",
            padding: 12,
          }}
        >
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor: isDark ? "rgba(24,24,24,0.72)" : "rgba(255,255,255,0.68)",
              },
            ]}
            pointerEvents="none"
          />

          {/* Bottom gradient */}
          <View
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: 24,
              backgroundColor: isDark ? "rgba(255,255,255,0.015)" : "rgba(239,237,232,0.14)",
            }}
            pointerEvents="none"
          />

          {/* ── Top row: back, breadcrumb, actions ── */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {renderChromeButton(backScale, <ArrowLeft size={16} color={palette.ink} strokeWidth={2.2} />, handleBack, {
              label: "Go back",
            })}

            {/* Breadcrumb with git status */}
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <EditorBreadcrumb
                  rootLabel={(directory ?? "").split("/").pop() ?? "root"}
                  segments={breadcrumbSegments}
                  onSegmentPress={(index) => {
                    if (index < breadcrumbSegments.length - 1) router.back()
                  }}
                />
                {gitStatus && <GitFileStatusBadge status={gitStatus} compact />}
              </View>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 3,
                }}
              >
                <View
                  style={{
                    borderRadius: 5,
                    backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)",
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 9,
                      fontWeight: "700",
                      letterSpacing: 0.6,
                      color: palette.muted,
                      textTransform: "uppercase",
                    }}
                  >
                    {language}
                  </Text>
                </View>
                <Text
                  style={{
                    fontSize: 11,
                    color: palette.muted,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {lineCount}L · {charCount}C
                </Text>
              </View>
            </View>

            {/* Action buttons */}
            <View style={{ flexDirection: "row", gap: 8 }}>
              {renderChromeButton(
                findScale,
                <Search size={16} color={findOpen ? palette.accentLight : palette.ink} strokeWidth={2} />,
                openFind,
                { active: findOpen, label: "Find in file" },
              )}
              {renderChromeButton(
                moreScale,
                <Ellipsis size={18} color={palette.ink} strokeWidth={2.2} />,
                () => toolsSheetRef.current?.present(),
                { active: wordWrap || copied, label: "More editor actions" },
              )}

              {/* View / Edit toggle with animated colors */}
              <Animated.View style={{ transform: [{ scale: modeScale }] }}>
                <Pressable
                  onPress={() => {
                    void triggerHaptic("selection")
                    if (isLargeFile && mode === "view") return
                    const nextMode = mode === "view" ? "edit" : "view"
                    setMode(nextMode)
                    if (nextMode === "edit") requestAnimationFrame(() => editInputRef.current?.focus())
                  }}
                  onPressIn={() =>
                    Animated.spring(modeScale, {
                      toValue: 0.93,
                      ...PRESS_SPRING,
                    }).start()
                  }
                  onPressOut={() =>
                    Animated.spring(modeScale, {
                      toValue: 1,
                      ...PRESS_SPRING,
                    }).start()
                  }
                  accessibilityRole="button"
                  accessibilityLabel={mode === "view" ? "Switch to edit mode" : "Switch to view mode"}
                >
                  <Animated.View
                    style={{
                      width: 44,
                      height: 44,
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 12,
                      borderCurve: "continuous",
                      borderWidth: 1,
                      overflow: "hidden",
                      borderColor: modeProgress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [
                          isDark ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.82)",
                          hexToRgba(palette.ink, isDark ? 0.45 : 0.35),
                        ],
                      }),
                      backgroundColor: modeProgress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [
                          isDark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.58)",
                          hexToRgba(palette.ink, isDark ? 0.12 : 0.1),
                        ],
                      }),
                    }}
                  >
                    {mode === "view" ? (
                      <Pencil size={16} color={isLargeFile ? palette.muted : palette.ink} strokeWidth={2} />
                    ) : (
                      <Eye size={16} color={palette.accentLight} strokeWidth={2} />
                    )}
                  </Animated.View>
                </Pressable>
              </Animated.View>
            </View>
          </View>

          {/* ── Find bar (animated) ── */}
          {findOpen ? (
            <Animated.View
              style={{
                opacity: findBarAnim,
                transform: [
                  {
                    translateY: findBarAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-12, 0],
                    }),
                  },
                ],
                marginTop: 10,
              }}
              pointerEvents="auto"
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: isDark ? hexToRgba(palette.ink, 0.1) : hexToRgba(palette.border, 0.65),
                  overflow: "hidden",
                  paddingHorizontal: 12,
                  paddingVertical: 9,
                }}
              >
                <AdaptiveBlur
                  tint={isDark ? "dark" : "light"}
                  intensity={40}
                  style={StyleSheet.absoluteFill}
                  fallbackColor={isDark ? "rgba(20,20,20,0.92)" : "rgba(255,255,255,0.92)"}
                  pointerEvents="none"
                />
                <View
                  style={[
                    StyleSheet.absoluteFill,
                    {
                      backgroundColor: isDark ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.15)",
                    },
                  ]}
                  pointerEvents="none"
                />
                <Pressable
                  onPress={() => setCaseSensitive((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel="Case-sensitive search"
                  accessibilityState={{ selected: caseSensitive }}
                  hitSlop={8}
                  style={{ padding: 4 }}
                >
                  <CaseSensitive size={14} color={caseSensitive ? palette.accent : palette.muted} strokeWidth={2.1} />
                </Pressable>
                <Search size={14} color={palette.muted} strokeWidth={2.1} />
                <TextInput
                  value={findQuery}
                  onChangeText={handleFindQueryChange}
                  placeholder="Find in current file"
                  placeholderTextColor={palette.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardAppearance={isDark ? "dark" : "light"}
                  onSubmitEditing={() => saveRecentSearch(findQuery)}
                  style={{
                    flex: 1,
                    color: palette.ink,
                    fontSize: 13,
                    fontFamily: MONO,
                    paddingVertical: 0,
                  }}
                />
                <Text
                  style={{
                    color: palette.muted,
                    fontSize: 11,
                    fontWeight: "700",
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {findMatches.length ? `${activeFindIndex + 1}/${findMatches.length}` : "0/0"}
                </Text>
                <Pressable
                  onPress={() => moveFind(-1)}
                  disabled={!findMatches.length}
                  accessibilityRole="button"
                  accessibilityLabel="Previous match"
                  accessibilityState={{ disabled: !findMatches.length }}
                  hitSlop={8}
                >
                  <ChevronUp size={15} color={findMatches.length ? palette.ink : palette.muted} strokeWidth={2.3} />
                </Pressable>
                <Pressable
                  onPress={() => moveFind(1)}
                  disabled={!findMatches.length}
                  accessibilityRole="button"
                  accessibilityLabel="Next match"
                  accessibilityState={{ disabled: !findMatches.length }}
                  hitSlop={8}
                >
                  <ChevronDown size={15} color={findMatches.length ? palette.ink : palette.muted} strokeWidth={2.3} />
                </Pressable>
                <Pressable
                  onPress={() => {
                    handleFindQueryChange("")
                    setFindOpen(false)
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Close find"
                  hitSlop={8}
                >
                  <X size={15} color={palette.muted} strokeWidth={2.3} />
                </Pressable>
              </View>
            </Animated.View>
          ) : null}
        </View>
      </View>

      {/* ── Body ── */}
      <View style={{ flex: 1 }}>
        {loading ? (
          <View style={{ flex: 1, flexDirection: "row" }}>
            <View
              style={{
                paddingTop: 14,
                paddingHorizontal: 10,
                alignItems: "flex-end",
                backgroundColor: isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)",
                borderRightWidth: StyleSheet.hairlineWidth,
                borderRightColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
                minWidth: 42,
                gap: 6,
              }}
            >
              {Array.from({ length: 18 }).map((_, i) => (
                <SkeletonBox key={i} width={i < 9 ? 8 : 16} height={FONT_SIZE} borderRadius={3} />
              ))}
            </View>
            <View style={{ flex: 1, paddingTop: 14, paddingHorizontal: 14, gap: 6 }}>
              {Array.from({ length: 18 }).map((_, i) => {
                const widths = [72, 85, 55, 45, 62, 90, 40, 78, 68, 50, 82, 38, 70, 58, 88, 42, 75, 60]
                return (
                  <SkeletonBox
                    key={i}
                    width={`${widths[i]}%`}
                    height={FONT_SIZE}
                    borderRadius={3}
                    style={{ marginLeft: i % 3 === 0 ? 24 : 0 }}
                  />
                )
              })}
            </View>
          </View>
        ) : error ? (
          <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 24 }}>
            <EmptyState
              title="Couldn’t open file"
              description={error}
              action={<ActionButton label="Retry" variant="secondary" onPress={() => void load()} />}
            />
          </View>
        ) : mode === "view" ? (
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 64 }}
            horizontal={false}
          >
            {isLargeFile ? (
              <View
                style={{
                  margin: 12,
                  padding: 12,
                  borderRadius: 8,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: hexToRgba(palette.warn, 0.28),
                  backgroundColor: hexToRgba(palette.warn, 0.1),
                }}
              >
                <Text
                  style={{
                    color: palette.warn,
                    fontSize: 12,
                    fontWeight: "700",
                  }}
                >
                  Large file mode
                </Text>
                <Text selectable style={{ color: palette.muted, fontSize: 11, marginTop: 3 }}>
                  Syntax highlighting and editing are disabled for files over {LARGE_FILE_LINE_LIMIT.toLocaleString()}{" "}
                  lines or {LARGE_FILE_CHAR_LIMIT.toLocaleString()} characters.
                </Text>
              </View>
            ) : null}
            <ScrollView horizontal={!wordWrap} scrollEnabled={!wordWrap} showsHorizontalScrollIndicator={!wordWrap}>
              <View style={{ flexDirection: "row", minWidth: "100%" }}>
                {renderLineNumbers(lineNumbers, [targetLine, activeFindLine])}
                <View
                  style={{
                    flex: wordWrap ? 1 : undefined,
                    minWidth: 0,
                    paddingTop: 14,
                    paddingHorizontal: 14,
                  }}
                >
                  {isLargeFile ? (
                    <Text
                      selectable
                      style={{
                        fontFamily: MONO,
                        fontSize: FONT_SIZE,
                        lineHeight: LINE_HEIGHT,
                        color: palette.ink,
                      }}
                    >
                      {content}
                    </Text>
                  ) : (
                    highlightedLines?.map((lineSegs, lineIndex) => (
                      <Text
                        key={`line-${lineIndex}`}
                        selectable
                        style={{
                          fontFamily: MONO,
                          fontSize: FONT_SIZE,
                          lineHeight: LINE_HEIGHT,
                          flexWrap: wordWrap ? "wrap" : undefined,
                        }}
                      >
                        {lineSegs.map((seg, i) => (
                          <Text key={`${lineIndex}:${i}`} style={{ color: seg.color }}>
                            {seg.text}
                          </Text>
                        ))}
                      </Text>
                    ))
                  )}
                </View>
              </View>
            </ScrollView>
          </ScrollView>
        ) : (
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 80 }}>
              <ScrollView horizontal={!wordWrap} scrollEnabled={!wordWrap} showsHorizontalScrollIndicator={!wordWrap}>
                <View style={{ flexDirection: "row", minWidth: "100%" }}>
                  <View pointerEvents="none">{renderLineNumbers(lineNumbers, [activeFindLine])}</View>
                  <TextInput
                    ref={editInputRef}
                    value={content}
                    onChangeText={(text) => {
                      setSavedFeedback(false)
                      updateContent(absolute, text)
                    }}
                    multiline
                    scrollEnabled={false}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    keyboardAppearance={isDark ? "dark" : "light"}
                    style={{
                      flex: 1,
                      paddingTop: 14,
                      paddingHorizontal: 14,
                      fontFamily: MONO,
                      fontSize: FONT_SIZE,
                      lineHeight: LINE_HEIGHT,
                      color: palette.ink,
                      textAlignVertical: "top",
                      minHeight: lineCount * LINE_HEIGHT + 28,
                    }}
                    selectionColor={palette.accent}
                  />
                </View>
              </ScrollView>
            </ScrollView>
          </KeyboardAvoidingView>
        )}
      </View>

      {/* ── Bottom bar with glass treatment ── */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 10,
          paddingBottom: bottom + 10,
          overflow: "hidden",
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: isDark ? hexToRgba(palette.ink, 0.07) : hexToRgba(palette.border, 0.8),
        }}
      >
        <AdaptiveBlur
          tint={isDark ? "dark" : "light"}
          intensity={isDark ? 80 : 70}
          style={StyleSheet.absoluteFill}
          fallbackColor={isDark ? "rgba(17,17,17,0.85)" : "rgba(247,246,242,0.80)"}
          pointerEvents="none"
        />
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: isDark ? "rgba(0,0,0,0.28)" : "rgba(247,246,242,0.22)",
            },
          ]}
          pointerEvents="none"
        />
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 24,
            backgroundColor: isDark ? "rgba(255,255,255,0.015)" : "rgba(239,237,232,0.14)",
          }}
          pointerEvents="none"
        />

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Text style={{ fontSize: 11, color: palette.muted, fontWeight: "500" }}>
              {lineCount}L · {charCount}C · {wordCount}W
            </Text>
            <Text style={{ fontSize: 11, color: palette.muted, fontWeight: "500" }}>{language}</Text>
            {dirty && (
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: palette.warn,
                }}
              />
            )}
            {!dirty && savedFeedback ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Check size={12} color={palette.success} strokeWidth={2.2} />
                <Text
                  style={{
                    fontSize: 11,
                    color: palette.success,
                    fontWeight: "600",
                  }}
                >
                  Saved
                </Text>
              </View>
            ) : null}
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {dirty && (
              <Animated.View style={{ transform: [{ scale: saveScale }] }}>
                <Pressable
                  onPress={() => void save()}
                  disabled={saving}
                  onPressIn={() => {
                    if (!saving)
                      Animated.spring(saveScale, {
                        toValue: 0.95,
                        ...PRESS_SPRING,
                      }).start()
                  }}
                  onPressOut={() => {
                    Animated.spring(saveScale, {
                      toValue: 1,
                      ...PRESS_SPRING,
                    }).start()
                  }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: hexToRgba(palette.ink, isDark ? 0.35 : 0.25),
                    overflow: "hidden",
                    paddingHorizontal: 14,
                    paddingVertical: 7,
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Save changes"
                >
                  <AdaptiveBlur
                    tint={isDark ? "dark" : "light"}
                    intensity={40}
                    style={StyleSheet.absoluteFill}
                    fallbackColor={hexToRgba(palette.ink, isDark ? 0.15 : 0.1)}
                    pointerEvents="none"
                  />
                  <View
                    style={[
                      StyleSheet.absoluteFill,
                      {
                        backgroundColor: hexToRgba(palette.ink, isDark ? 0.06 : 0.04),
                      },
                    ]}
                    pointerEvents="none"
                  />
                  {saving ? (
                    <ActivityIndicator size="small" color={palette.accentLight} />
                  ) : (
                    <Save size={14} color={palette.accentLight} strokeWidth={2.2} />
                  )}
                  <Text
                    style={{
                      color: palette.accentLight,
                      fontSize: 12,
                      fontWeight: "700",
                    }}
                  >
                    {saving ? "Saving…" : "Save"}
                  </Text>
                </Pressable>
              </Animated.View>
            )}
          </View>
        </View>
      </View>

      <ActionSheet ref={toolsSheetRef} snapPoints={[390]}>
        <View
          style={{
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: palette.border,
            paddingHorizontal: 20,
            paddingBottom: 16,
          }}
        >
          <Text style={{ color: palette.soft, fontSize: 12, fontWeight: "500" }}>Editor actions</Text>
          <Text
            numberOfLines={1}
            style={{
              marginTop: 6,
              color: palette.ink,
              fontSize: 18,
              lineHeight: 24,
              fontWeight: "700",
              letterSpacing: -0.3,
            }}
          >
            {absolute?.split("/").pop() || "Current file"}
          </Text>
          <View
            style={{
              marginTop: 8,
              alignSelf: "flex-start",
              borderRadius: 999,
              borderWidth: 1,
              borderColor: hexToRgba(palette.ink, isDark ? 0.12 : 0.18),
              backgroundColor: hexToRgba(palette.ink, isDark ? 0.08 : 0.09),
              paddingHorizontal: 10,
              paddingVertical: 4,
            }}
          >
            <Text
              style={{
                color: palette.accentLight,
                fontSize: 10,
                fontWeight: "600",
                letterSpacing: 0.3,
              }}
            >
              Choose an action
            </Text>
          </View>
        </View>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
          bounces
        >
          <Text
            style={{
              paddingHorizontal: 20,
              paddingBottom: 4,
              paddingTop: 14,
              color: palette.soft,
              fontSize: 12,
            }}
          >
            Editor
          </Text>
          <ActionSheetItem
            icon="search"
            label="Search workspace files"
            description="Find and open another file"
            onPress={() => toolsSheetRef.current?.dismiss(openWorkspaceSearch)}
          />
          <ActionSheetItem
            icon={wordWrap ? "check" : "wrap"}
            label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
            description={
              wordWrap ? "Allow horizontal scrolling for long lines" : "Keep long lines within the editor width"
            }
            tone={wordWrap ? "success" : "accent"}
            onPress={() =>
              toolsSheetRef.current?.dismiss(() => {
                setWordWrap((value) => !value)
                void triggerHaptic("selection")
              })
            }
          />
          <ActionSheetItem
            icon="copy"
            label={copied ? "Copied file content" : "Copy file content"}
            description={copied ? "The file is ready on the clipboard" : "Copy the full file to the clipboard"}
            tone={copied ? "success" : "neutral"}
            onPress={() => toolsSheetRef.current?.dismiss(() => void copyContent())}
          />
        </ScrollView>
      </ActionSheet>

      {/* ── Unsaved changes ActionSheet ── */}
      <ActionSheet ref={unsavedSheetRef} snapPoints={[260]}>
        <View style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "700",
              color: palette.ink,
              marginBottom: 4,
            }}
          >
            Unsaved changes
          </Text>
          <Text style={{ fontSize: 12, color: palette.soft }}>You have unsaved edits. What would you like to do?</Text>
        </View>
        <ActionSheetDivider />
        <ActionSheetItem
          icon="save"
          label="Save & Leave"
          onPress={() =>
            unsavedSheetRef.current?.dismiss(() => {
              void save().then((saved) => {
                if (saved) router.back()
              })
            })
          }
        />
        <ActionSheetItem
          icon="trash"
          label="Leave without saving"
          destructive
          onPress={() => {
            unsavedSheetRef.current?.dismiss(() => router.back())
          }}
        />
        <ActionSheetItem
          icon="x"
          label="Cancel"
          onPress={() => {
            unsavedSheetRef.current?.dismiss()
          }}
        />
      </ActionSheet>

      <FileSearchSheet visible={fileSearchOpen} onClose={() => setFileSearchOpen(false)} onSelect={openSearchResult} />
    </View>
  )
}

interface ChromeButtonProps {
  scale: Animated.Value
  icon: React.ReactNode
  onPress: () => void
  active: boolean
  activeBg: string
  activeBorder: string
  label?: string
  isDark: boolean
  palette: { accent: string }
  chromeButtonBase: {
    backgroundColor: string
    borderColor: string
    [key: string]: unknown
  }
}

function ChromeButton({
  scale,
  icon,
  onPress,
  active,
  activeBg,
  activeBorder,
  label,
  isDark,
  palette,
  chromeButtonBase,
}: ChromeButtonProps) {
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        onPress={onPress}
        onPressIn={() => Animated.spring(scale, { toValue: 0.97, ...PRESS_SPRING }).start()}
        onPressOut={() => Animated.spring(scale, { toValue: 1, ...PRESS_SPRING }).start()}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{
          ...chromeButtonBase,
          backgroundColor: active ? activeBg : chromeButtonBase.backgroundColor,
          borderColor: active ? activeBorder : chromeButtonBase.borderColor,
        }}
      >
        {icon}
      </Pressable>
    </Animated.View>
  )
}

interface LineNumbersProps {
  nums: number[]
  highlights: Array<number | undefined>
  isDark: boolean
  palette: ThemeColors
  fontSize: number
  lineHeight: number
  fontFamily: string
}

function LineNumbers({ nums, highlights, isDark, palette, fontSize, lineHeight, fontFamily }: LineNumbersProps) {
  return (
    <View
      style={{
        paddingTop: 14,
        paddingHorizontal: 10,
        alignItems: "flex-end",
        backgroundColor: isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)",
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
        minWidth: 42,
      }}
    >
      {nums.map((n) => {
        const isActive = highlights.includes(n)
        return (
          <View
            key={n}
            style={{
              backgroundColor: isActive ? hexToRgba(palette.ink, isDark ? 0.12 : 0.08) : "transparent",
              borderRadius: 4,
              paddingHorizontal: isActive ? 4 : 0,
              marginHorizontal: isActive ? -4 : 0,
            }}
          >
            <Text
              style={{
                fontSize,
                lineHeight,
                fontFamily,
                fontWeight: isActive ? "600" : "400",
                color: isActive ? palette.accentLight : isDark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.25)",
              }}
            >
              {n}
            </Text>
          </View>
        )
      })}
    </View>
  )
}
