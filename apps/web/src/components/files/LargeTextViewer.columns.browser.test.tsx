import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { act, render } from "../../../test/render";
import LargeTextViewer from "./LargeTextViewer";
import {
  LARGE_TEXT_MAX_COLUMNS,
  PREVIEW_PAGE_ROWS,
  type TextPreviewResult,
} from "./largeTextProtocol";

const TRUNCATION_NOTICE = "Showing the first 1,024 columns. Source and Save retain every column.";

function makeDelimitedRows(
  headerColumns: number,
  rows: readonly { columns: number; prefix: string }[],
  delimiter: "," | "\t",
  trailingNewline = true,
) {
  const lines = [
    Array.from({ length: headerColumns }, (_, i) => `h${i + 1}`).join(delimiter),
    ...rows.map((row) =>
      Array.from({ length: row.columns }, (_, i) => `${row.prefix}${i + 1}`).join(delimiter),
    ),
  ];
  return trailingNewline ? `${lines.join("\n")}\n` : lines.join("\n");
}

function workerMessages(src: string, delimiter: "," | "\t") {
  const worker = new Worker(new URL("./largeText.worker.ts", import.meta.url), {
    type: "module",
  });
  return new Promise<{
    metas: Extract<TextPreviewResult, { type: "meta" }>[];
    pages: Extract<TextPreviewResult, { type: "page" }>[];
  }>((resolve, reject) => {
    const metas: Extract<TextPreviewResult, { type: "meta" }>[] = [];
    const pages: Extract<TextPreviewResult, { type: "page" }>[] = [];
    let sawCompleteMeta = false;
    worker.addEventListener("message", (event: MessageEvent<TextPreviewResult>) => {
      const data = event.data;
      if (data.type === "error") {
        worker.terminate();
        reject(new Error(data.code));
        return;
      }
      if (data.type === "meta") {
        metas.push(data);
        if (data.complete) sawCompleteMeta = true;
      } else if (data.type === "page") {
        pages.push(data);
        if (sawCompleteMeta && data.index === 0) {
          worker.terminate();
          resolve({ metas, pages });
        }
      }
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(new Error(event.message));
    });
    worker.postMessage({ type: "open", src, delimiter }, []);
  });
}

