import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_CONTEXT_CLIPBOARD_MIME } from "@t3tools/shared/composerContextClipboard";

import { writeTextToClipboard } from "./useCopyToClipboard";

describe("writeTextToClipboard", () => {
  it("reserves plain text even when an extra flavor attempts to replace it", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    await expect(
      writeTextToClipboard("original", undefined, {
        "text/plain": "replacement",
        "text/html": "<b>original</b>",
      }),
    ).resolves.toBe(true);
    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    expect(await items[0]!.data["text/plain"]!.text()).toBe("original");
  });
  it("reports a rejected HTML copy without silently copying only plain text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      clipboard: { write: vi.fn().mockRejectedValue(new Error("denied")), writeText },
    });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    await expect(
      writeTextToClipboard(
        "<table></table>",
        undefined,
        { "text/html": "<table></table>" },
        { requireHtml: true },
      ),
    ).rejects.toMatchObject({ _tag: "ClipboardWriteError" });
    expect(writeText).not.toHaveBeenCalled();
    await expect(writeTextToClipboard("plain")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("plain");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps caller-built rich HTML when attaching a context fragment", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    const fragment = JSON.stringify({ version: 1, source: {}, records: [] });
    const rich = "<p><strong>Message</strong></p>";

    await expect(
      writeTextToClipboard("Message", undefined, {
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment,
        "text/html": rich,
      }),
    ).resolves.toBe(true);

    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    const html = await items[0]!.data["text/html"]!.text();
    expect(html).toContain(rich);
    expect(html).toContain("data-t3-context-fragment=");
  });

  it("keeps empty strings as no-ops by default but allows explicit empty copies with fallback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(writeTextToClipboard("")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();

    await expect(
      writeTextToClipboard("", undefined, undefined, { allowEmpty: true }),
    ).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("");

    writeText.mockRejectedValueOnce(new Error("denied"));
    await expect(
      writeTextToClipboard("", undefined, undefined, { allowEmpty: true }),
    ).rejects.toMatchObject({ _tag: "ClipboardWriteError" });
  });

  it("falls back to execCommand for empty text and TSV when navigator.clipboard is unavailable", async () => {
    const setupDom = (execResult: boolean) => {
      let copyListener: ((event: unknown) => void) | undefined;
      const setData = vi.fn();
      const preventDefault = vi.fn();
      const previousFocus = vi.fn();
      const textarea = {
        value: "",
        style: {} as Record<string, string>,
        setAttribute: vi.fn(),
        addEventListener: vi.fn((type: string, cb: (event: unknown) => void) => {
          if (type === "copy") copyListener = cb;
        }),
        removeEventListener: vi.fn(),
        focus: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn(),
        remove: vi.fn(),
      };
      const execCommand = vi.fn(() => {
        copyListener?.({ clipboardData: { setData }, preventDefault });
        return execResult;
      });
      vi.stubGlobal("window", {});
      vi.stubGlobal("navigator", {});
      vi.stubGlobal("document", {
        activeElement: { focus: previousFocus },
        body: { appendChild: vi.fn() },
        createElement: vi.fn(() => textarea),
        execCommand,
      });
      return { execCommand, setData, preventDefault, previousFocus };
    };

    const empty = setupDom(true);
    await expect(
      writeTextToClipboard("", undefined, undefined, { allowEmpty: true }),
    ).resolves.toBe(true);
    expect(empty.execCommand).toHaveBeenCalledWith("copy");
    expect(empty.setData).toHaveBeenCalledWith("text/plain", "");
    expect(empty.preventDefault).toHaveBeenCalledOnce();
    expect(empty.previousFocus).toHaveBeenCalledOnce();

    const tsv = setupDom(true);
    await expect(
      writeTextToClipboard("a\tb\r\nc\td", undefined, undefined, { allowEmpty: true }),
    ).resolves.toBe(true);
    expect(tsv.execCommand).toHaveBeenCalledWith("copy");
    expect(tsv.setData).toHaveBeenCalledWith("text/plain", "a\tb\r\nc\td");

    const failing = setupDom(false);
    await expect(
      writeTextToClipboard("a\tb", undefined, undefined, { allowEmpty: true }),
    ).rejects.toMatchObject({ _tag: "ClipboardApiUnavailableError" });
    expect(failing.execCommand).toHaveBeenCalledWith("copy");
  });
});
