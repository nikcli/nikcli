import { Platform, View } from "react-native";
import { useSegments } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { NetworkBanner } from "@/components/NetworkBanner";
import { useAppTheme } from "@/lib/theme";

export default function AppLayout() {
  const segments = useSegments();
  const routeSegments = segments.filter((segment) => !segment.startsWith("("));
  const [root, child] = routeSegments;
  const hideChrome = root === "sessions" && Boolean(child);
  const { palette } = useAppTheme();

  return (
    <View style={{ flex: 1 }}>
      <NetworkBanner />
      <NativeTabs
        hidden={hideChrome}
        sidebarAdaptable={false}
        disableTransparentOnScrollEdge
        tintColor={palette.accent}
        iconColor={{ default: palette.textMuted, selected: palette.accent }}
        // Android must lift the tab bar with the IME. iOS terminal already pads
        // its own dock by keyboard height, so leaving this on double-pads that viewport.
        tabBarRespectsIMEInsets={Platform.OS === "android"}
      >
        <NativeTabs.Trigger name="sessions">
          <NativeTabs.Trigger.Icon
            sf={{ default: "terminal", selected: "terminal.fill" }}
            md="terminal"
          />
          <NativeTabs.Trigger.Label>Sessions</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="repos">
          <NativeTabs.Trigger.Icon
            sf={{ default: "folder", selected: "folder.fill" }}
            md="folder"
          />
          <NativeTabs.Trigger.Label>Workspaces</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="terminal">
          <NativeTabs.Trigger.Icon
            sf={{ default: "apple.terminal", selected: "apple.terminal.fill" }}
            md="code"
          />
          <NativeTabs.Trigger.Label>Terminal</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="routines">
          <NativeTabs.Trigger.Icon sf="clock.arrow.circlepath" md="schedule" />
          <NativeTabs.Trigger.Label>Routines</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="more">
          <NativeTabs.Trigger.Icon
            sf={{
              default: "square.grid.2x2",
              selected: "square.grid.2x2.fill",
            }}
            md="dashboard"
          />
          <NativeTabs.Trigger.Label>Tools</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </View>
  );
}
