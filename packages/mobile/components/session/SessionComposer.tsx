import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import {
  ArrowUp,
  CircleAlert,
  GitBranch,
  Lock,
  Paperclip,
  Plus,
  Shield,
  Square,
  Terminal,
  X,
} from "lucide-react-native";
import {
  SPRING_CONFIG,
  SPRING_MICRO,
  usePrefersReducedMotion,
} from "@/lib/animation";
import { triggerHaptic } from "@/lib/haptics";
import { hexToRgba, useAppTheme } from "@/lib/theme";
import { AdaptiveBlur } from "@/components/GlassView";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ComposerToolDrawer, type ComposerTab } from "./ComposerToolDrawer";
import type { MobileModelOption } from "@/lib/model-catalog";

export type SessionComposerProps = {
  mode: "plan" | "code";
  setMode(mode: "plan" | "code"): void;
  input: string;
  setInput(value: string): void;
  slashSuggestions?: Array<{
    name: string;
    description?: string;
    badge?: string;
  }>;
  slashLoading?: boolean;
  sending: boolean;
  sessionProcessing?: boolean;
  queuedMessageCount?: number;
  offlineQueuedMessageCount?: number;
  sessionBlocked: boolean;
  cleaned: boolean;
  onOpenCommands(): void;
  onSelectSlash(name: string): void;
  onSend(): void;
  onAttach?(): void;
  onOpenGit?(): void;
  onStop?(): void;
  pendingAttachments?: Array<{
    id: string;
    mime?: string;
    filename?: string;
    base64?: string;
    previewUri?: string;
    sizeLabel?: string;
    uri?: string;
    name?: string;
    type?: string;
  }>;
  onAddAttachment?(item: {
    id: string;
    mime?: string;
    filename?: string;
    base64?: string;
    previewUri?: string;
    sizeLabel?: string;
    uri?: string;
    name?: string;
    type?: string;
  }): void;
  onRemoveAttachment?(id: string): void;
  modelLabel?: string;
  activeModelKey?: string;
  activeVariant?: string;
  activeMcpCount?: number;
  availableModels?: MobileModelOption[];
  skills?: Array<{ name: string; description?: string; category?: string }>;
  tools?: Array<{ name: string; description?: string; enabled: boolean }>;
  mcpServers?: Array<{ name: string; connected: boolean; enabled: boolean }>;
  onModelSelect?(id: string, variant?: string): void;
  onOpenModelPicker?(): void;
  onSkillSelect?(name: string): void;
  onToolToggle?(name: string, enabled: boolean): void;
  onMcpToggle?(name: string, enabled: boolean): void;
  onSkillsManage?(): void;
  onToolsManage?(): void;
  onMcpManage?(): void;
  permissionModeLabel?: string;
  onOpenPermissions?(): void;
  error?: string | null;
  onRetryError?(): void;
  onDismissError?(): void;
};

const CHAR_COUNT_THRESHOLD = 100;
// Each segment width — pill animates between [2, SEGMENT_W + 2]
const SEGMENT_W = 44;
// TextInput line metrics
const INPUT_LINE_HEIGHT = 22;
const INPUT_PADDING_TOP = 14;
const INPUT_PADDING_BOTTOM = 12;
const INPUT_MIN_ROWS = 2;
const INPUT_MAX_ROWS = 6;
const INPUT_MIN_HEIGHT =
  INPUT_PADDING_TOP + INPUT_MIN_ROWS * INPUT_LINE_HEIGHT + INPUT_PADDING_BOTTOM; // 68
const INPUT_MAX_HEIGHT =
  INPUT_PADDING_TOP + INPUT_MAX_ROWS * INPUT_LINE_HEIGHT + INPUT_PADDING_BOTTOM; // 156

// Stable empty defaults so memo() on child components sees the same
// reference across renders and doesn't redraw.
const EMPTY_SLASH_SUGGESTIONS: NonNullable<
  SessionComposerProps["slashSuggestions"]
> = [];
const EMPTY_PENDING_ATTACHMENTS: NonNullable<
  SessionComposerProps["pendingAttachments"]
> = [];
const EMPTY_AVAILABLE_MODELS: NonNullable<
  SessionComposerProps["availableModels"]
> = [];
const EMPTY_SKILLS: NonNullable<SessionComposerProps["skills"]> = [];
const EMPTY_TOOLS: NonNullable<SessionComposerProps["tools"]> = [];
const EMPTY_MCP_SERVERS: NonNullable<SessionComposerProps["mcpServers"]> = [];