describe("LargeTextViewer column counts and truncation notice", () => {
  it.each([
    { delimiter: "," as const, ext: "csv", columns: 1023, truncated: false },
    { delimiter: "," as const, ext: "csv", columns: 1024, truncated: false },
    { delimiter: "," as const, ext: "csv", columns: 1025, truncated: true },
    { delimiter: "\t" as const, ext: "tsv", columns: 1023, truncated: false },
    { delimiter: "\t" as const, ext: "tsv", columns: 1024, truncated: false },
    { delimiter: "\t" as const, ext: "tsv", columns: 1025, truncated: true },
  ])(
    "reports $columns columns (truncated=$truncated) for $ext without false positives at 1024",
    async ({ delimiter, ext, columns, truncated }) => {
      const text = makeDelimitedRows(columns, [{ columns, prefix: "v" }], delimiter);
      const copyContents = { current: null as (() => Promise<string>) | null };
      const src = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      try {
        await using screen = await render(
          <div style={{ display: "flex", height: 400, width: 600 }}>
            <LargeTextViewer
              name={`wide-${columns}.${ext}`}
              src={src}
              sizeBytes={text.length}
              delimiter={delimiter}
              copyContents={copyContents}
            />
          </div>,
        );
        const status = () => screen.container.querySelector('[role="status"]')?.textContent ?? "";
        await vi.waitFor(
          () => expect(status()).toContain(`1 row · ${columns.toLocaleString()} columns ·`),
          { timeout: 10_000 },
        );

        const expectedRenderedCols = Math.min(columns, LARGE_TEXT_MAX_COLUMNS);
        const table = screen.container.querySelector('[role="table"]');
        expect(table?.getAttribute("aria-colcount")).toBe(String(expectedRenderedCols));

        if (truncated) {
          expect(screen.container.textContent).toContain(TRUNCATION_NOTICE);
        } else {
          expect(screen.container.textContent).not.toContain(TRUNCATION_NOTICE);
        }

        const scroller = table!.parentElement!;
        await act(() => {
          scroller.scrollLeft = scroller.scrollWidth;
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        });

        await vi.waitFor(() => {
          const header = screen.container.querySelector(
            `[role="columnheader"][aria-colindex="${expectedRenderedCols}"]`,
          );
          expect(header?.textContent).toBe(`h${expectedRenderedCols}`);
        });
        expect(screen.container.textContent).toContain(`v${expectedRenderedCols}`);
        expect(
          screen.container.querySelector(`[aria-colindex="${LARGE_TEXT_MAX_COLUMNS + 1}"]`),
        ).toBeNull();
        if (truncated) {
          expect(screen.container.textContent).not.toContain(`h${columns}`);
          expect(screen.container.textContent).not.toContain(`v${columns}`);
          expect(await copyContents.current!()).toBe(text);
        }
      } finally {
        URL.revokeObjectURL(src);
      }
    },
  );

  it.each([
    { delimiter: "," as const, ext: "csv", wideColumns: 1024, truncated: false },
    { delimiter: "," as const, ext: "csv", wideColumns: 1025, truncated: true },
    { delimiter: "\t" as const, ext: "tsv", wideColumns: 1024, truncated: false },
    { delimiter: "\t" as const, ext: "tsv", wideColumns: 1025, truncated: true },
  ])(
    "detects wider later data rows ($wideColumns columns) past header and first screen in $ext",
    async ({ delimiter, ext, wideColumns, truncated }) => {
      // Make early rows span past PREVIEW_PAGE_ROWS (32) and FIRST_SCREEN_BYTES (16 KB)
      // so neither the first-screen prefetch nor page 0 contains the wide trailing row.
      const filler = "p".repeat(500);
      const fillerRows = Array.from({ length: PREVIEW_PAGE_ROWS + 4 }, (_, i) =>
        [filler, `r${i + 1}`, "x"].join(delimiter),
      );
      const wideRow = Array.from({ length: wideColumns }, (_, i) => `w${i + 1}`).join(delimiter);
      const text = `h1${delimiter}h2${delimiter}h3\n${fillerRows.join("\n")}\n${wideRow}`;
      const expectedRows = fillerRows.length + 1;
      const src = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      try {
        await using screen = await render(
          <div style={{ display: "flex", height: 400, width: 600 }}>
            <LargeTextViewer
              name={`later-wide-${wideColumns}.${ext}`}
              src={src}
              sizeBytes={text.length}
              delimiter={delimiter}
            />
          </div>,
        );

        const status = () => screen.container.querySelector('[role="status"]')?.textContent ?? "";
        await vi.waitFor(
          () =>
            expect(status()).toContain(
              `${expectedRows} rows · ${wideColumns.toLocaleString()} columns ·`,
            ),
          { timeout: 10_000 },
        );

        const table = screen.container.querySelector('[role="table"]');
        expect(table?.getAttribute("aria-colcount")).toBe(String(LARGE_TEXT_MAX_COLUMNS));
        if (truncated) {
          expect(screen.container.textContent).toContain(TRUNCATION_NOTICE);
        } else {
          expect(screen.container.textContent).not.toContain(TRUNCATION_NOTICE);
        }

        const scroller = table!.parentElement!;
        await act(() => {
          scroller.scrollLeft = scroller.scrollWidth;
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        // Columns wider than the 3-column header fall back to Excel-style labels; 1024 -> AMJ.
        await vi.waitFor(() => {
          const lastHeader = screen.container.querySelector(
            `[role="columnheader"][aria-colindex="${LARGE_TEXT_MAX_COLUMNS}"]`,
          );
          expect(lastHeader?.textContent).toBe("AMJ");
        });
        expect(
          screen.container.querySelector(`[aria-colindex="${LARGE_TEXT_MAX_COLUMNS + 1}"]`),
        ).toBeNull();
      } finally {
        URL.revokeObjectURL(src);
      }
    },
  );

  it("separates displayedColumns and totalColumns in largeText.worker.ts meta while bounding page rows", async () => {
    for (const [headerCols, bodyCols] of [
      [1023, 1023],
      [1024, 1024],
      [1025, 1025],
      [3, 1030],
    ] as const) {
      const text = makeDelimitedRows(headerCols, [{ columns: bodyCols, prefix: "c" }], ",", false);
      const src = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      try {
        const { metas, pages } = await workerMessages(src, ",");
        const finalMeta = metas.at(-1);
        expect(finalMeta).toMatchObject({
          type: "meta",
          count: 2,
          displayedColumns: Math.min(LARGE_TEXT_MAX_COLUMNS, Math.max(headerCols, bodyCols)),
          totalColumns: Math.max(headerCols, bodyCols),
          complete: true,
        });
        const lastPage = pages.at(-1)!;
        expect(lastPage.rows[0]!.length).toBe(Math.min(LARGE_TEXT_MAX_COLUMNS, headerCols));
        expect(lastPage.rows[1]!.length).toBe(Math.min(LARGE_TEXT_MAX_COLUMNS, bodyCols));
      } finally {
        URL.revokeObjectURL(src);
      }
    }
  });
});
