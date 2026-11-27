import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act } from "../../../../test/render";
import { buildWorkbook, renderSheet } from "./sheet-test-helpers";

function buildHyperlinkWorkbook() {
  return buildWorkbook(
    '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      "<sheetData>" +
      '<row r="1">' +
      '<c r="A1" t="inlineStr"><is><t>Plain</t></is></c>' +
      '<c r="B1" t="inlineStr"><is><t>External</t></is></c>' +
      '<c r="C1" t="inlineStr"><is><t>SameSheet</t></is></c>' +
      '<c r="D1" t="inlineStr"><is><t>OtherSheet</t></is></c>' +
      '<c r="E1" t="inlineStr"><is><t>Unsafe</t></is></c>' +
      "</row>" +
      '<row r="2"><c r="B2" t="inlineStr"><is><t>Below</t></is></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Landing</t></is></c></row>' +
      "</sheetData>" +
      "<hyperlinks>" +
      '<hyperlink ref="B1" r:id="rIdExternal"/>' +
      '<hyperlink ref="C1" location="A3"/>' +
      '<hyperlink ref="D1" location="Target!B2"/>' +
      '<hyperlink ref="E1" r:id="rIdUnsafe"/>' +
      "</hyperlinks>" +
      "</worksheet>",
    {
      sheetRelsXml:
        "<Relationships>" +
        '<Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/docs" TargetMode="External"/>' +
        '<Relationship Id="rIdUnsafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>' +
        "</Relationships>",
      extraSheets: [
        {
          name: "Target",
          sheetXml:
            '<worksheet><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>Dest</t></is></c></row></sheetData></worksheet>',
        },
      ],
    },
  );
}

function createCellPointers(root: HTMLElement, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const cellCenter = (row: number, col: number) => ({
    clientX: rect.left + 44 + col * 64 + 32,
    clientY: rect.top + 20 + row * 20 + 10,
  });
  const headerCenter = (col: number) => ({
    clientX: rect.left + 44 + col * 64 + 32,
    clientY: rect.top + 10,
  });
  const dispatch = async (
    type: "pointerdown" | "pointermove" | "pointerup",
    coords: { clientX: number; clientY: number },
    init?: PointerEventInit,
  ) => {
    const defaults: PointerEventInit =
      type === "pointermove"
        ? { button: -1, buttons: 1 }
        : type === "pointerup"
          ? { button: 0, buttons: 0 }
          : { button: 0, buttons: 1 };
    await act(() => {
      root.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          ...defaults,
          ...coords,
          ...init,
        }),
      );
    });
  };
  const clickCell = async (row: number, col: number, init?: PointerEventInit) => {
    const point = cellCenter(row, col);
    await dispatch("pointerdown", point, init);
    await dispatch("pointerup", point, init);
  };
  return { cellCenter, headerCenter, dispatch, clickCell };
}

