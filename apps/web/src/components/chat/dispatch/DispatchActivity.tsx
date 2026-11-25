/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Collapsible, CollapsiblePanel } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";
import type { DispatchEventLogEntry } from "~/state/velaDispatch";

export function DispatchActivity({
  events,
}: {
  readonly events: ReadonlyArray<DispatchEventLogEntry>;
}) {
  const [open, setOpen] = useState(false);

  if (events.length === 0) return null;

  const reversed = [...events].toReversed();

  return (
    <div className="border-t border-border/45">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 transition-transform duration-200 ease-drawer",
            open && "rotate-90",
          )}
        />
        <span>活动记录（{events.length}）</span>
      </button>

      <Collapsible open={open}>
        <CollapsiblePanel>
          <div className="max-h-56 overflow-y-auto px-3.5 pb-3.5">
            <div className="relative space-y-2 border-l border-border/60 pl-3 font-mono text-xs text-muted-foreground">
              {reversed.map((ev) => (
                <div
                  key={`${ev.at}:${ev.stepId ?? ""}:${ev.text}`}
                  className="relative flex gap-2 leading-relaxed"
                >
                  <span
                    aria-hidden="true"
                    className="absolute -left-[15.5px] top-1.5 size-1.5 rounded-full bg-muted-foreground/50"
                  />
                  <span className="shrink-0 opacity-60">
                    {new Date(ev.at).toLocaleTimeString()}
                  </span>
                  <span className="min-w-0 break-words text-foreground/80">
                    {ev.stepId ? `[${ev.stepId}] ` : ""}
                    {ev.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
