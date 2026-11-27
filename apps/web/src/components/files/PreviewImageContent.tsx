import { useGT } from "gt-react";
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import {
  Grid2x2Icon,
  MaximizeIcon,
  MinusIcon,
  MoonIcon,
  PlusIcon,
  ScanIcon,
  SunIcon,
} from "lucide-react";
import { ExpandedImageDialog } from "~/components/chat/ExpandedImageDialog";
import { observeResize } from "~/lib/observeResize";
import { AttachmentImage } from "../media/AttachmentImage";
import { FileSurfaceAction, FileSurfaceFailure } from "./fileSurfaceChrome";

type ImageBackdrop = "checker" | "light" | "dark";

const IMAGE_BACKDROP_STYLES: Record<ImageBackdrop, CSSProperties> = {
  checker: {
    backgroundColor: "#e5e7eb",
    backgroundImage:
      "linear-gradient(45deg, #cbd5e1 25%, transparent 25%), linear-gradient(-45deg, #cbd5e1 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #cbd5e1 75%), linear-gradient(-45deg, transparent 75%, #cbd5e1 75%)",
    backgroundSize: "16px 16px",
    backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
  },
  light: {
    backgroundColor: "#ffffff",
  },
  dark: {
    backgroundColor: "#18181b",
  },
};

export default function PreviewImageContent(props: {
  readonly src: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly onError?: () => void;
}) {
  const gt = useGT();
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [backdrop, setBackdrop] = useState<ImageBackdrop>("checker");
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure the image viewport before paint and observe resizes to keep fit-to-view scaling accurate.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    // clientWidth rounds a fractional pane size up, and an image fitted to it overflows the pane.
    // The computed size keeps the fraction; it reads "auto" while an ancestor is display:none.
    const update = () => {
      const size = getComputedStyle(node);
      setViewport({
        width: Math.floor(Number.parseFloat(size.width) || 0),
        height: Math.floor(Number.parseFloat(size.height) || 0),
      });
    };
    update();
    return observeResize(node, update);
  }, []);
  const fit = natural.width
    ? Math.min(
        1,
        Math.max(1, viewport.width - 32) / natural.width,
        Math.max(1, viewport.height - 32) / natural.height,
      )
    : 1;
  const scale = zoom ?? fit;
  const changeZoom = (factor: number) => setZoom(Math.max(0.05, Math.min(8, scale * factor)));
  if (failed) return <FileSurfaceFailure message={gt("Unable to load image.")} />;
  return (
    <>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-1 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {natural.width
            ? `${natural.width.toLocaleString()} × ${natural.height.toLocaleString()}`
            : gt("Loading image…")}
        </span>
        <div className="flex items-center gap-1">
          <FileSurfaceAction
            label={gt("Zoom out")}
            disabled={!natural.width || scale <= 0.05}
            onPress={() => changeZoom(1 / 1.25)}
          >
            <MinusIcon className="size-3.5" />
          </FileSurfaceAction>
          <span className="min-w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
          <FileSurfaceAction
            label={gt("Zoom in")}
            disabled={!natural.width || scale >= 8}
            onPress={() => changeZoom(1.25)}
          >
            <PlusIcon className="size-3.5" />
          </FileSurfaceAction>
          <FileSurfaceAction
            label={gt("Fit image")}
            pressed={zoom === null}
            onPress={() => setZoom(null)}
          >
            <ScanIcon className="size-3.5" />
          </FileSurfaceAction>
          <FileSurfaceAction
            label={gt("Actual image size")}
            pressed={zoom === 1}
            onPress={() => setZoom(1)}
          >
            <MaximizeIcon className="size-3.5" />
          </FileSurfaceAction>
          <span aria-hidden className="mx-1 h-3.5 w-px bg-border/60" />
          <FileSurfaceAction
            label={gt("Checkerboard background")}
            pressed={backdrop === "checker"}
            onPress={() => setBackdrop("checker")}
          >
            <Grid2x2Icon className="size-3.5" />
          </FileSurfaceAction>
          <FileSurfaceAction
            label={gt("Light background")}
            pressed={backdrop === "light"}
            onPress={() => setBackdrop("light")}
          >
            <SunIcon className="size-3.5" />
          </FileSurfaceAction>
          <FileSurfaceAction
            label={gt("Dark background")}
            pressed={backdrop === "dark"}
            onPress={() => setBackdrop("dark")}
          >
            <MoonIcon className="size-3.5" />
          </FileSurfaceAction>
        </div>
      </div>
      <div ref={ref} className="min-h-0 flex-1 overflow-auto">
        <div
          className="flex min-h-full min-w-full items-center justify-center p-4"
          style={{
            width: natural.width ? natural.width * scale + 32 : undefined,
            height: natural.height ? natural.height * scale + 32 : undefined,
          }}
        >
          <button
            type="button"
            data-backdrop={backdrop}
            aria-label={gt("Zoom {name}", { name: props.name })}
            className="shrink-0 cursor-zoom-in"
            style={
              natural.width
                ? {
                    ...IMAGE_BACKDROP_STYLES[backdrop],
                    boxShadow: "0 0 0 1px rgb(128 128 128 / 0.25)",
                  }
                : undefined
            }
            onClick={() => setExpanded(true)}
          >
            <AttachmentImage
              name={props.name}
              mimeType={props.mimeType}
              src={props.src}
              alt={props.name}
              className="block max-w-none"
              // A cached image has its natural size before onLoad runs, so it stays at 0x0 until the
              // fit scale is known instead of painting at full size for a frame.
              style={
                natural.width
                  ? { width: natural.width * scale, height: natural.height * scale }
                  : { width: 0, height: 0 }
              }
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={() => {
                setFailed(true);
                props.onError?.();
              }}
            />
          </button>
        </div>
      </div>
      {expanded ? (
        <ExpandedImageDialog
          preview={{
            images: [
              {
                src: props.src,
                name: props.name,
                ...(props.mimeType ? { mimeType: props.mimeType } : {}),
              },
            ],
            index: 0,
          }}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </>
  );
}
