import { useCallback, useMemo, useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { Stack, useFocusEffect } from "expo-router"
import { Check } from "lucide-react-native"
import { ErrorBanner } from "@/components/ui/ErrorBanner"
import { optionChipStyle, optionChipTextColor } from "@/components/ui/InfoChip"
import { SurfaceCard } from "@/components/ui/SurfaceCard"
import { useServer } from "@/lib/server-context"
import {
  PERMISSION_ACTIONS,
  PERMISSION_ITEMS,
  PERMISSION_PRESETS,
  detectPermissionMode,
  getPermissionActionFor,
  permissionModeDescription,
  permissionModeTitle,
  permissionPresetPatch,
  presetPermissionMode,
  toPermissionMap,
  type PermissionAction,
  type PermissionMap,
  type PermissionModeSetting,
  type PermissionPreset,
} from "@/lib/permission-presets"
import { triggerHaptic } from "@/lib/haptics"
import { hexToRgba, useAppTheme } from "@/lib/theme"
import { type as typeStyle } from "@/lib/typography"
import type { HostConfigSnapshot } from "@/lib/types"

export default function PermissionsSettingsScreen() {
  const { client } = useServer()
  const { palette, isDark } = useAppTheme()
  const [permission, setPermission] = useState<PermissionMap>({})
  const [permissionModeSetting, setPermissionModeSetting] = useState<PermissionModeSetting | undefined>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const mode = useMemo(
    () => detectPermissionMode(permission, permissionModeSetting),
    [permission, permissionModeSetting],
  )

  const load = useCallback(async () => {
    if (!client) return
    try {
      setLoading(true)
      setMessage(null)
      const config = await client.getConfig()
      setPermission(toPermissionMap(config.permission))
      setPermissionModeSetting(config.permission_mode as PermissionModeSetting | undefined)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [client])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  async function applyPreset(preset: PermissionPreset) {
    if (!client || saving) return
    const before = permission
    const beforeMode = permissionModeSetting
    const patch = permissionPresetPatch(preset)
    const nextMode = presetPermissionMode(preset)
    const next = { ...toPermissionMap(before), ...patch }
    setPermission(next)
    setPermissionModeSetting(nextMode)
    try {
      setSaving(true)
      setMessage(null)
      void triggerHaptic("selection")
      await client.updateConfig({ permission: patch, permission_mode: nextMode } as HostConfigSnapshot)
    } catch (error) {
      setPermission(before)
      setPermissionModeSetting(beforeMode)
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function setToolAction(id: string, action: PermissionAction) {
    if (!client || saving) return
    const before = permission
    const existing = before[id]
    const nextValue =
      existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing, "*": action } : action
    const next = { ...before, [id]: nextValue }
    setPermission(next)
    try {
      setSaving(true)
      setMessage(null)
      void triggerHaptic("selection")
      await client.updateConfig({ permission: { [id]: nextValue } } as HostConfigSnapshot)
    } catch (error) {
      setPermission(before)
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: "Permissions" }} />
      <ScrollView
        className="flex-1 bg-background"
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 36, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        {message ? <ErrorBanner message={message} /> : null}

        <SurfaceCard eyebrow="Presets" title={permissionModeTitle(mode)} description={permissionModeDescription(mode)}>
          <View className="mt-4 gap-2">
            {PERMISSION_PRESETS.map((preset) => {
              const active = mode === preset
              return (
                <Pressable
                  key={preset}
                  disabled={saving || loading}
                  onPress={() => void applyPreset(preset)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={({ pressed }) => ({
                    minHeight: 44,
                    borderRadius: 14,
                    borderWidth: 1,
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    opacity: pressed ? 0.78 : 1,
                    backgroundColor: active
                      ? hexToRgba(palette.accentLight, 0.12)
                      : hexToRgba(palette.ink, isDark ? 0.04 : 0.03),
                    borderColor: active ? hexToRgba(palette.accentLight, 0.28) : hexToRgba(palette.ink, 0.1),
                  })}
                >
                  <View className="flex-row items-center justify-between gap-3">
                    <View className="min-w-0 flex-1">
                      <Text style={{ color: palette.ink, ...typeStyle(14, { weight: "600" }) }}>
                        {permissionModeTitle(preset)}
                      </Text>
                      <Text style={{ marginTop: 4, color: palette.soft, ...typeStyle(12) }}>
                        {permissionModeDescription(preset)}
                      </Text>
                    </View>
                    {active ? <Check size={16} color={palette.accentLight} strokeWidth={2.4} /> : null}
                  </View>
                </Pressable>
              )
            })}
          </View>
        </SurfaceCard>

        <SurfaceCard
          eyebrow="Tools"
          title="Per-tool rules"
          description="Override individual tools. Choosing Ask, Allow, or Deny here switches the host into Custom mode when it no longer matches a preset."
        >
          <View className="mt-4">
            {PERMISSION_ITEMS.map((item, index) => {
              const current = getPermissionActionFor(permission, item.id)
              return (
                <View
                  key={item.id}
                  style={{
                    paddingVertical: 12,
                    borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                    borderTopColor: hexToRgba(palette.ink, 0.08),
                  }}
                >
                  <Text style={{ color: palette.ink, ...typeStyle(14, { weight: "600" }) }}>{item.title}</Text>
                  <Text style={{ marginTop: 4, color: palette.soft, ...typeStyle(12) }}>{item.description}</Text>
                  <View className="mt-3 flex-row flex-wrap gap-2">
                    {PERMISSION_ACTIONS.map((action) => {
                      const active = current === action.value
                      return (
                        <Pressable
                          key={action.value}
                          disabled={saving || loading}
                          onPress={() => void setToolAction(item.id, action.value)}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          style={({ pressed }) => ({
                            ...optionChipStyle(palette, active),
                            borderRadius: 999,
                            opacity: pressed ? 0.72 : 1,
                          })}
                        >
                          <Text
                            style={{
                              color: optionChipTextColor(palette, active),
                              ...typeStyle(12, { weight: active ? "700" : "600" }),
                            }}
                          >
                            {action.label}
                          </Text>
                        </Pressable>
                      )
                    })}
                  </View>
                </View>
              )
            })}
          </View>
        </SurfaceCard>
      </ScrollView>
    </>
  )
}
