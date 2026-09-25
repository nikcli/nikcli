import type { RefObject } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { Ban, Check, CircleCheck, ListChecks, Settings, ShieldCheck, type LucideIcon } from "lucide-react-native"
import { ActionSheet, ActionSheetDivider, type ActionSheetRef } from "@/components/BottomSheet"
import { triggerHaptic } from "@/lib/haptics"
import {
  PERMISSION_PRESETS,
  permissionModeDescription,
  permissionModeTitle,
  type PermissionMode,
  type PermissionPreset,
} from "@/lib/permission-presets"
import { hexToRgba, useAppTheme } from "@/lib/theme"
import { type as typeStyle } from "@/lib/typography"

type Props = {
  sheetRef: RefObject<ActionSheetRef | null>
  mode: PermissionMode
  saving?: boolean
  onSelect(preset: PermissionPreset): void
  onOpenDetailed(): void
}

function iconForMode(mode: PermissionMode): LucideIcon {
  switch (mode) {
    case "require_approval":
      return Ban
    case "full_access":
      return CircleCheck
    case "auto":
      return ShieldCheck
    case "custom":
      return Settings
    default:
      return ListChecks
  }
}

function toneForMode(mode: PermissionMode, palette: ReturnType<typeof useAppTheme>["palette"]) {
  switch (mode) {
    case "require_approval":
      return palette.warning
    case "full_access":
      return palette.success
    case "approve_for_me":
      return palette.accentLight
    case "auto":
      return palette.info
    default:
      return palette.soft
  }
}

export function PermissionModeSheet({ sheetRef, mode, saving = false, onSelect, onOpenDetailed }: Props) {
  const { palette, isDark } = useAppTheme()

  return (
    <ActionSheet ref={sheetRef}>
      <View className="border-b border-border px-5 pb-4">
        <Text style={{ color: palette.muted, ...typeStyle(12, { weight: "500" }) }}>Permissions</Text>
        <Text className="mt-1.5" style={{ color: palette.ink, ...typeStyle(18, { weight: "700" }) }}>
          {permissionModeTitle(mode)}
        </Text>
        <Text className="mt-1" style={{ color: palette.muted, ...typeStyle(13) }}>
          Choose how the host asks before tool actions. Changes apply to this server for all sessions.
        </Text>
      </View>

      <View style={{ paddingTop: 6, paddingBottom: 4 }}>
        {mode === "custom" ? <PresetRow mode="custom" active disabled onPress={() => undefined} /> : null}

        {PERMISSION_PRESETS.map((preset, index) => (
          <PresetRow
            key={preset}
            mode={preset}
            active={mode === preset}
            disabled={saving}
            bordered={index < PERMISSION_PRESETS.length - 1}
            onPress={() => {
              if (saving || mode === preset) {
                sheetRef.current?.dismiss()
                return
              }
              void triggerHaptic("selection")
              onSelect(preset)
            }}
          />
        ))}
      </View>

      <ActionSheetDivider />

      <Pressable
        onPress={() => {
          void triggerHaptic("selection")
          sheetRef.current?.dismiss(() => onOpenDetailed())
        }}
        accessibilityRole="button"
        accessibilityLabel="Open detailed permissions"
        style={({ pressed }) => ({
          opacity: pressed ? 0.72 : 1,
        })}
      >
        <View
          style={{
            width: "100%",
            flexDirection: "row",
            alignItems: "center",
            gap: 14,
            paddingHorizontal: 20,
            paddingVertical: 14,
            minHeight: 58,
          }}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 999,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: isDark ? "rgba(22,22,22,0.88)" : "rgba(255,255,255,0.88)",
              borderWidth: 1,
              borderColor: isDark ? hexToRgba(palette.ink, 0.16) : hexToRgba(palette.border, 0.82),
            }}
          >
            <Settings size={18} color={palette.ink} strokeWidth={2.1} />
          </View>
          <Text
            style={{
              flex: 1,
              color: palette.ink,
              fontSize: 15,
              fontWeight: "600",
              letterSpacing: -0.2,
            }}
          >
            Open detailed permissions
          </Text>
        </View>
      </Pressable>
    </ActionSheet>
  )
}

function PresetRow({
  mode,
  active,
  disabled,
  bordered = true,
  onPress,
}: {
  mode: PermissionMode
  active: boolean
  disabled?: boolean
  bordered?: boolean
  onPress(): void
}) {
  const { palette, isDark } = useAppTheme()
  const Icon = iconForMode(mode)
  const tone = toneForMode(mode, palette)

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled && !active}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      accessibilityLabel={permissionModeTitle(mode)}
      accessibilityHint={permissionModeDescription(mode)}
      style={({ pressed }) => ({
        opacity: disabled && !active ? 0.48 : pressed ? 0.72 : 1,
      })}
    >
      <View
        style={{
          width: "100%",
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          minHeight: 72,
          paddingHorizontal: 20,
          paddingVertical: 12,
          borderBottomWidth: bordered ? StyleSheet.hairlineWidth : 0,
          borderBottomColor: isDark ? "rgba(255,255,255,0.08)" : hexToRgba(palette.ink, 0.08),
        }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            flexShrink: 0,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: active ? hexToRgba(tone, 0.14) : hexToRgba(palette.ink, 0.06),
            borderWidth: 1,
            borderColor: active ? hexToRgba(tone, 0.28) : hexToRgba(palette.ink, 0.1),
          }}
        >
          <Icon size={18} color={active ? tone : palette.muted} strokeWidth={2.1} />
        </View>
        <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          <Text
            style={{
              color: palette.ink,
              fontSize: 15,
              fontWeight: "600",
              letterSpacing: -0.2,
            }}
            numberOfLines={1}
          >
            {permissionModeTitle(mode)}
          </Text>
          <Text
            style={{
              marginTop: 3,
              color: palette.soft,
              fontSize: 12.5,
              lineHeight: 17,
            }}
            numberOfLines={2}
          >
            {permissionModeDescription(mode)}
          </Text>
        </View>
        {active ? (
          <View style={{ flexShrink: 0 }}>
            <Check size={16} color={tone} strokeWidth={2.4} />
          </View>
        ) : null}
      </View>
    </Pressable>
  )
}
