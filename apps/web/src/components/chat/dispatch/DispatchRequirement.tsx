/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import type { DispatchRequirementSnapshot } from "~/state/velaDispatch";

export function DispatchRequirement({
  requirement,
}: {
  readonly requirement?: DispatchRequirementSnapshot | null | undefined;
}) {
  const [expanded, setExpanded] = useState(false);

  const summary = requirement?.summary?.trim();
  const userInput = requirement?.userInput?.trim();
  const primaryText = summary || userInput;
  const hasSecondaryInput = Boolean(summary && userInput && summary !== userInput);
  const canToggle = Boolean(primaryText && (primaryText.length > 110 || hasSecondaryInput));

  return (
    <div className="px-3.5 pt-3">
      <div className="space-y-1.5 border-l-2 border-foreground/15 pl-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            本次需求
          </span>
          {canToggle && (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>{expanded ? "收起" : "展开"}</span>
              <ChevronDownIcon
                className={cn(
                  "size-3.5 transition-transform duration-150",
                  expanded && "rotate-180",
                )}
              />
            </button>
          )}
        </div>

        {primaryText ? (
          <div className="space-y-2">
            <p
              className={cn(
                "whitespace-pre-wrap text-sm leading-relaxed text-foreground/90",
                !expanded && "line-clamp-3",
              )}
            >
              {primaryText}
            </p>
            {expanded && hasSecondaryInput && (
              <div className="rounded-md bg-muted/40 px-3 py-2 text-muted-foreground">
                <div className="mb-1 text-xs font-medium text-muted-foreground/85">
                  原始输入
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{userInput}</p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground">主控未提交需求快照</p>
        )}
      </div>
    </div>
  );
}