export function SessionComposer({
  mode,
  setMode,
  input,
  setInput,
  slashSuggestions = EMPTY_SLASH_SUGGESTIONS,
  slashLoading,
  sending,
  sessionProcessing = false,
  queuedMessageCount = 0,
  offlineQueuedMessageCount = 0,
  sessionBlocked,
  cleaned,
  onOpenCommands,
  onSelectSlash,
  onSend,
  onAttach,
  onOpenGit,
  onStop,
  pendingAttachments = EMPTY_PENDING_ATTACHMENTS,
  onRemoveAttachment,
  modelLabel,
  activeModelKey,
  activeVariant,
  activeMcpCount = 0,
  availableModels = EMPTY_AVAILABLE_MODELS,
  skills = EMPTY_SKILLS,
  tools = EMPTY_TOOLS,
  mcpServers = EMPTY_MCP_SERVERS,
  onModelSelect,
  onOpenModelPicker,
  onSkillSelect,
  onToolToggle,
  onMcpToggle,
  onSkillsManage,
  onToolsManage,
  onMcpManage,
  permissionModeLabel,
  onOpenPermissions,
  error,
  onRetryError,
  onDismissError,
}: SessionComposerProps) {
  const { palette, isDark } = useAppTheme();
  const prefersReducedMotion = usePrefersReducedMotion();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const narrowToolbar = windowWidth < 375;
  const showModelControl = windowWidth >= 375;
  const inputRef = useRef<TextInput>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [activeTab, setActiveTab] = useState<ComposerTab>("tools");

  const sendBlocked = cleaned || !input.trim();
  const sendDisabled = sending || sendBlocked;
  const showSlash = input.trimStart().startsWith("/");
  const hasText = input.trim().length > 0;
  const charCount = input.length;
  const showCharCount = charCount > CHAR_COUNT_THRESHOLD;
  const showProcessingBanner = sessionProcessing && !cleaned;
  const showOfflineBanner = offlineQueuedMessageCount > 0 && !cleaned;
  const showStatus = showProcessingBanner || showOfflineBanner || cleaned;
  const queueOnSend = sessionProcessing && hasText && !sendBlocked;
  const showStop = Boolean(
    onStop && (sessionProcessing || sending) && !hasText,
  );
  const hasAttachments = pendingAttachments.length > 0;

  // ── Animation values ──────────────────────────────────────────────────────

  // Focus: border glow (non-native — drives borderColor interpolation)
  const focusAnimRef = useRef<Animated.Value | null>(null);
  if (focusAnimRef.current === null)
    focusAnimRef.current = new Animated.Value(0);
  const focusAnim = focusAnimRef.current;

  // Send button: color transition (non-native)
  const sendColorAnimRef = useRef<Animated.Value | null>(null);
  if (sendColorAnimRef.current === null)
    sendColorAnimRef.current = new Animated.Value(
      hasText && !sendBlocked ? 1 : 0,
    );
  const sendColorAnim = sendColorAnimRef.current;

  // Send button: scale spring pop (native)
  const sendScaleAnimRef = useRef<Animated.Value | null>(null);
  if (sendScaleAnimRef.current === null)
    sendScaleAnimRef.current = new Animated.Value(1);
  const sendScaleAnim = sendScaleAnimRef.current;

  // Stop button: pulsing scale (native)
  const stopPulseRef = useRef<Animated.Value | null>(null);
  if (stopPulseRef.current === null)
    stopPulseRef.current = new Animated.Value(1);
  const stopPulse = stopPulseRef.current;

  // Mode segmented control: sliding pill (transform, separate from color)
  // The pill transform can run on the UI thread, the segment-label colors
  // can't, so two Animated.Values are kept in sync.
  const modeAnimRef = useRef<Animated.Value | null>(null);
  if (modeAnimRef.current === null)
    modeAnimRef.current = new Animated.Value(mode === "code" ? 1 : 0);
  const modeAnim = modeAnimRef.current;
  const modePosAnimRef = useRef<Animated.Value | null>(null);
  if (modePosAnimRef.current === null)
    modePosAnimRef.current = new Animated.Value(mode === "code" ? 1 : 0);
  const modePosAnim = modePosAnimRef.current;

  // Slash panel: fade + slide (native)
  const slashAnimRef = useRef<Animated.Value | null>(null);
  if (slashAnimRef.current === null)
    slashAnimRef.current = new Animated.Value(0);
  const slashAnim = slashAnimRef.current;

  // Status banner: slide down (native)
  const statusAnimRef = useRef<Animated.Value | null>(null);
  if (statusAnimRef.current === null)
    statusAnimRef.current = new Animated.Value(0);
  const statusAnim = statusAnimRef.current;

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    Animated.timing(focusAnim, {
      toValue: isFocused ? 1 : 0,
      duration: 220,
      useNativeDriver: false,
      easing: Easing.out(Easing.ease),
    }).start();
  }, [isFocused, focusAnim]);

  useEffect(() => {
    const isReady = hasText && !sendBlocked;
    Animated.timing(sendColorAnim, {
      toValue: isReady ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
      easing: Easing.out(Easing.ease),
    }).start();
    if (prefersReducedMotion) {
      sendScaleAnim.setValue(isReady ? 1 : 0.88);
      return;
    }

    if (isReady) {
      Animated.spring(sendScaleAnim, {
        toValue: 1,
        ...SPRING_CONFIG,
      }).start();
    } else {
      Animated.spring(sendScaleAnim, {
        toValue: 0.88,
        ...SPRING_CONFIG,
      }).start();
    }
  }, [
    hasText,
    prefersReducedMotion,
    sendBlocked,
    sendColorAnim,
    sendScaleAnim,
  ]);

  useEffect(() => {
    if (!showStop || prefersReducedMotion) {
      stopPulse.setValue(1);
      return;
    }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(stopPulse, {
          toValue: 1.14,
          duration: 680,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.ease),
        }),
        Animated.timing(stopPulse, {
          toValue: 1,
          duration: 680,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.ease),
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [prefersReducedMotion, showStop, stopPulse]);

  useEffect(() => {
    if (prefersReducedMotion) {
      modeAnim.setValue(mode === "code" ? 1 : 0);
      modePosAnim.setValue(mode === "code" ? 1 : 0);
      return;
    }

    Animated.parallel([
      // Colors for the segment labels must run on JS thread (Animated
      // cannot drive color transforms via the native driver).
      Animated.timing(modeAnim, {
        toValue: mode === "code" ? 1 : 0,
        duration: 200,
        useNativeDriver: false,
        easing: Easing.out(Easing.quad),
      }),
      // The sliding pill uses translateX, which is native-driver friendly.
      // Splitting it out keeps the JS thread idle while the pill animates
      // on the UI thread during typing.
      Animated.timing(modePosAnim, {
        toValue: mode === "code" ? 1 : 0,
        duration: 200,
        useNativeDriver: true,
        easing: Easing.out(Easing.quad),
      }),
    ]).start();
  }, [mode, modeAnim, modePosAnim, prefersReducedMotion]);

  useEffect(() => {
    if (prefersReducedMotion) {
      slashAnim.setValue(showSlash ? 1 : 0);
      return;
    }

    Animated.spring(slashAnim, {
      toValue: showSlash ? 1 : 0,
      ...SPRING_MICRO,
    }).start();
  }, [prefersReducedMotion, showSlash, slashAnim]);

  useEffect(() => {
    if (prefersReducedMotion) {
      statusAnim.setValue(showStatus ? 1 : 0);
      return;
    }

    Animated.spring(statusAnim, {
      toValue: showStatus ? 1 : 0,
      ...SPRING_MICRO,
    }).start();
  }, [prefersReducedMotion, showStatus, statusAnim]);

  // ── Derived animated styles ───────────────────────────────────────────────

  const borderColor = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [palette.border, hexToRgba(palette.ink, 0.28)],
  });

  // Idle: same chrome as the header buttons. With text: fills with ink.
  const sendBackgroundColor = sendColorAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [
      isDark ? "rgba(22,22,22,0.88)" : "rgba(255,255,255,0.88)",
      palette.ink,
    ],
  });
  const sendIconColor =
    hasText && !sendBlocked ? palette.background : palette.muted;

  // Send button matches the circular chrome buttons: surface fill + hairline.

  // Pill slides from left-edge-gap (2) to second segment start (SEGMENT_W + 2).
  // Uses modePosAnim (transform only) so it can run on the UI thread via
  // the native driver. Color interpolation stays on the JS thread via the
  // shared modeAnim.
  const segmentPillLeft = modePosAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [2, SEGMENT_W + 2],
  });

  const segmentLabelPlan = modeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [isDark ? palette.accentLight : palette.accent, palette.muted],
  });

  const segmentLabelCode = modeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [palette.muted, isDark ? palette.accentLight : palette.accent],
  });

  const slashTranslateY = slashAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 0],
  });
  const statusTranslateY = statusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-6, 0],
  });

  // ── Icon button style — bare icons, no chrome (Cursor-style toolbar) ─────
  const iconBtn = useMemo(
    () => ({
      borderRadius: 999,
      backgroundColor: "transparent" as const,
    }),
    [],
  );

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Edge-to-edge Android does not shrink the JS window for the IME, and this
  // screen opts KeyboardAvoidingView out on Android. Lift the composer and drop
  // the gesture-nav inset so the caret is not left in the dead band under the keyboard.
  const keyboardOpen = Platform.OS === "android" && keyboardHeight > 0;

  return (
    <View
      style={{
        backgroundColor: isDark ? palette.surface : palette.background,
        paddingBottom: keyboardOpen ? 8 : Math.max(insets.bottom, 10),
        marginBottom: keyboardOpen ? keyboardHeight : 0,
      }}
    >
      {/* Top hairline separator — intentionally transparent */}
      <View
        style={{
          height: StyleSheet.hairlineWidth,
          backgroundColor: "transparent",
        }}
      />

      {/* Status banner — glass pill, animated slide-down */}

      {error ? (
        <View
          style={{
            marginHorizontal: 14,
            marginBottom: 8,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: hexToRgba(palette.danger, 0.22),
            backgroundColor: hexToRgba(palette.danger, 0.08),
            paddingLeft: 12,
            paddingRight: 6,
            paddingVertical: 8,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
          }}
        >
          <CircleAlert size={13} color={palette.danger} strokeWidth={2.4} />
          <Text
            numberOfLines={2}
            style={{
              flex: 1,
              color: palette.danger,
              fontSize: 11.5,
              lineHeight: 16,
              fontWeight: "600",
            }}
          >
            {error}
          </Text>
          {onRetryError ? (
            <Pressable
              onPress={onRetryError}
              accessibilityRole="button"
              accessibilityLabel="Retry failed action"
              hitSlop={6}
              style={({ pressed }) => ({
                borderRadius: 999,
                borderWidth: 1,
                borderColor: hexToRgba(palette.danger, 0.35),
                paddingHorizontal: 10,
                paddingVertical: 3,
                opacity: pressed ? 0.68 : 1,
                transform: [{ scale: pressed ? 0.96 : 1 }],
              })}
            >
              <Text
                style={{
                  color: palette.danger,
                  fontSize: 10.5,
                  fontWeight: "700",
                }}
              >
                Retry
              </Text>
            </Pressable>
          ) : onDismissError ? (
            <Pressable
              onPress={onDismissError}
              accessibilityRole="button"
              accessibilityLabel="Dismiss error"
              hitSlop={8}
              style={({ pressed }) => ({
                padding: 6,
                opacity: pressed ? 0.55 : 1,
              })}
            >
              <X size={14} color={palette.danger} strokeWidth={2.2} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Processing / cleaned status banner */}
      {showStatus ? (
        <Animated.View
          style={{
            opacity: statusAnim,
            transform: [{ translateY: statusTranslateY }],
            marginHorizontal: 16,
            marginBottom: 8,
          }}
        >
          <View
            style={{
              borderRadius: 14,
              borderWidth: 1,
              borderColor: cleaned
                ? hexToRgba(palette.danger, 0.22)
                : showOfflineBanner
                  ? hexToRgba(palette.warn, 0.22)
                  : isDark
                    ? hexToRgba(palette.ink, 0.1)
                    : hexToRgba(palette.border, 0.72),
              backgroundColor: cleaned
                ? hexToRgba(palette.danger, 0.08)
                : showOfflineBanner
                  ? hexToRgba(palette.warn, 0.1)
                  : isDark
                    ? "rgba(255,255,255,0.045)"
                    : "rgba(255,255,255,0.72)",
              paddingHorizontal: 14,
              paddingVertical: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            {cleaned ? (
              <Lock size={14} color={palette.danger} strokeWidth={2.2} />
            ) : null}
            <Text
              style={{
                flex: 1,
                color: cleaned
                  ? palette.danger
                  : showOfflineBanner
                    ? palette.warn
                    : palette.accentLight,
                fontSize: 12,
                fontWeight: "600",
              }}
            >
              {cleaned
                ? "This worktree was cleaned up"
                : showOfflineBanner
                  ? offlineQueuedMessageCount === 1
                    ? "1 message saved · will send when the server is reachable"
                    : `${offlineQueuedMessageCount} messages saved · will send when the server is reachable`
                  : queuedMessageCount > 0
                    ? `${queuedMessageCount} queued · agent working`
                    : "Agent working · new messages queue automatically"}
            </Text>
          </View>
        </Animated.View>
      ) : null}

      {/* Slash autocomplete — animated fade + slide up */}
      {showSlash && (
        <Animated.View
          style={{
            opacity: slashAnim,
            transform: [{ translateY: slashTranslateY }],
          }}
        >
          {/* Glass surface matching app tab bar language */}
          <View
            style={{
              marginHorizontal: 16,
              marginBottom: 8,
              borderRadius: 22,
              borderCurve: "continuous",
              overflow: "hidden",
              borderWidth: 1,
              borderColor: isDark
                ? "rgba(255,255,255,0.12)"
                : hexToRgba(palette.ink, 0.1),
              shadowColor: palette.shadow,
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: isDark ? 0.24 : 0.1,
              shadowRadius: 20,
            }}
          >
            {/* Glass background */}
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  backgroundColor: hexToRgba(
                    palette.surface,
                    isDark ? 0.94 : 0.96,
                  ),
                },
              ]}
              pointerEvents="none"
            />
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  backgroundColor: isDark
                    ? "rgba(255,255,255,0.012)"
                    : "rgba(239,237,232,0.12)",
                },
              ]}
              pointerEvents="none"
            />

            {/* Header */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                minHeight: 44,
                paddingHorizontal: 18,
                paddingVertical: 11,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: hexToRgba(palette.ink, 0.08),
              }}
            >
              <Text
                style={{
                  fontSize: 10,
                  fontWeight: "700",
                  letterSpacing: 1.35,
                  textTransform: "uppercase",
                  color: palette.muted,
                }}
              >
                {slashSuggestions.length
                  ? `${slashSuggestions.length} command${slashSuggestions.length > 1 ? "s" : ""}`
                  : "Commands"}
              </Text>
              {slashLoading && (
                <ActivityIndicator size="small" color={palette.accent} />
              )}
            </View>

            {slashSuggestions.length ? (
              <ScrollView
                style={{ maxHeight: 320 }}
                contentContainerStyle={{ padding: 8, gap: 4 }}
                keyboardShouldPersistTaps="always"
                showsVerticalScrollIndicator={slashSuggestions.length > 5}
              >
                {slashSuggestions.map((item, i) => (
                  <Pressable
                    key={item.name}
                    onPress={() => {
                      void triggerHaptic("selection");
                      onSelectSlash(item.name);
                    }}
                    style={({ pressed }) => ({
                      borderRadius: 14,
                      borderCurve: "continuous",
                      overflow: "hidden",
                      backgroundColor: pressed
                        ? hexToRgba(palette.ink, isDark ? 0.1 : 0.06)
                        : i === 0
                          ? hexToRgba(palette.ink, isDark ? 0.055 : 0.035)
                          : "transparent",
                    })}
                  >
                    <View
                      style={{
                        minHeight: 64,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 12,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                      }}
                    >
                      {/* Command name + description; fall back so a row is never blank */}
                      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                        <Text
                          style={{
                            fontSize: 15,
                            fontWeight: "600",
                            letterSpacing: -0.15,
                            lineHeight: 20,
                            color: palette.ink,
                          }}
                          numberOfLines={1}
                        >
                          {item.name?.trim()
                            ? `/${item.name}`
                            : item.description ||
                              item.badge ||
                              "(unnamed command)"}
                        </Text>
                        {item.name?.trim() && item.description ? (
                          <Text
                            style={{
                              color: palette.muted,
                              fontSize: 12.5,
                              lineHeight: 17,
                            }}
                            numberOfLines={2}
                          >
                            {item.description}
                          </Text>
                        ) : null}
                      </View>

                      {/* Badge */}
                      {item.badge ? (
                        <View
                          style={{
                            maxWidth: 92,
                            flexShrink: 0,
                            alignSelf: "center",
                            borderRadius: 999,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: hexToRgba(palette.ink, 0.1),
                            backgroundColor: hexToRgba(
                              palette.ink,
                              isDark ? 0.08 : 0.045,
                            ),
                            paddingHorizontal: 9,
                            paddingVertical: 4,
                          }}
                        >
                          <Text
                            style={{
                              color: palette.soft,
                              fontSize: 10,
                              fontWeight: "600",
                            }}
                            numberOfLines={1}
                          >
                            {item.badge}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            ) : !slashLoading ? (
              <View style={{ alignItems: "center", paddingVertical: 16 }}>
                <Text
                  style={{
                    color: palette.muted,
                    fontSize: 13,
                    fontWeight: "500",
                  }}
                >
                  No matching commands
                </Text>
              </View>
            ) : null}
          </View>
        </Animated.View>
      )}

      {/* Main capsule */}
      <View style={{ marginHorizontal: 14, marginTop: 10 }}>
        {/* Shadow wrapper — outside overflow:hidden so shadow renders */}
        <View
          style={{
            borderRadius: 24,
            shadowColor: palette.shadow,
            shadowOffset: { width: 0, height: 10 },
            shadowOpacity: isDark ? 0.24 : 0.1,
            shadowRadius: 20,
          }}
        >
          {/* Clip container */}
          <View style={styles.capsule}>
            <AdaptiveBlur
              tint={isDark ? "systemMaterialDark" : "systemMaterialLight"}
              intensity={72}
              fallbackColor={hexToRgba(palette.surface, isDark ? 0.94 : 0.96)}
              opaqueFallbackColor={
                isDark ? palette.surface : palette.background
              }
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            {/* Subtle tint keeps the composer legible over busy transcript content. */}
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  backgroundColor: isDark
                    ? "rgba(255,255,255,0.015)"
                    : "rgba(247,246,242,0.2)",
                },
              ]}
              pointerEvents="none"
            />
            {/* Animated border overlay */}
            <Animated.View
              style={[
                StyleSheet.absoluteFill,
                { borderRadius: 24, borderWidth: 1, borderColor },
              ]}
              pointerEvents="none"
            />

            {hasAttachments ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
                contentContainerStyle={{
                  gap: 6,
                  paddingHorizontal: 14,
                  paddingTop: 12,
                }}
              >
                {pendingAttachments.map((attachment) => (
                  <View
                    key={attachment.id}
                    style={{
                      maxWidth: 180,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      borderRadius: 10,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: hexToRgba(palette.ink, 0.12),
                      backgroundColor: hexToRgba(
                        palette.ink,
                        isDark ? 0.08 : 0.04,
                      ),
                      paddingLeft: 9,
                      paddingRight: 4,
                      paddingVertical: 5,
                    }}
                  >
                    <Paperclip size={12} color={palette.soft} strokeWidth={2} />
                    <Text
                      numberOfLines={1}
                      style={{
                        flexShrink: 1,
                        color: palette.soft,
                        fontSize: 11,
                        fontWeight: "600",
                      }}
                    >
                      {attachment.filename || attachment.name || "Attachment"}
                    </Text>
                    {onRemoveAttachment ? (
                      <Pressable
                        onPress={() => {
                          void triggerHaptic("selection");
                          onRemoveAttachment(attachment.id);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${attachment.filename || attachment.name || "attachment"}`}
                        hitSlop={6}
                        style={({ pressed }) => ({
                          padding: 3,
                          opacity: pressed ? 0.5 : 1,
                        })}
                      >
                        <X size={12} color={palette.muted} strokeWidth={2.2} />
                      </Pressable>
                    ) : null}
                  </View>
                ))}
              </ScrollView>
            ) : null}

            {/* TextInput */}
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              multiline
              editable={!cleaned}
              selectionColor={palette.accent}
              keyboardAppearance={isDark ? "dark" : "light"}
              returnKeyType="default"
              placeholder={
                cleaned
                  ? "Worktree cleaned up"
                  : mode === "plan"
                    ? "What would you like to plan?"
                    : "Type / for commands"
              }
              placeholderTextColor={palette.muted}
              style={{
                fontSize: 16,
                lineHeight: INPUT_LINE_HEIGHT,
                color: palette.ink,
                maxHeight: INPUT_MAX_HEIGHT,
                minHeight: INPUT_MIN_HEIGHT,
                paddingTop: INPUT_PADDING_TOP,
                paddingBottom: INPUT_PADDING_BOTTOM,
                paddingHorizontal: 18,
                textAlignVertical: "top",
              }}
            />

            {/* Input / toolbar separator */}
            <View
              style={{
                height: StyleSheet.hairlineWidth,
                marginHorizontal: 16,
                backgroundColor: hexToRgba(palette.ink, 0.08),
              }}
            />

            {/* Toolbar */}
            <View style={styles.toolbar}>
              {/* Left cluster — icon actions only; can shrink */}
              <View
                style={{
                  flex: 1,
                  minWidth: 0,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {/* Attach */}
                {onAttach ? (
                  <Pressable
                    onPress={() => {
                      void triggerHaptic("selection");
                      Keyboard.dismiss();
                      onAttach();
                    }}
                    disabled={cleaned}
                    accessibilityRole="button"
                    accessibilityLabel="Attach file"
                    accessibilityState={{ disabled: cleaned }}
                    hitSlop={6}
                    style={({ pressed }) => ({
                      ...iconBtn,
                      padding: 3,
                      opacity: cleaned ? 0.3 : pressed ? 0.68 : 1,
                      transform: [{ scale: pressed ? 0.94 : 1 }],
                    })}
                  >
                    <Paperclip size={14} color={palette.soft} strokeWidth={2} />
                    {pendingAttachments.length > 0 ? (
                      <View
                        style={{
                          position: "absolute",
                          top: -5,
                          right: -5,
                          minWidth: 16,
                          height: 16,
                          borderRadius: 999,
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: palette.accent,
                          borderWidth: 1,
                          borderColor: palette.surface,
                        }}
                      >
                        <Text
                          style={{
                            color: palette.background,
                            fontSize: 9,
                            fontWeight: "800",
                            fontVariant: ["tabular-nums"],
                          }}
                        >
                          {pendingAttachments.length}
                        </Text>
                      </View>
                    ) : null}
                  </Pressable>
                ) : null}

                {/* Commands */}
                <Pressable
                  onPress={() => {
                    void triggerHaptic("selection");
                    Keyboard.dismiss();
                    onOpenCommands();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Open command palette"
                  accessibilityHint="Shows slash commands, prompt presets, tools, skills, and snippets"
                  hitSlop={6}
                  style={({ pressed }) => ({
                    ...iconBtn,
                    padding: 3,
                    opacity: pressed ? 0.68 : 1,
                    transform: [{ scale: pressed ? 0.94 : 1 }],
                  })}
                >
                  <Terminal size={14} color={palette.soft} strokeWidth={2} />
                </Pressable>

                {/* Git */}
                {onOpenGit ? (
                  <Pressable
                    onPress={() => {
                      void triggerHaptic("selection");
                      Keyboard.dismiss();
                      onOpenGit();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Open Git panel"
                    accessibilityHint="Shows Git changes, commits, and review"
                    hitSlop={6}
                    style={({ pressed }) => ({
                      ...iconBtn,
                      padding: 3,
                      opacity: pressed ? 0.68 : 1,
                      transform: [{ scale: pressed ? 0.94 : 1 }],
                    })}
                  >
                    <GitBranch size={14} color={palette.soft} strokeWidth={2} />
                  </Pressable>
                ) : null}

                {/* Permissions — icon only so the send/mode controls stay visible */}
                {onOpenPermissions && !narrowToolbar ? (
                  <Pressable
                    onPress={() => {
                      void triggerHaptic("selection");
                      Keyboard.dismiss();
                      onOpenPermissions();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={
                      permissionModeLabel
                        ? `Permissions: ${permissionModeLabel}`
                        : "Permissions"
                    }
                    accessibilityHint="Choose how the host asks before tool actions"
                    hitSlop={6}
                    style={({ pressed }) => ({
                      ...iconBtn,
                      padding: 3,
                      opacity: pressed ? 0.68 : 1,
                      transform: [{ scale: pressed ? 0.94 : 1 }],
                    })}
                  >
                    <Shield size={14} color={palette.soft} strokeWidth={2.1} />
                  </Pressable>
                ) : null}

                {/* Plus - opens tools drawer */}
                <Pressable
                  onPress={() => {
                    void triggerHaptic("selection");
                    Keyboard.dismiss();
                    setDrawerVisible(true);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Open tools"
                  accessibilityHint="Shows tools, skills, models, and MCP controls"
                  hitSlop={6}
                  style={({ pressed }) => ({
                    ...iconBtn,
                    padding: 3,
                    opacity: pressed ? 0.68 : 1,
                    transform: [{ scale: pressed ? 0.94 : 1 }],
                  })}
                >
                  <Plus size={14} color={palette.soft} strokeWidth={2} />
                </Pressable>
              </View>

              {/* Right cluster — always visible (mode, model, send) */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 7,
                  flexShrink: 0,
                }}
              >
                {/* Mode segmented control */}
                <Pressable
                  onPress={() => {
                    void triggerHaptic("selection");
                    setMode(mode === "plan" ? "code" : "plan");
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Switch composer mode. Current mode is ${mode}`}
                  accessibilityHint="Toggles between planning mode and code execution mode"
                  hitSlop={4}
                  style={({ pressed }) => ({
                    opacity: pressed ? 0.78 : 1,
                    transform: [{ scale: pressed ? 0.97 : 1 }],
                  })}
                >
                  <View
                    style={[
                      styles.segment,
                      {
                        borderColor: isDark
                          ? hexToRgba(palette.ink, 0.13)
                          : hexToRgba(palette.border, 0.78),
                      },
                    ]}
                  >
                    {/* Sliding pill indicator */}
                    <Animated.View
                      style={[
                        styles.segmentPill,
                        {
                          // Native driver only supports transform/opacity; use
                          // translateX instead of `left` so the pill can slide
                          // on the UI thread.
                          transform: [{ translateX: segmentPillLeft }],
                          backgroundColor: isDark
                            ? "rgba(255,255,255,0.13)"
                            : "rgba(255,255,255,0.95)",
                          borderColor: hexToRgba(palette.ink, 0.18),
                        },
                      ]}
                    />
                    {/* Plan segment */}
                    <View style={styles.segmentItem}>
                      <Animated.Text
                        style={[
                          styles.segmentLabel,
                          { color: segmentLabelPlan },
                        ]}
                      >
                        Plan
                      </Animated.Text>
                    </View>
                    {/* Code segment */}
                    <View style={styles.segmentItem}>
                      <Animated.Text
                        style={[
                          styles.segmentLabel,
                          { color: segmentLabelCode },
                        ]}
                      >
                        Code
                      </Animated.Text>
                    </View>
                  </View>
                </Pressable>
                {showModelControl && (modelLabel || onOpenModelPicker) ? (
                  <Pressable
                    onPress={() => {
                      void triggerHaptic("selection");
                      onOpenModelPicker?.();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={
                      modelLabel
                        ? `Model: ${modelLabel}. Tap to change model or thinking effort.`
                        : "Choose model"
                    }
                    style={({ pressed }) => ({
                      flexShrink: 0,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: isDark
                        ? hexToRgba(palette.ink, 0.12)
                        : hexToRgba(palette.border, 0.7),
                      backgroundColor: isDark
                        ? "rgba(255,255,255,0.05)"
                        : "rgba(255,255,255,0.62)",
                      paddingHorizontal: 14,
                      paddingVertical: 7,
                      opacity: pressed ? 0.72 : 1,
                    })}
                  >
                    <Text
                      style={{
                        color: palette.muted,
                        fontSize: 12,
                        fontWeight: "600",
                      }}
                      numberOfLines={1}
                    >
                      Model
                    </Text>
                  </Pressable>
                ) : null}
                {/* Char count */}
                {showCharCount && !sending ? (
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: "500",
                      color: charCount > 400 ? palette.warn : palette.muted,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {charCount}
                  </Text>
                ) : null}

                {/* Send / Stop */}
                {showStop ? (
                  <Animated.View style={{ transform: [{ scale: stopPulse }] }}>
                    <Pressable
                      onPress={() => {
                        void triggerHaptic("error");
                        onStop?.();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Stop current run"
                      hitSlop={4}
                      style={({ pressed }) => ({
                        width: 44,
                        height: 44,
                        borderRadius: 999,
                        borderCurve: "continuous",
                        borderWidth: 1,
                        borderColor: isDark
                          ? hexToRgba(palette.ink, 0.16)
                          : hexToRgba(palette.border, 0.82),
                        backgroundColor: isDark
                          ? "rgba(22,22,22,0.88)"
                          : "rgba(255,255,255,0.88)",
                        alignItems: "center",
                        justifyContent: "center",
                        opacity: pressed ? 0.7 : 1,
                        transform: [{ scale: pressed ? 0.93 : 1 }],
                      })}
                    >
                      <Square
                        size={14}
                        color={palette.ink}
                        strokeWidth={0}
                        fill={palette.ink}
                      />
                    </Pressable>
                  </Animated.View>
                ) : (
                  <Animated.View
                    style={{ transform: [{ scale: sendScaleAnim }] }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        queueOnSend ? "Queue message" : "Send message"
                      }
                      accessibilityState={{ disabled: sendDisabled }}
                      disabled={sendDisabled}
                      onPress={() => {
                        void triggerHaptic("send");
                        onSend();
                      }}
                      style={({ pressed }) => ({
                        width: 44,
                        height: 44,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: isDark
                          ? hexToRgba(palette.ink, 0.16)
                          : hexToRgba(palette.border, 0.82),
                        backgroundColor: "transparent",
                        alignItems: "center",
                        justifyContent: "center",
                        overflow: "hidden",
                        opacity: pressed && !sendDisabled ? 0.7 : 1,
                        transform: [
                          { scale: pressed && !sendDisabled ? 0.93 : 1 },
                        ],
                      })}
                    >
                      <Animated.View
                        pointerEvents="none"
                        style={[
                          StyleSheet.absoluteFill,
                          {
                            borderRadius: 999,
                            backgroundColor: sendBackgroundColor,
                          },
                        ]}
                      />
                      <ArrowUp
                        size={18}
                        color={sendIconColor}
                        strokeWidth={2.2}
                      />
                    </Pressable>
                  </Animated.View>
                )}
              </View>
            </View>
          </View>
        </View>
      </View>

      <ComposerToolDrawer
        visible={drawerVisible}
        onClose={() => setDrawerVisible(false)}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        modelLabel={modelLabel}
        activeModelKey={activeModelKey}
        activeVariant={activeVariant}
        availableModels={availableModels}
        onModelSelect={onModelSelect}
        onOpenModelPicker={() => {
          setDrawerVisible(false);
          onOpenModelPicker?.();
        }}
        skills={skills}
        onSkillSelect={onSkillSelect}
        onSkillsManage={onSkillsManage}
        tools={tools}
        onToolToggle={onToolToggle}
        onToolsManage={onToolsManage}
        mcpServers={mcpServers}
        onMcpToggle={onMcpToggle}
        onMcpManage={onMcpManage}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  capsule: {
    borderRadius: 24,
    overflow: "hidden",
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 12,
    paddingTop: 11,
  },
  segment: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    height: 26,
    // SEGMENT_W * 2 segments + 4px inner padding (2 each side)
    width: SEGMENT_W * 2 + 4,
    position: "relative",
    overflow: "hidden",
    backgroundColor: "transparent",
  },
  segmentPill: {
    position: "absolute",
    top: 2,
    // Pill fills one segment minus 2px (leaves 2px gap on connecting edge)
    width: SEGMENT_W - 2,
    height: 22,
    borderRadius: 999,
    borderWidth: 1,
  },
  segmentItem: {
    width: SEGMENT_W,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  segmentLabel: {
    fontSize: 9.5,
    fontWeight: "600",
    letterSpacing: 0.15,
  },
});
