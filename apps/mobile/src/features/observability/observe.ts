import Constants from "expo-constants";

// Reports leave only through a configured relay, and expo-observe requires extra.eas.projectId
// before its native HostFunction can be loaded without throwing at module evaluation time.
const relayUrl: unknown = Constants.expoConfig?.extra?.relay?.url;
const easProjectId: unknown = Constants.expoConfig?.extra?.eas?.projectId;
const appVariant: unknown = Constants.expoConfig?.extra?.appVariant;

const hasObserveProjectId = typeof easProjectId === "string" && easProjectId.trim() !== "";

export const crashReportingAvailable =
  hasObserveProjectId && typeof relayUrl === "string" && relayUrl.trim() !== "";

type ObserveModule = typeof import("expo-observe").Observe;

let observeModulePromise: Promise<ObserveModule | null> | null = null;

function loadObserve(): Promise<ObserveModule | null> {
  if (!hasObserveProjectId) {
    return Promise.resolve(null);
  }
  observeModulePromise ??= import("expo-observe")
    .then((mod) => mod.Observe)
    .catch((error: unknown) => {
      console.warn("[observe] could not load expo-observe", error);
      return null;
    });
  return observeModulePromise;
}

export function reportObservedError(error: unknown): void {
  if (!crashReportingAvailable) return;
  void loadObserve().then((Observe) => {
    Observe?.reportError(error);
  });
}

interface PromiseRejectionTracker {
  readonly enablePromiseRejectionTracker?: (options: {
    readonly allRejections: boolean;
    readonly onUnhandled: (id: number, rejection: unknown) => void;
  }) => void;
}

// React Native tracks unhandled rejections only in development, for LogBox; Observe has no hook.
if (!__DEV__ && crashReportingAvailable) {
  const hermes: PromiseRejectionTracker | undefined = Reflect.get(globalThis, "HermesInternal");
  hermes?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id, rejection) => reportObservedError(rejection),
  });
}

let latestConfiguration = 0;

// While sending is off, a dispatch pass drops what it finds, so one runs before turning it back on.
// Best effort: Observe skips the pass while it is backing off from a failed send.
export async function setCrashReportsEnabled(enabled: boolean) {
  const configuration = ++latestConfiguration;
  const Observe = await loadObserve();
  if (!Observe || configuration !== latestConfiguration) return;
  const dispatchingEnabled = crashReportingAvailable && enabled;
  if (dispatchingEnabled) {
    await Observe.dispatchEvents();
    if (configuration !== latestConfiguration) return;
  }
  Observe.configure({
    dispatchingEnabled,
    ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
  });
}

if (!crashReportingAvailable) {
  if (hasObserveProjectId) {
    void setCrashReportsEnabled(false);
  }
} else {
  // Observe keeps its last configuration across launches; configuring it off while the setting
  // loads would drop the last session's native crash. Imported lazily so the persistence graph
  // never runs ahead of the imports `index.ts` orders first.
  const changedSinceLoad = () => latestConfiguration !== 0;
  void import("../../persistence/imperative")
    .then(({ loadPreferences }) => loadPreferences())
    .then(
      (preferences) =>
        changedSinceLoad()
          ? undefined
          : setCrashReportsEnabled(preferences.crashReportsEnabled !== false),
      // Observe keeps the last choice it was given, which stands in for the unreadable one.
      (error: unknown) => console.warn("[observe] could not read the crash report setting", error),
    )
    .catch((error: unknown) => {
      console.warn("[observe] could not apply the crash report setting", error);
    });
}
