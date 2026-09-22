import { useCallback, useEffect, useRef, useState } from "react"
import { useServer } from "@/lib/server-context"
import {
  ActivityIndicator,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { Clock, FileCode2, Hash, Search, X } from "lucide-react-native"
import { hexToRgba, useAppTheme } from "@/lib/theme"
import type { SearchMatch } from "@/lib/types"
import { triggerHaptic } from "@/lib/haptics"
import { AdaptiveBlur } from "@/components/GlassView"
import { EmptyState } from "@/components/ui/EmptyState"
import { SPRING_CONFIG, SPRING_SETTLE, usePrefersReducedMotion } from "@/lib/animation"
import * as SecureStore from "expo-secure-store"

const RECENT_SEARCHES_KEY = "file_search_recent"
const METRICS_ROW_STYLE = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 8,
  flexWrap: "wrap" as const,
}
const MAX_RECENT_SEARCHES = 8

type SearchResult = {
  file: string
  line: number
  text: string
  submatches: Array<{ start: number; end: number }>
}

function parseResults(matches: SearchMatch[]): SearchResult[] {
  const results: SearchResult[] = []
  let currentFile = ""

  for (const m of matches) {
    if (m.type === "begin" && m.data.path?.text) {
      currentFile = m.data.path.text
    } else if (m.type === "match" && m.data.lines?.text && m.data.line_number != null) {
      results.push({
        file: currentFile,
        line: m.data.line_number,
        text: m.data.lines.text.replace(/\n$/, ""),
        submatches: (m.data.submatches ?? []).map((s) => ({
          start: s.start,
          end: s.end,
        })),
      })
    }
  }
  return results
}

function fileName(path: string) {
  return path.split("/").filter(Boolean).pop() || path
}

function parentPath(path: string) {
  const parts = path.split("/").filter(Boolean)
  if (parts.length <= 1) return "Workspace root"
  return parts.slice(Math.max(0, parts.length - 3), -1).join("/")
}

function HighlightedLine({ result, color, matchColor }: { result: SearchResult; color: string; matchColor: string }) {
  if (!result.submatches.length) {
    return (
      <Text
        numberOfLines={2}
        style={{
          fontSize: 12,
          lineHeight: 18,
          color,
          fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
        }}
      >
        {result.text.trimStart()}
      </Text>
    )
  }

  const segments: Array<{ text: string; matched: boolean }> = []
  let cursor = 0
  for (const match of result.submatches) {
    if (match.start > cursor)
      segments.push({
        text: result.text.slice(cursor, match.start),
        matched: false,
      })
    segments.push({
      text: result.text.slice(match.start, match.end),
      matched: true,
    })
    cursor = match.end
  }
  if (cursor < result.text.length) segments.push({ text: result.text.slice(cursor), matched: false })

  return (
    <Text
      numberOfLines={2}
      style={{
        fontSize: 12,
        lineHeight: 18,
        color,
        fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      }}
    >
      {segments.map((segment, index) => (
        <Text
          key={`${index}:${segment.text}`}
          style={
            segment.matched
              ? {
                  color: matchColor,
                  fontWeight: "800",
                  backgroundColor: "rgba(20,20,19,0.14)",
                }
              : undefined
          }
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  )
}

function Metric({ icon, label }: { icon: React.ReactNode; label: string }) {
  const { palette, isDark } = useAppTheme()
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        borderRadius: 999,
        paddingHorizontal: 9,
        paddingVertical: 5,
        backgroundColor: hexToRgba(palette.ink, isDark ? 0.06 : 0.08),
      }}
    >
      {icon}
      <Text style={{ fontSize: 11, fontWeight: "700", color: palette.accentLight }}>{label}</Text>
    </View>
  )
}

function AnimatedResult({ index, children }: { index: number; children: React.ReactNode }) {
  const opacityRef = useRef<Animated.Value | null>(null)
  if (opacityRef.current === null) opacityRef.current = new Animated.Value(0)
  const opacity = opacityRef.current
  const translateYRef = useRef<Animated.Value | null>(null)
  if (translateYRef.current === null) translateYRef.current = new Animated.Value(8)
  const translateY = translateYRef.current

  useEffect(() => {
    Animated.parallel([
      Animated.spring(opacity, {
        toValue: 1,
        ...SPRING_CONFIG,
        delay: index * 30,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        ...SPRING_CONFIG,
        delay: index * 30,
      }),
    ]).start()
  }, [index, opacity, translateY])

  return <Animated.View style={{ opacity, transform: [{ translateY }] }}>{children}</Animated.View>
}

