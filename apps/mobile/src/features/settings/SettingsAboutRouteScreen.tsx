import { T, useGT } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";
import { Linking, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useDeadlinePassed } from "../../lib/clock";
import { useWorkspaceEnvironments } from "../../state/workspace";
import {
  fetchMobileApkMeta,
  requestMobileApkDownloadTicket,
  resolveEnvironmentUrl,
  type MobileApkMeta,
} from "../collab/collabApi";
import { formatByteSize } from "../collab/collabModel";
import {
  type AppUpdateCheckState,
  isAppUpdateCheckAvailable,
  registerHiddenUpdateTap,
  runAppUpdateCheck,
} from "../updates/app-updates";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsAboutRouteScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title={gt("About")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <AppSettingsSection />
        {Platform.OS === "android" ? <AndroidDirectApkUpdateSection /> : null}
      </ScrollView>
    </SettingsScreen>
  );
}

function AppSettingsSection() {
  const gt = useGT();
  const [checkState, setCheckState] = useState<{
    readonly state: AppUpdateCheckState;
    // "Up to date" is a confirmation that fades back to idle.
    readonly settledUntil: number | null;
  }>({ state: "idle", settledUntil: null });
  const confirmationExpired = useDeadlinePassed(checkState.settledUntil);
  const updateState =
    checkState.state === "current" && confirmationExpired ? "idle" : checkState.state;
  const updateInFlight = useRef(false);
  const hiddenUpdateTapCount = useRef(0);

  const version = Constants.expoConfig?.version ?? "0.0.0";
  // Match app.config.ts's production fallback to avoid mislabeling builds as development.
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  // EAS assigns build numbers remotely; only the installed binary knows its own.
  const build = Application.nativeBuildVersion;
  const versionWithBuild = build ? `${version} (${build})` : version;
  const versionLabel = variantLabel ? `${versionWithBuild} · ${variantLabel}` : versionWithBuild;
  const updateCheckAvailable = isAppUpdateCheckAvailable();
  const busy =
    updateState === "checking" || updateState === "downloading" || updateState === "restarting";

  async function checkForUpdate() {
    // disabled updates next render; the ref blocks same-frame double taps.
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    // Failures arrive through onFailure; the settled result only matters for unlocking.
    await settlePromise(() =>
      runAppUpdateCheck({
        applyMode: "immediate",
        onFailure: (message) => Dialog.alert(gt("Update failed"), message),
        onStateChange: (state) =>
          setCheckState({
            state,
            settledUntil: state === "current" ? Date.now() + 3000 : null,
          }),
      }),
    );
    updateInFlight.current = false;
  }

  function handleVersionPress() {
    if (!updateCheckAvailable || updateInFlight.current) return;
    const tap = registerHiddenUpdateTap(hiddenUpdateTapCount.current);
    hiddenUpdateTapCount.current = tap.nextCount;
    if (tap.shouldCheck) {
      void checkForUpdate();
    }
  }

  const statusLabel =
    updateState === "checking"
      ? gt("Checking…")
      : updateState === "downloading"
        ? gt("Downloading…")
        : updateState === "ready"
          ? gt("Update ready")
          : updateState === "restarting"
            ? gt("Restarting…")
            : updateState === "current"
              ? gt("Up to date")
              : null;

  const versionRow = (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="info.circle"
        size={22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <Text className="flex-1 text-lg text-foreground">
        <T>Version</T>
      </Text>
      <View className="items-end">
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
        {statusLabel ? (
          <Text className="text-xs text-foreground-muted/70">{statusLabel}</Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <SettingsSection title={gt("App", { $context: "settings section about this mobile app" })}>
      <SettingsRow
        icon="internaldrive"
        label={gt("Client Storage")}
        target="SettingsClientStorage"
      />
      <SettingsRow icon="stethoscope" label={gt("Diagnostics")} target="SettingsDiagnostics" />
      <SettingsRow
        icon="doc.on.doc"
        label={gt("Open source licenses")}
        target="SettingsOpenSourceLicenses"
      />
      <SettingsRow icon="doc.text" label={gt("Legal")} fullScreenTarget="SettingsLegal" />
      {updateCheckAvailable ? (
        <Pressable
          accessibilityLabel={gt("Version {version}", { version: versionLabel })}
          accessibilityRole="text"
          disabled={busy}
          onPress={handleVersionPress}
        >
          {versionRow}
        </Pressable>
      ) : (
        versionRow
      )}
    </SettingsSection>
  );
}

function AndroidDirectApkUpdateSection() {
  const environments = useWorkspaceEnvironments();
  const connected = environments.find((env) => env.connectionState === "connected") ?? null;
  const [meta, setMeta] = useState<MobileApkMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);

  async function handleCheckAndDownload() {
    if (!connected || busy) return;
    setBusy(true);
    setStatusText("正在检查电脑端最新 APK…");
    await fetchMobileApkMeta(connected.environmentId)
      .then(async (info) => {
        setMeta(info);
        if (!info.available) {
          setStatusText("电脑端尚未生成最新 APK");
          return;
        }
        setStatusText("正在获取下载链接…");
        const ticket = await requestMobileApkDownloadTicket(connected.environmentId);
        const url = resolveEnvironmentUrl(connected.environmentId, ticket.downloadPath);
        if (!url) {
          setStatusText("当前环境地址不可用");
          return;
        }
        setStatusText(`已拉起浏览器下载 ${ticket.fileName}`);
        await Linking.openURL(url);
      })
      .catch((error: unknown) => {
        const msgText = error instanceof Error ? error.message : String(error);
        setStatusText(null);
        Dialog.alert("在线更新失败", msgText);
      });
    setBusy(false);
  }

  return (
    // oxlint-disable-next-line t3code/no-untranslated-copy -- Vela direct APK update copy
    <SettingsSection title="免 USB 在线更新（Android）">
      <Pressable
        accessibilityRole="button"
        disabled={!connected || busy}
        onPress={() => void handleCheckAndDownload()}
        className="flex-row items-center gap-4 p-4 active:opacity-75"
      >
        <SymbolView
          name="arrow.down.circle"
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <View className="min-w-0 flex-1">
          <Text className="text-lg text-foreground">
            {busy ? "正在准备下载…" : "下载并覆盖安装最新 APK"}
          </Text>
          <Text className="mt-0.5 text-xs text-foreground-muted">
            {!connected
              ? "请先连接 Mac 桌面端 Vela（Tailscale / Wi-Fi）"
              : statusText
                ? statusText
                : meta?.available && meta.sizeBytes
                  ? `${meta.fileName ?? "Vela.apk"} · ${formatByteSize(meta.sizeBytes)}`
                  : `通过 ${connected.environmentLabel} 直接走 Tailscale/局域网下载，保留全部配对数据`}
          </Text>
        </View>
        <SymbolView
          name="chevron.right"
          size={14}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
    </SettingsSection>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