describe("Spreadsheet grid hyperlink pointer interactions", () => {
  it("opens safe external hyperlinks on single click (including small in-cell jitter) and ignores unsafe schemes", async () => {
    const bytes = await buildHyperlinkWorkbook();
    await using rendered = await renderSheet(bytes);
    const { root, canvas } = rendered;
    // Synthetic pointer events have no browser pointer to capture.
    using _capture = vi.spyOn(root, "setPointerCapture").mockImplementation(() => {});
    using _release = vi.spyOn(root, "releasePointerCapture").mockImplementation(() => {});
    using openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const { cellCenter, dispatch, clickCell } = createCellPointers(root, canvas);

    await clickCell(0, 1);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenLastCalledWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    );
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-0-1");

    // Micro-jitter inside the same cell still counts as a click.
    const b1 = cellCenter(0, 1);
    await dispatch("pointerdown", b1);
    await dispatch("pointermove", { clientX: b1.clientX + 2, clientY: b1.clientY + 1 });
    await dispatch("pointerup", { clientX: b1.clientX + 2, clientY: b1.clientY + 1 });
    expect(openSpy).toHaveBeenCalledTimes(2);

    // Unsafe javascript: URL is blocked.
    await clickCell(0, 4);
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-0-4");
  });

  it("navigates same-sheet and cross-sheet internal hyperlinks on single click", async () => {
    const bytes = await buildHyperlinkWorkbook();
    await using rendered = await renderSheet(bytes);
    const { screen, root, canvas } = rendered;
    using _capture = vi.spyOn(root, "setPointerCapture").mockImplementation(() => {});
    using _release = vi.spyOn(root, "releasePointerCapture").mockImplementation(() => {});
    using openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const { clickCell } = createCellPointers(root, canvas);

    // C1 -> A3 on the same sheet.
    await clickCell(0, 2);
    expect(openSpy).not.toHaveBeenCalled();
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-2-0");

    // D1 -> Target!B2 on another sheet.
    await clickCell(0, 3);
    expect(openSpy).not.toHaveBeenCalled();
    const targetGrid = screen.getByRole("grid", { name: "Target" });
    await expect.element(targetGrid).toBeVisible();
    expect(targetGrid.element().getAttribute("aria-activedescendant")).toBe("office-cell-1-1");
    expect(
      screen.getByRole("tab", { name: "Target" }).element().getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("extends selection on Shift+click without opening external or jumping internal hyperlinks", async () => {
    const bytes = await buildHyperlinkWorkbook();
    await using rendered = await renderSheet(bytes);
    const { screen, root, canvas } = rendered;
    using _capture = vi.spyOn(root, "setPointerCapture").mockImplementation(() => {});
    using _release = vi.spyOn(root, "releasePointerCapture").mockImplementation(() => {});
    using openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const { cellCenter, dispatch, clickCell } = createCellPointers(root, canvas);

    await clickCell(0, 0);
    await clickCell(0, 1, { shiftKey: true });
    expect(openSpy).not.toHaveBeenCalled();
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-0-1");
    await userEvent.keyboard("{Control>}c{/Control}");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("Plain\tExternal"));

    // Releasing Shift before pointerup still must not trigger hyperlink open.
    writeText.mockClear();
    await clickCell(0, 0);
    await dispatch("pointerdown", cellCenter(0, 1), { shiftKey: true });
    await dispatch("pointerup", cellCenter(0, 1), { shiftKey: false });
    expect(openSpy).not.toHaveBeenCalled();
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-0-1");
    await userEvent.keyboard("{Control>}c{/Control}");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("Plain\tExternal"));

    // Shift+click on same-sheet internal hyperlink extends selection instead of jumping to A3.
    writeText.mockClear();
    await clickCell(0, 2, { shiftKey: true });
    expect(openSpy).not.toHaveBeenCalled();
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-0-2");
    await userEvent.keyboard("{Control>}c{/Control}");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("Plain\tExternal\tSameSheet"));

    // Shift+click on cross-sheet internal hyperlink extends selection instead of switching tabs.
    writeText.mockClear();
    await clickCell(0, 3, { shiftKey: true });
    expect(openSpy).not.toHaveBeenCalled();
    expect(
      screen.getByRole("tab", { name: "Sample" }).element().getAttribute("aria-selected"),
    ).toBe("true");
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-0-3");
    await userEvent.keyboard("{Control>}c{/Control}");
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Plain\tExternal\tSameSheet\tOtherSheet"),
    );
  });

  it("keeps drag selection and does not open or jump when dragging out of a hyperlink cell and back", async () => {
    const bytes = await buildHyperlinkWorkbook();
    await using rendered = await renderSheet(bytes);
    const { screen, root, canvas } = rendered;
    using _capture = vi.spyOn(root, "setPointerCapture").mockImplementation(() => {});
    using _release = vi.spyOn(root, "releasePointerCapture").mockImplementation(() => {});
    using openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const { cellCenter, headerCenter, dispatch } = createCellPointers(root, canvas);

    // Drag B1 -> B2 -> B1 and release on B1.
    await dispatch("pointerdown", cellCenter(0, 1));
    await dispatch("pointermove", cellCenter(1, 1));
    await dispatch("pointermove", cellCenter(0, 1));
    await dispatch("pointerup", cellCenter(0, 1));
    expect(openSpy).not.toHaveBeenCalled();
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-0-1");
    await userEvent.keyboard("{Control>}c{/Control}");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("External"));

    // Drag B1 -> column header -> B1 and release on B1.
    writeText.mockClear();
    await dispatch("pointerdown", cellCenter(0, 1));
    await dispatch("pointermove", headerCenter(1));
    await dispatch("pointermove", cellCenter(0, 1));
    await dispatch("pointerup", cellCenter(0, 1));
    expect(openSpy).not.toHaveBeenCalled();
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-0-1");
    await userEvent.keyboard("{Control>}c{/Control}");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("External"));

    // Drag same-sheet link C1 -> B1 -> C1 and release on C1 (must not jump to A3).
    writeText.mockClear();
    await dispatch("pointerdown", cellCenter(0, 2));
    await dispatch("pointermove", cellCenter(0, 1));
    await dispatch("pointermove", cellCenter(0, 2));
    await dispatch("pointerup", cellCenter(0, 2));
    expect(openSpy).not.toHaveBeenCalled();
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-0-2");
    await userEvent.keyboard("{Control>}c{/Control}");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("SameSheet"));

    // Drag cross-sheet link D1 -> C1 -> D1 and release on D1 (must stay on Sample).
    writeText.mockClear();
    await dispatch("pointerdown", cellCenter(0, 3));
    await dispatch("pointermove", cellCenter(0, 2));
    await dispatch("pointermove", cellCenter(0, 3));
    await dispatch("pointerup", cellCenter(0, 3));
    expect(openSpy).not.toHaveBeenCalled();
    expect(
      screen.getByRole("tab", { name: "Sample" }).element().getAttribute("aria-selected"),
    ).toBe("true");
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-0-3");
    await userEvent.keyboard("{Control>}c{/Control}");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("OtherSheet"));

    // Normal drag selection B1 -> B2 keeps range selection without opening link.
    writeText.mockClear();
    await dispatch("pointerdown", cellCenter(0, 1));
    await dispatch("pointermove", cellCenter(1, 1));
    await dispatch("pointerup", cellCenter(1, 1));
    expect(openSpy).not.toHaveBeenCalled();
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-1-1");
    await userEvent.keyboard("{Control>}c{/Control}");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("External\r\nBelow"));
  });
});