function SearchResultRow({
  result,
  index,
  isDark,
  palette,
  onSelect,
}: {
  result: SearchResult
  index: number
  isDark: boolean
  palette: ReturnType<typeof useAppTheme>["palette"]
  onSelect: (file: string, line: number) => void
}) {
  const pressedBackground = hexToRgba(palette.ink, 0.06)
  const iconBackground = hexToRgba(palette.ink, isDark ? 0.07 : 0.08)
  const borderColor = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)"
  const rowStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => ({
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: pressed ? pressedBackground : "transparent",
      transform: [{ scale: pressed ? 0.98 : 1 }],
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: borderColor,
    }),
    [pressedBackground, borderColor],
  )
  return (
    <AnimatedResult index={index}>
      <Pressable onPress={() => onSelect(result.file, result.line)} style={rowStyle}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
          <View
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: iconBackground,
            }}
          >
            <FileCode2 size={15} color={palette.accentLight} strokeWidth={2.1} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  fontSize: 13,
                  color: palette.ink,
                  fontWeight: "700",
                }}
              >
                {fileName(result.file)}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                <Hash size={10} color={palette.muted} strokeWidth={2.2} />
                <Text
                  style={{
                    fontSize: 11,
                    color: palette.muted,
                    fontWeight: "700",
                  }}
                >
                  {result.line}
                </Text>
              </View>
            </View>
            <Text numberOfLines={1} style={{ fontSize: 11, color: palette.muted }}>
              {parentPath(result.file)}
            </Text>
            <HighlightedLine result={result} color={palette.soft} matchColor={palette.accentLight} />
          </View>
        </View>
      </Pressable>
    </AnimatedResult>
  )
}

