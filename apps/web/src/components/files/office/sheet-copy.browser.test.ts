import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { buildWorkbook, renderSheet } from "./sheet-test-helpers";

function withoutAsyncClipboard() {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  return {
    [Symbol.dispose]() {
      Reflect.deleteProperty(navigator, "clipboard");
      if (original) Object.defineProperty(Navigator.prototype, "clipboard", original);
    },
  };
}

describe("Spreadsheet grid clipboard copy", () => {
  it("copies selection TSV, empty cells, and handles rejection and recovery with navigator.clipboard", async () => {
    const bytes = await buildWorkbook(
      "<worksheet><sheetData>" +
        '<row r="1"><c r="A1"><v>42</v></c><c r="C1" t="inlineStr"><is><t>end</t></is></c></row>' +
        '<row r="2"><c r="A2"><v>10</v></c><c r="B2" t="inlineStr"><is><t>world</t></is></c></row>' +
        "</sheetData></worksheet>",
    );
    await using rendered = await renderSheet(bytes);
    const { screen } = rendered;
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    try {
      // Extend A1 -> A1:C2 (B1 and C2 are empty cells).
      await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{ArrowDown}{/Shift}");
      await userEvent.keyboard("{Control>}c{/Control}");
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("42\t\tend\r\n10\tworld\t"));
      expect(screen.container.querySelector('[role="status"]')).toBeNull();

      // Collapsing from A1:C2 with ArrowRight lands on empty cell C2.
      writeText.mockClear();
      await userEvent.keyboard("{ArrowRight}");
      await userEvent.keyboard("{Control>}c{/Control}");
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(""));
      expect(screen.container.querySelector('[role="status"]')).toBeNull();

      // Failure notice appears on clipboard rejection, then clears when copy succeeds again.
      writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
      await userEvent.keyboard("{Control>}c{/Control}");
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent("The selected cells could not be copied.");

      writeText.mockResolvedValueOnce(undefined);
      await userEvent.keyboard("{ArrowLeft}");
      await userEvent.keyboard("{Control>}c{/Control}");
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("world"));
      await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    } finally {
      writeText.mockRestore();
    }
  });

  it("falls back to execCommand copy for TSV and empty cells when navigator.clipboard is unavailable", async () => {
    const bytes = await buildWorkbook(
      "<worksheet><sheetData>" +
        '<row r="1"><c r="A1"><v>42</v></c><c r="C1" t="inlineStr"><is><t>end</t></is></c></row>' +
        '<row r="2"><c r="A2"><v>10</v></c><c r="B2" t="inlineStr"><is><t>world</t></is></c></row>' +
        "</sheetData></worksheet>",
    );
    await using rendered = await renderSheet(bytes);
    const { screen, root } = rendered;
    using _noClipboard = withoutAsyncClipboard();
    const execCommand = vi.spyOn(document, "execCommand");
    const copiedPayloads: string[] = [];
    const onCopy = (event: ClipboardEvent) => {
      if (event.clipboardData) copiedPayloads.push(event.clipboardData.getData("text/plain"));
    };
    document.addEventListener("copy", onCopy);
    try {
      await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{ArrowDown}{/Shift}");
      await userEvent.keyboard("{Control>}c{/Control}");
      await vi.waitFor(() => expect(copiedPayloads).toEqual(["42\t\tend\r\n10\tworld\t"]));
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(screen.container.querySelector('[role="status"]')).toBeNull();
      expect(document.activeElement).toBe(root);

      // Collapsing from A1:C2 with ArrowRight lands on empty cell C2 through the fallback path.
      await userEvent.keyboard("{ArrowRight}");
      await userEvent.keyboard("{Control>}c{/Control}");
      await vi.waitFor(() => expect(copiedPayloads).toEqual(["42\t\tend\r\n10\tworld\t", ""]));
      expect(execCommand).toHaveBeenCalledTimes(2);
      expect(screen.container.querySelector('[role="status"]')).toBeNull();
      expect(document.activeElement).toBe(root);
    } finally {
      document.removeEventListener("copy", onCopy);
      execCommand.mockRestore();
    }
  });

  it("shows copy failure notice when both navigator.clipboard and execCommand fallback fail", async () => {
    const bytes = await buildWorkbook(
      '<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>',
    );
    await using _rendered = await renderSheet(bytes);
    using _noClipboard = withoutAsyncClipboard();
    const execCommand = vi.spyOn(document, "execCommand").mockReturnValue(false);
    try {
      await userEvent.keyboard("{Control>}c{/Control}");
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent("The selected cells could not be copied.");
      expect(execCommand).toHaveBeenCalledWith("copy");
    } finally {
      execCommand.mockRestore();
    }
  });

  it("enforces the 200,000-cell copy limit without touching the clipboard", async () => {
    const bytes = await buildWorkbook(
      "<worksheet><sheetData>" +
        '<row r="1"><c r="A1"><v>1</v></c></row>' +
        '<row r="10001"><c r="T10001"><v>2</v></c></row>' +
        "</sheetData></worksheet>",
    );
    await using _rendered = await renderSheet(bytes);
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const execCommand = vi.spyOn(document, "execCommand");
    try {
      await userEvent.keyboard("{Control>}a{/Control}");
      await userEvent.keyboard("{Control>}c{/Control}");
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent("Select fewer than 200,000 cells to copy.");
      expect(writeText).not.toHaveBeenCalled();
      expect(execCommand).not.toHaveBeenCalled();
    } finally {
      writeText.mockRestore();
      execCommand.mockRestore();
    }
  });
});
