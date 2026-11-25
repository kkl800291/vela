import { createFileRoute } from "@tanstack/react-router";

import { UnifiedMcpSettingsPanel } from "../components/settings/UnifiedMcpSettingsPanel";
import { prefetchUnifiedMcpSnapshot } from "../state/unifiedMcp";

function SettingsMcpRoute() {
  return <UnifiedMcpSettingsPanel />;
}

export const Route = createFileRoute("/_chat/settings/mcp")({
  beforeLoad: () => {
    prefetchUnifiedMcpSnapshot();
  },
  component: SettingsMcpRoute,
});
