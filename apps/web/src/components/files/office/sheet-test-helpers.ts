import { createElement } from "react";
import { expect, vi } from "vite-plus/test";
import JSZip from "jszip";
import "~/index.css";
import { act, render } from "../../../../test/render";
import Spreadsheet from "./Spreadsheet";

export const defaultView = {
  hiddenGridlines: [],
  themeFonts: { major: "Calibri Light", minor: "Calibri" },
};

export async function buildWorkbook(
  sheetXml: string,
  options?: {
    readonly sheetName?: string;
    readonly sheetRelsXml?: string;
    readonly extraSheets?: readonly {
      readonly name: string;
      readonly sheetXml: string;
      readonly sheetRelsXml?: string;
    }[];
  },
) {
  const archive = new JSZip();
  const sheets = [
    {
      name: options?.sheetName ?? "Sample",
      sheetXml,
      sheetRelsXml: options?.sheetRelsXml,
    },
    ...(options?.extraSheets ?? []),
  ];
  archive.file(
    "xl/workbook.xml",
    `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map(
        (sheet, index) =>
          `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
      )
      .join("")}</sheets></workbook>`,
  );
  archive.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships>${sheets
      .map(
        (_, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join("")}</Relationships>`,
  );
  for (const [index, sheet] of sheets.entries()) {
    const number = index + 1;
    archive.file(`xl/worksheets/sheet${number}.xml`, sheet.sheetXml);
    if (sheet.sheetRelsXml) {
      archive.file(`xl/worksheets/_rels/sheet${number}.xml.rels`, sheet.sheetRelsXml);
    }
  }
  return archive.generateAsync({ type: "arraybuffer" });
}

export async function renderSheet(bytes: ArrayBuffer, sheetName = "Sample") {
  const container = document.createElement("div");
  Object.assign(container.style, { display: "flex", width: "500px", height: "300px" });
  const screen = await render(
    createElement(Spreadsheet, {
      bytes,
      view: defaultView,
      onDetails: vi.fn(),
      onError: vi.fn(),
    }),
    { container },
  );
  const grid = screen.getByRole("grid", { name: sheetName });
  await expect.element(grid).toBeVisible();
  const root = grid.element() as HTMLElement;
  const canvas = root.querySelector("canvas")!;
  await vi.waitFor(() => {
    expect(canvas.getContext("2d")!.getImageData(10, 10, 1, 1).data[0]).toBeGreaterThan(0);
    expect(canvas.getContext("2d")!.getImageData(10, 10, 1, 1).data[0]).toBeLessThan(255);
  });
  await act(() => root.focus());
  expect(document.activeElement).toBe(root);
  return {
    screen,
    root,
    canvas,
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}
