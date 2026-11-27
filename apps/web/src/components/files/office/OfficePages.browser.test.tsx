import { createRef, useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../../test/render";
import "~/index.css";
import { OfficePages, type PageSize, type PaintPage } from "./OfficePages";

function createContainer() {
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;width:400px;height:400px";
  return container;
}

function makePages(count: number, width = 400, height = 240): PageSize[] {
  return Array.from({ length: count }, () => ({ width, height }));
}

function expectedScrollTop(row: HTMLElement, pageWidth: number, containerWidth: number, y = 0) {
  const scale = pageWidth > 0 ? Math.min(1, Math.max(0, containerWidth - 48) / pageWidth) : 0;
  return Math.max(0, row.offsetTop + y * scale - 24);
}

async function nextFrames(count = 2) {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

async function flushAllMountBatches() {
  while (vi.getTimerCount() > 0) {
    await act(() => vi.advanceTimersToNextTimerAsync());
  }
}

function expectScrollClose(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1.5);
}

it("jumps to an initially unmounted far page with y offset while keeping viewport-only rendering", async () => {
  const scrollRef = createRef<((index: number, y?: number) => void) | null>();
  const paint = vi.fn<PaintPage>(async () => undefined);
  const renderedOverlays = new Set<number>();
  const pages = makePages(120);
  let mountedBeforeJump = 0;

  function Harness() {
    useLayoutEffect(() => {
      mountedBeforeJump = document.querySelectorAll('[data-office-pages] [role="group"]').length;
      scrollRef.current?.(80, 120);
    }, []);
    return (
      <OfficePages
        pages={pages}
        kind="page"
        paint={paint}
        overlay={(index) => {
          renderedOverlays.add(index);
          return <div data-overlay={index} />;
        }}
        scrollRef={scrollRef}
        onError={(error) => {
          throw error;
        }}
      />
    );
  }

  await using screen = await render(<Harness />, { container: createContainer(), router: false });

  expect(mountedBeforeJump).toBe(6);

  const scroller = screen.container.querySelector<HTMLElement>("[data-office-pages]")!;
  await vi.waitFor(() => {
    const row = screen.container.querySelector<HTMLElement>('[aria-label="Page 81"]');
    expect(row).not.toBeNull();
    const expected = expectedScrollTop(row!, 400, scroller.clientWidth, 120);
    expectScrollClose(scroller.scrollTop, expected);
  });

  await nextFrames(3);
  const paintedIndices = new Set(paint.mock.calls.map(([index]) => index));
  for (let index = 20; index <= 50; index++) {
    expect(paintedIndices.has(index)).toBe(false);
    expect(renderedOverlays.has(index)).toBe(false);
  }
  expect(renderedOverlays.has(80)).toBe(true);
});

it("waits for following batches when jumping to the tail of a newly mounted batch with y offset", async () => {
  using _timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const scrollRef = createRef<((index: number, y?: number) => void) | null>();
  const pages = makePages(120);
  await using screen = await render(
    <OfficePages
      pages={pages}
      kind="page"
      paint={async () => undefined}
      scrollRef={scrollRef}
      onError={(error) => {
        throw error;
      }}
    />,
    { container: createContainer(), router: false },
  );

  await nextFrames();
  const scroller = screen.container.querySelector<HTMLElement>("[data-office-pages]")!;
  expect(screen.container.querySelectorAll('[role="group"]')).toHaveLength(6);
  expect(scroller.clientWidth).toBeGreaterThan(0);

  await act(() => {
    scrollRef.current?.(55, 150);
  });

  await act(() => vi.advanceTimersToNextTimerAsync());
  expect(screen.container.querySelectorAll('[role="group"]')).toHaveLength(56);
  // Page 56 is at the tail of the 56-page batch and cannot reach y=150 without clamping until more pages mount.
  expect(scroller.scrollTop).toBe(0);

  await flushAllMountBatches();
  expect(screen.container.querySelectorAll('[role="group"]')).toHaveLength(120);
  const row = screen.container.querySelector<HTMLElement>('[aria-label="Page 56"]')!;
  const expected = expectedScrollTop(row, 400, scroller.clientWidth, 150);
  expectScrollClose(scroller.scrollTop, expected);
});

it("applies the latest scroll target across rapid consecutive requests", async () => {
  using _timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const farRef = createRef<((index: number, y?: number) => void) | null>();
  await using farScreen = await render(
    <OfficePages
      pages={makePages(120)}
      kind="page"
      paint={async () => undefined}
      scrollRef={farRef}
      onError={(error) => {
        throw error;
      }}
    />,
    { container: createContainer(), router: false },
  );

  await nextFrames();
  expect(farScreen.container.querySelectorAll('[role="group"]')).toHaveLength(6);
  await act(() => {
    farRef.current?.(95, 40);
    farRef.current?.(70, 120);
  });
  await flushAllMountBatches();

  const farScroller = farScreen.container.querySelector<HTMLElement>("[data-office-pages]")!;
  const row70 = farScreen.container.querySelector<HTMLElement>('[aria-label="Page 71"]')!;
  expectScrollClose(
    farScroller.scrollTop,
    expectedScrollTop(row70, 400, farScroller.clientWidth, 120),
  );

  const mountedRef = createRef<((index: number, y?: number) => void) | null>();
  await using mountedScreen = await render(
    <OfficePages
      pages={makePages(120)}
      kind="page"
      paint={async () => undefined}
      scrollRef={mountedRef}
      onError={(error) => {
        throw error;
      }}
    />,
    { container: createContainer(), router: false },
  );

  await nextFrames();
  expect(mountedScreen.container.querySelectorAll('[role="group"]')).toHaveLength(6);
  const mountedScroller = mountedScreen.container.querySelector<HTMLElement>("[data-office-pages]")!;
  const row2 = mountedScreen.container.querySelector<HTMLElement>('[aria-label="Page 3"]')!;
  const expectedRow2 = expectedScrollTop(row2, 400, mountedScroller.clientWidth, 60);

  await act(() => {
    mountedRef.current?.(95, 40);
    mountedRef.current?.(2, 60);
  });
  expectScrollClose(mountedScroller.scrollTop, expectedRow2);

  await flushAllMountBatches();
  expect(mountedScreen.container.querySelectorAll('[role="group"]')).toHaveLength(120);
  expectScrollClose(mountedScroller.scrollTop, expectedRow2);
});

it("drops pending scroll targets when pages change or the component unmounts", async () => {
  using _timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const switchRef = createRef<((index: number, y?: number) => void) | null>();
  const pagesA = makePages(120);
  const pagesB = makePages(120);
  await using switchScreen = await render(
    <OfficePages
      pages={pagesA}
      kind="page"
      paint={async () => undefined}
      scrollRef={switchRef}
      onError={(error) => {
        throw error;
      }}
    />,
    { container: createContainer(), router: false },
  );

  await nextFrames();
  expect(switchScreen.container.querySelectorAll('[role="group"]')).toHaveLength(6);
  await act(() => {
    switchRef.current?.(80, 120);
  });

  await switchScreen.rerender(
    <OfficePages
      pages={pagesB}
      kind="page"
      paint={async () => undefined}
      scrollRef={switchRef}
      onError={(error) => {
        throw error;
      }}
    />,
  );
  await flushAllMountBatches();

  const scroller = switchScreen.container.querySelector<HTMLElement>("[data-office-pages]")!;
  expect(switchScreen.container.querySelectorAll('[role="group"]')).toHaveLength(120);
  expect(scroller.scrollTop).toBe(0);

  const unmountRef = createRef<((index: number, y?: number) => void) | null>();
  await using unmountScreen = await render(
    <OfficePages
      pages={makePages(120)}
      kind="page"
      paint={async () => undefined}
      scrollRef={unmountRef}
      onError={(error) => {
        throw error;
      }}
    />,
    { container: createContainer(), router: false },
  );

  await nextFrames();
  expect(unmountScreen.container.querySelectorAll('[role="group"]')).toHaveLength(6);
  await act(() => {
    unmountRef.current?.(80, 120);
  });
  await unmountScreen.unmount();
  expect(vi.getTimerCount()).toBe(0);
  await act(() => vi.runAllTimersAsync());
});

it("handles incremental layout growth and final page jumps with onPageChange", async () => {
  using _timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const layoutRef = createRef<((index: number, y?: number) => void) | null>();
  await using layoutScreen = await render(
    <OfficePages
      pages={makePages(3)}
      kind="page"
      paint={async () => undefined}
      scrollRef={layoutRef}
      onError={(error) => {
        throw error;
      }}
    />,
    { container: createContainer(), router: false },
  );

  await nextFrames();
  expect(layoutScreen.container.querySelectorAll('[role="group"]')).toHaveLength(3);

  await layoutScreen.rerender(
    <OfficePages
      pages={makePages(120)}
      kind="page"
      paint={async () => undefined}
      scrollRef={layoutRef}
      onError={(error) => {
        throw error;
      }}
    />,
  );
  expect(layoutScreen.container.querySelectorAll('[role="group"]')).toHaveLength(6);

  await act(() => {
    layoutRef.current?.(85, 100);
  });
  await flushAllMountBatches();

  const layoutScroller = layoutScreen.container.querySelector<HTMLElement>("[data-office-pages]")!;
  const row85 = layoutScreen.container.querySelector<HTMLElement>('[aria-label="Page 86"]')!;
  expectScrollClose(
    layoutScroller.scrollTop,
    expectedScrollTop(row85, 400, layoutScroller.clientWidth, 100),
  );

  const finalRef = createRef<((index: number, y?: number) => void) | null>();
  const changed = vi.fn();
  await using finalScreen = await render(
    <OfficePages
      pages={makePages(120)}
      kind="page"
      paint={async () => undefined}
      scrollRef={finalRef}
      onPageChange={changed}
      onError={(error) => {
        throw error;
      }}
    />,
    { container: createContainer(), router: false },
  );

  await nextFrames();
  expect(finalScreen.container.querySelectorAll('[role="group"]')).toHaveLength(6);
  await act(() => {
    finalRef.current?.(119, 0);
  });
  await flushAllMountBatches();
  await nextFrames();

  const finalScroller = finalScreen.container.querySelector<HTMLElement>("[data-office-pages]")!;
  expect(finalScreen.container.querySelector('[aria-label="Page 120"]')).not.toBeNull();
  expect(finalScroller.scrollTop).toBeGreaterThanOrEqual(
    finalScroller.scrollHeight - finalScroller.clientHeight - 1.5,
  );
  expect(changed).toHaveBeenLastCalledWith(119);
});