export function FileSearchSheet(props: {
  visible: boolean
  onClose(): void
  onSelect(file: string, line: number): void
}) {
  const { palette, isDark } = useAppTheme()
  const prefersReducedMotion = usePrefersReducedMotion()
  const { client } = useServer()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [recentSearches, setRecentSearches] = useState<string[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<TextInput>(null)
  const resultFileCount = new Set(results.map((result) => result.file)).size

  // ── Sheet entrance animation ──
  const translateYRef = useRef<Animated.Value | null>(null)
  if (translateYRef.current === null) translateYRef.current = new Animated.Value(40)
  const translateY = translateYRef.current
  const opacityRef = useRef<Animated.Value | null>(null)
  if (opacityRef.current === null) opacityRef.current = new Animated.Value(0)
  const opacity = opacityRef.current
  const sheetScaleRef = useRef<Animated.Value | null>(null)
  if (sheetScaleRef.current === null) sheetScaleRef.current = new Animated.Value(0.96)
  const sheetScale = sheetScaleRef.current

  useEffect(() => {
    if (props.visible) {
      if (prefersReducedMotion) {
        opacity.setValue(1)
        translateY.setValue(0)
        sheetScale.setValue(1)
      } else {
        Animated.parallel([
          Animated.timing(opacity, {
            toValue: 1,
            duration: 180,
            useNativeDriver: true,
          }),
          Animated.spring(translateY, { toValue: 0, ...SPRING_SETTLE }),
          Animated.spring(sheetScale, { toValue: 1, ...SPRING_SETTLE }),
        ]).start()
      }
      const focusFrame = requestAnimationFrame(() => inputRef.current?.focus())
      void loadRecentSearches()
      return () => cancelAnimationFrame(focusFrame)
    } else {
      opacity.setValue(0)
      translateY.setValue(40)
      sheetScale.setValue(0.96)
      // Resetting the search form when the sheet hides is the intended UX:
      // each open should start from a clean slate. The modal's open/close
      // prop is the source of truth, and the work is not user-visible
      // (it happens during the close animation). This is the standard
      // modal-reset pattern, not state-derived-from-prop duplication.
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setQuery("")
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setResults([])
    }
    return undefined
  }, [opacity, prefersReducedMotion, props.visible, sheetScale, translateY])

  async function loadRecentSearches() {
    try {
      const stored = await SecureStore.getItemAsync(RECENT_SEARCHES_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed)) setRecentSearches(parsed)
      }
    } catch {
      // ignore
    }
  }

  async function saveRecentSearch(q: string) {
    if (!q.trim()) return
    setRecentSearches((prev) => {
      const updated = [q, ...prev.filter((s) => s !== q)].slice(0, MAX_RECENT_SEARCHES)
      void SecureStore.setItemAsync(RECENT_SEARCHES_KEY, JSON.stringify(updated))
      return updated
    })
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim() || !client) {
      setResults([])
      setLoading(false)
      abortRef.current?.abort()
      return
    }
    debounceRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort()
      const controller = new AbortController()
      abortRef.current = controller
      try {
        setLoading(true)
        const raw = await client.searchText(query.trim())
        if (!controller.signal.aborted) {
          setResults(parseResults(raw))
          void saveRecentSearch(query.trim())
        }
      } catch {
        if (!controller.signal.aborted) setResults([])
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      abortRef.current?.abort()
    }
  }, [query, client])

  const handleSelect = useCallback(
    (file: string, line: number) => {
      void triggerHaptic("selection")
      props.onSelect(file, line)
      props.onClose()
    },
    [props],
  )

  const handleRecentPress = useCallback((search: string) => {
    setQuery(search)
    void triggerHaptic("selection")
  }, [])

  const clearRecent = useCallback(async () => {
    setRecentSearches([])
    await SecureStore.deleteItemAsync(RECENT_SEARCHES_KEY)
    void triggerHaptic("selection")
  }, [])

  // A `<Modal visible={false}>` still builds and reconciles its whole subtree on every parent
  // render. This sheet has no exit animation — closing resets the values outright — so there is
  // nothing to keep on screen and it can leave the render path entirely.
  if (!props.visible) return null

  return (
    <Modal visible transparent animationType="none" onRequestClose={props.onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end" }}
      >
        {/* Animated backdrop */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose}>
            <View
              style={{
                flex: 1,
                backgroundColor: isDark ? "rgba(0,0,0,0.65)" : "rgba(20,20,19,0.20)",
              }}
            />
          </Pressable>
        </Animated.View>

        {/* Animated sheet */}
        <Animated.View
          style={{
            maxHeight: "75%",
            opacity,
            transform: [{ translateY }, { scale: sheetScale }],
          }}
        >
          <View
            style={{
              maxHeight: "100%",
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              overflow: "hidden",
              borderWidth: 1,
              borderColor: isDark ? "rgba(255,255,255,0.11)" : "rgba(255,255,255,0.82)",
              shadowColor: isDark ? "#000" : hexToRgba(palette.ink, 0.28),
              shadowOpacity: isDark ? 0.5 : 0.18,
              shadowRadius: 24,
              shadowOffset: { width: 0, height: -8 },
            }}
          >
            {/* Glass fill */}
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              <AdaptiveBlur
                tint={isDark ? "dark" : "light"}
                intensity={isDark ? 90 : 75}
                style={StyleSheet.absoluteFill}
                fallbackColor={hexToRgba(palette.surface, isDark ? 0.85 : 0.82)}
              />
              <View
                style={[
                  StyleSheet.absoluteFill,
                  {
                    backgroundColor: hexToRgba(palette.surface, isDark ? 0.58 : 0.52),
                  },
                ]}
              />
            </View>

            {/* Drag handle */}
            <View style={{ alignItems: "center", paddingTop: 10, paddingBottom: 4 }}>
              <View
                style={{
                  width: 42,
                  height: 5,
                  borderRadius: 999,
                  backgroundColor: isDark ? "rgba(255,255,255,0.20)" : "rgba(0,0,0,0.16)",
                }}
              />
            </View>

            <View
              style={{
                paddingHorizontal: 16,
                paddingTop: 8,
                paddingBottom: 10,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 17,
                      fontWeight: "700",
                      color: palette.ink,
                    }}
                  >
                    Search workspace
                  </Text>
                  <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 12, color: palette.soft }}>
                    Jump to a matching file and line in the active host workspace.
                  </Text>
                </View>
                <Pressable
                  onPress={props.onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Close file search"
                  hitSlop={8}
                  style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: pressed ? 0.65 : 1,
                    backgroundColor: hexToRgba(palette.ink, isDark ? 0.07 : 0.06),
                  })}
                >
                  <X size={16} color={palette.ink} strokeWidth={2.2} />
                </Pressable>
              </View>
            </View>

            {/* Search input */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingHorizontal: 16,
                paddingTop: 0,
                paddingBottom: 12,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
              }}
            >
              <Search size={16} color={palette.muted} strokeWidth={2} />
              <TextInput
                ref={inputRef}
                value={query}
                onChangeText={setQuery}
                placeholder="Search in files…"
                placeholderTextColor={palette.muted}
                style={{
                  flex: 1,
                  fontSize: 15,
                  color: palette.ink,
                  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                }}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                keyboardAppearance={isDark ? "dark" : "light"}
              />
              {loading ? (
                <ActivityIndicator size="small" color={palette.accent} />
              ) : query ? (
                <Pressable
                  onPress={() => setQuery("")}
                  hitSlop={8}
                  style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
                >
                  <X size={15} color={palette.muted} strokeWidth={2} />
                </Pressable>
              ) : null}
            </View>

            {/* Results or Recent Searches */}
            {query.trim() ? (
              <FlatList
                data={results}
                keyExtractor={(item, i) => `${item.file}:${item.line}:${i}`}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: 32 }}
                ListHeaderComponent={
                  loading || results.length > 0 ? (
                    <View
                      style={{
                        paddingHorizontal: 16,
                        paddingVertical: 10,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
                      }}
                    >
                      <View style={METRICS_ROW_STYLE}>
                        <Metric
                          icon={<Search size={12} color={palette.accentLight} strokeWidth={2.1} />}
                          label={loading ? "Searching" : `${results.length} matches`}
                        />
                        <Metric
                          icon={<FileCode2 size={12} color={palette.accentLight} strokeWidth={2.1} />}
                          label={`${resultFileCount} files`}
                        />
                      </View>
                    </View>
                  ) : null
                }
                ListEmptyComponent={
                  !loading && query.trim() ? (
                    <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
                      <EmptyState
                        title="No matches"
                        description="Try a symbol, filename fragment, or exact error text."
                      />
                    </View>
                  ) : null
                }
                renderItem={({ item, index }) => (
                  <SearchResultRow
                    result={item}
                    index={index}
                    isDark={isDark}
                    palette={palette}
                    onSelect={handleSelect}
                  />
                )}
              />
            ) : recentSearches.length > 0 ? (
              <View style={{ paddingBottom: 32 }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
                  }}
                >
                  <Clock size={14} color={palette.muted} strokeWidth={2} />
                  <Text
                    style={{
                      fontSize: 12,
                      color: palette.muted,
                      fontWeight: "600",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    Recent searches
                  </Text>
                  <Pressable onPress={clearRecent} hitSlop={8} style={{ marginLeft: "auto" }}>
                    <Text
                      style={{
                        fontSize: 12,
                        color: palette.accentLight,
                        fontWeight: "500",
                      }}
                    >
                      Clear
                    </Text>
                  </Pressable>
                </View>
                {recentSearches.map((search, index) => (
                  <Pressable
                    key={`${search}-${index}`}
                    onPress={() => handleRecentPress(search)}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      paddingHorizontal: 16,
                      paddingVertical: 10,
                      backgroundColor: pressed ? hexToRgba(palette.ink, 0.05) : "transparent",
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)",
                    })}
                  >
                    <Search size={13} color={palette.muted} strokeWidth={1.8} />
                    <Text
                      numberOfLines={1}
                      style={{
                        flex: 1,
                        fontSize: 13,
                        color: palette.ink,
                        fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                      }}
                    >
                      {search}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
                <EmptyState
                  title="Search every file"
                  description="Start typing to search code, docs, configs, and generated output indexed by the host."
                />
              </View>
            )}
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
