import { describe, expect, it } from "vite-plus/test";

import { getThemePreviewStyle, type ThemeCardPreviewColors } from "./ThemePreviewCircles";

const BASE_COLORS: ThemeCardPreviewColors = {
  sidebar: "#fafafa",
  canvas: "#ffffff",
  surface: "#ffffff",
  accentSurface: "#f4f4f5",
  accent: "#3b82f6",
  messageSurface: "#e4e4e7",
  messageAction: "#111827",
};

describe("getThemePreviewStyle", () => {
  it("reflects changes to sidebar and messageSurface in the rendered backgroundImage", () => {
    const baseStyle = getThemePreviewStyle(BASE_COLORS, "light");
    const sidebarChanged = getThemePreviewStyle(
      { ...BASE_COLORS, sidebar: "#1e293b" },
      "light",
    );
    const messageChanged = getThemePreviewStyle(
      { ...BASE_COLORS, messageSurface: "#fef3c7" },
      "light",
    );

    expect(sidebarChanged.backgroundImage).not.toBe(baseStyle.backgroundImage);
    expect(messageChanged.backgroundImage).not.toBe(baseStyle.backgroundImage);
    expect(sidebarChanged.backgroundImage).toContain("#1e293b");
    expect(messageChanged.backgroundImage).toContain("#fef3c7");
  });
});
