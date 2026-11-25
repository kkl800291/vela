/* oxlint-disable t3code/no-untranslated-copy -- Vela dispatch UI keeps inline Chinese copy without modifying i18n catalogs */
import {
  isReasoningSelect,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  MessageSquareIcon,
  SearchIcon,
} from "lucide-react";
import { useState } from "react";

import { EffortGlyph, FastBolt, resolveEffortGlyph } from "~/components/chat/EffortGlyph";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import type { DispatchAgentTarget, DispatchProviderSummary } from "~/state/velaDispatch";
import {
  applyFallbackEffortChange,
  applyTargetOptionChange,
  buildTargetForModelSelection,
  FALLBACK_EFFORT_CHOICES,
  providerLabelOf,
  resolveAgentTargetDisplay,
  resolveTargetOptionValue,
} from "./dispatchModel";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

const OPTION_ROW_CLASS =
  "flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-xs text-foreground outline-none transition-colors hover:bg-foreground/[0.08] focus-visible:bg-foreground/[0.08] disabled:cursor-not-allowed disabled:opacity-55";

function safeDriverKind(provider: string | undefined): ProviderDriverKind | null {
  const trimmed = provider?.trim();
  return trimmed ? ProviderDriverKind.make(trimmed) : null;
}

export function AgentTargetPicker({
  value,
  providers,
  allowSelf = false,
  allowNull = false,
  allowInherit = false,
  nullLabel = "关闭",
  disabled = false,
  align = "end",
  side = "bottom",
  variant = "default",
  onSelect,
}: {
  readonly value: "self" | DispatchAgentTarget | null | "inherit";
  readonly providers: ReadonlyArray<DispatchProviderSummary>;
  readonly allowSelf?: boolean | undefined;
  readonly allowNull?: boolean | undefined;
  readonly allowInherit?: boolean | undefined;
  readonly nullLabel?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly align?: "start" | "center" | "end" | undefined;
  readonly side?: "top" | "bottom" | undefined;
  readonly variant?: "default" | "chip" | undefined;
  readonly onSelect: (next: "self" | DispatchAgentTarget | null | "inherit") => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingTarget, setPendingTarget] = useState<DispatchAgentTarget | null>(null);

  const propTarget =
    value !== null && value !== "self" && value !== "inherit" ? value : null;
  const activeTarget = open && pendingTarget !== null ? pendingTarget : propTarget;
  const display = activeTarget ? resolveAgentTargetDisplay(activeTarget, providers) : null;

  const totalModelCount = providers.reduce((sum, p) => sum + Math.max(1, p.models.length), 0);
  const showSearch = totalModelCount >= 8;
  const trimmedQuery = query.trim().toLowerCase();

  const filteredProviders = providers
    .map((provider) => {
      const pLabel = providerLabelOf(provider);
      if (!trimmedQuery) return { provider, pLabel, models: provider.models };
      const providerMatches =
        pLabel.toLowerCase().includes(trimmedQuery) ||
        provider.provider.toLowerCase().includes(trimmedQuery) ||
        provider.instanceId.toLowerCase().includes(trimmedQuery);
      if (providerMatches) return { provider, pLabel, models: provider.models };
      const matchingModels = provider.models.filter(
        (m) =>
          m.name.toLowerCase().includes(trimmedQuery) ||
          m.slug.toLowerCase().includes(trimmedQuery),
      );
      return { provider, pLabel, models: matchingModels };
    })
    .filter(({ provider, models }) =>
      provider.models.length === 0 ? !trimmedQuery : models.length > 0,
    );

  const descriptors = display?.descriptors ?? [];
  const reasoningDescriptor = display?.reasoningDescriptor ?? null;
  const otherSelectDescriptors: ReadonlyArray<SelectDescriptor> = descriptors.filter(
    (d): d is SelectDescriptor => d.type === "select" && !isReasoningSelect(d),
  );
  const booleanDescriptors: ReadonlyArray<BooleanDescriptor> = descriptors.filter(
    (d): d is BooleanDescriptor => d.type === "boolean",
  );
  const showFallbackEffort =
    activeTarget !== null && !reasoningDescriptor && Boolean(display?.reasoningValue);
  const showOptionsColumn =
    activeTarget !== null && (descriptors.length > 0 || showFallbackEffort);

  const reasoningGlyph =
    reasoningDescriptor && display?.reasoningValue
      ? resolveEffortGlyph(reasoningDescriptor, display.reasoningValue)
      : null;

  const triggerTitle =
    value === "self"
      ? "当前主控对话直接执行 (self)"
      : value === "inherit"
        ? "跟随当前对话模型"
        : value === null
          ? nullLabel
          : display?.fullLabel;

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setPendingTarget(null);
    }
  };

  const handleSelectSpecial = (next: "self" | null | "inherit") => {
    setPendingTarget(null);
    onSelect(next);
    setOpen(false);
    setQuery("");
  };

  const handleSelectModel = (
    provider: DispatchProviderSummary,
    modelSlug: string | undefined,
  ) => {
    const nextTarget = buildTargetForModelSelection(activeTarget, provider, modelSlug);
    const resolvedModel = modelSlug
      ? provider.models.find((m) => m.slug === modelSlug)
      : provider.models[0];
    const hasDescriptors = (resolvedModel?.optionDescriptors?.length ?? 0) > 0;
    if (hasDescriptors) {
      setPendingTarget(nextTarget);
    } else {
      setPendingTarget(null);
      setOpen(false);
      setQuery("");
    }
    onSelect(nextTarget);
  };

  const handleSelectOptionTarget = (nextTarget: DispatchAgentTarget) => {
    setPendingTarget(nextTarget);
    onSelect(nextTarget);
  };

  const hasSpecialOptions = allowInherit || allowSelf || allowNull;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            disabled={disabled}
            aria-label={triggerTitle}
            className={cn(
              "inline-flex max-w-60 items-center gap-1.5 text-xs text-foreground transition-colors disabled:pointer-events-none disabled:opacity-55",
              variant === "chip"
                ? "rounded-md border border-border/65 bg-background/80 px-2 py-0.5 hover:border-border hover:bg-accent/55"
                : "rounded px-1.5 py-0.5 hover:bg-accent/60",
            )}
          >
            {value === "self" ? (
              <>
                <MessageSquareIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">主控直接执行</span>
              </>
            ) : value === "inherit" ? (
              <>
                <BotIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">跟随当前对话</span>
              </>
            ) : value === null ? (
              <span className="truncate text-muted-foreground">{nullLabel}</span>
            ) : (
              <>
                {display?.driverKind && (
                  <ProviderInstanceIcon
                    driverKind={display.driverKind}
                    displayName={display.providerLabel}
                    size="compact"
                    iconClassName="size-3.5"
                  />
                )}
                <span className="truncate font-medium">
                  {display?.modelName || display?.providerLabel}
                </span>
                {display?.effortLabel && (
                  <span className="shrink-0 text-muted-foreground">{display.effortLabel}</span>
                )}
                {display?.isFast && (
                  <span className="inline-flex shrink-0 items-center text-muted-foreground">
                    <FastBolt ultra={display.isUltrafast} />
                  </span>
                )}
              </>
            )}
            <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
          </button>
        }
      />

      <PopoverPopup
        padding="none"
        align={align}
        side={side}
        className="overflow-hidden"
      >
        <div className="flex max-h-80">
          {/* Left column: Harness + Model selector */}
          <div className="flex min-h-0 w-60 flex-col sm:w-64">
            {showSearch && (
              <div className="flex shrink-0 items-center gap-1.5 border-b border-border/55 px-2.5 py-1.5">
                <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索 Harness 或模型..."
                  className="h-5 w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/70 outline-none"
                />
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {hasSpecialOptions && !trimmedQuery && (
                <div className="mb-1.5 space-y-0.5 border-b border-border/50 pb-1.5">
                  {allowInherit && (
                    <button
                      type="button"
                      onClick={() => handleSelectSpecial("inherit")}
                      className={cn(
                        OPTION_ROW_CLASS,
                        value === "inherit" && "bg-foreground/[0.08] font-medium",
                      )}
                    >
                      <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">跟随当前对话模型</span>
                      {value === "inherit" && <CheckIcon className="size-3.5 shrink-0" />}
                    </button>
                  )}
                  {allowSelf && (
                    <button
                      type="button"
                      onClick={() => handleSelectSpecial("self")}
                      className={cn(
                        OPTION_ROW_CLASS,
                        value === "self" && "bg-foreground/[0.08] font-medium",
                      )}
                    >
                      <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">当前主控直接执行 (self)</span>
                      {value === "self" && <CheckIcon className="size-3.5 shrink-0" />}
                    </button>
                  )}
                  {allowNull && (
                    <button
                      type="button"
                      onClick={() => handleSelectSpecial(null)}
                      className={cn(
                        OPTION_ROW_CLASS,
                        value === null && "bg-foreground/[0.08] font-medium",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {nullLabel}
                      </span>
                      {value === null && <CheckIcon className="size-3.5 shrink-0" />}
                    </button>
                  )}
                </div>
              )}

              {filteredProviders.length === 0 ? (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                  未找到匹配的模型
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredProviders.map(({ provider, pLabel, models }) => {
                    const driverKind = safeDriverKind(provider.provider);
                    const isCurrentProvider = activeTarget?.providerInstanceId === provider.instanceId;

                    if (models.length === 0) {
                      return (
                        <button
                          key={provider.instanceId}
                          type="button"
                          onClick={() => handleSelectModel(provider, undefined)}
                          className={cn(
                            OPTION_ROW_CLASS,
                            isCurrentProvider && "bg-foreground/[0.08] font-medium",
                          )}
                        >
                          {driverKind && (
                            <ProviderInstanceIcon
                              driverKind={driverKind}
                              displayName={pLabel}
                              size="compact"
                              iconClassName="size-3.5"
                            />
                          )}
                          <span className="min-w-0 flex-1 truncate">{pLabel}</span>
                          {isCurrentProvider && <CheckIcon className="size-3.5 shrink-0" />}
                        </button>
                      );
                    }

                    return (
                      <div key={provider.instanceId} className="space-y-0.5">
                        <div className="flex items-center gap-1.5 px-2 pt-0.5 pb-1 text-2xs font-medium text-muted-foreground">
                          {driverKind && (
                            <ProviderInstanceIcon
                              driverKind={driverKind}
                              displayName={pLabel}
                              size="compact"
                              iconClassName="size-3"
                            />
                          )}
                          <span className="truncate">{pLabel}</span>
                        </div>
                        {models.map((model) => {
                          const isSelected =
                            isCurrentProvider &&
                            (activeTarget?.model === model.slug ||
                              (!activeTarget?.model && provider.models[0]?.slug === model.slug));
                          return (
                            <button
                              key={`${provider.instanceId}:${model.slug}`}
                              type="button"
                              onClick={() => handleSelectModel(provider, model.slug)}
                              className={cn(
                                OPTION_ROW_CLASS,
                                isSelected && "bg-foreground/[0.08] font-medium",
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate">
                                {model.name || model.slug}
                              </span>
                              {isSelected && <CheckIcon className="size-3.5 shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right column: Docked Reasoning Effort & Model Options (mirrors Vela ComposerModelEffort) */}
          {showOptionsColumn && activeTarget && display && (
            <div className="flex min-h-0 w-44 shrink-0 flex-col border-l border-border/55 bg-muted/15 sm:w-48">
              <div className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-2.5 py-2">
                {display.driverKind && (
                  <ProviderInstanceIcon
                    driverKind={display.driverKind}
                    displayName={display.providerLabel}
                    size="compact"
                    iconClassName="size-3"
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-2xs font-medium text-muted-foreground">
                  {display.modelName || display.providerLabel}
                </span>
                {reasoningGlyph && (
                  <span className="shrink-0 text-muted-foreground">
                    <EffortGlyph
                      count={reasoningGlyph.count}
                      filled={reasoningGlyph.filled}
                      size="xs"
                    />
                  </span>
                )}
              </div>

              <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-1.5">
                {reasoningDescriptor && (
                  <div className="space-y-0.5" role="radiogroup" aria-label={reasoningDescriptor.label}>
                    <div className="px-2 pt-0.5 pb-1 text-2xs font-medium text-muted-foreground">
                      思考等级
                    </div>
                    {selectableProviderOptionChoices(reasoningDescriptor).map((choice) => {
                      const isChecked = display.reasoningValue === choice.id;
                      return (
                        <Tooltip key={choice.id}>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                role="radio"
                                aria-checked={isChecked}
                                onClick={() =>
                                  handleSelectOptionTarget(
                                    applyTargetOptionChange(
                                      activeTarget,
                                      reasoningDescriptor,
                                      choice.id,
                                      descriptors,
                                    ),
                                  )
                                }
                                className={cn(
                                  OPTION_ROW_CLASS,
                                  isChecked && "bg-foreground/[0.08] font-medium",
                                )}
                              >
                                <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                                {choice.isDefault && !isChecked && (
                                  <span className="shrink-0 text-3xs text-muted-foreground/80">
                                    默认
                                  </span>
                                )}
                                {isChecked && <CheckIcon className="size-3.5 shrink-0" />}
                              </button>
                            }
                          />
                          {choice.description && (
                            <TooltipPopup side="right">{choice.description}</TooltipPopup>
                          )}
                        </Tooltip>
                      );
                    })}
                  </div>
                )}

                {showFallbackEffort && (
                  <div className="space-y-0.5" role="radiogroup" aria-label="思考等级">
                    <div className="px-2 pt-0.5 pb-1 text-2xs font-medium text-muted-foreground">
                      思考等级
                    </div>
                    {FALLBACK_EFFORT_CHOICES.map((choice) => {
                      const isChecked =
                        display.reasoningValue?.toLowerCase() === choice.id;
                      return (
                        <button
                          key={choice.id}
                          type="button"
                          role="radio"
                          aria-checked={isChecked}
                          onClick={() =>
                            handleSelectOptionTarget(
                              applyFallbackEffortChange(activeTarget, choice.id),
                            )
                          }
                          className={cn(
                            OPTION_ROW_CLASS,
                            isChecked && "bg-foreground/[0.08] font-medium",
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                          {isChecked && <CheckIcon className="size-3.5 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {otherSelectDescriptors.map((descriptor) => {
                  const currentVal = resolveTargetOptionValue(activeTarget, descriptor);
                  const choices = selectableProviderOptionChoices(descriptor);
                  if (choices.length === 0) return null;
                  return (
                    <div
                      key={descriptor.id}
                      className="space-y-0.5 border-t border-border/40 pt-2"
                      role="radiogroup"
                      aria-label={descriptor.label}
                    >
                      <div className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
                        {descriptor.label}
                      </div>
                      {choices.map((choice) => {
                        const isChecked = currentVal === choice.id;
                        return (
                          <button
                            key={choice.id}
                            type="button"
                            role="radio"
                            aria-checked={isChecked}
                            onClick={() =>
                              handleSelectOptionTarget(
                                applyTargetOptionChange(
                                  activeTarget,
                                  descriptor,
                                  choice.id,
                                  descriptors,
                                ),
                              )
                            }
                            className={cn(
                              OPTION_ROW_CLASS,
                              isChecked && "bg-foreground/[0.08] font-medium",
                            )}
                          >
                            <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                            {isChecked && <CheckIcon className="size-3.5 shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}

                {booleanDescriptors.length > 0 && (
                  <div className="space-y-1 border-t border-border/40 pt-2">
                    {booleanDescriptors.map((descriptor) => {
                      const checked = resolveTargetOptionValue(activeTarget, descriptor) === true;
                      return (
                        <div
                          key={descriptor.id}
                          className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-foreground"
                        >
                          <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                            {descriptor.id === "fastMode" && (
                              <span className="text-muted-foreground">
                                <FastBolt ultra={false} />
                              </span>
                            )}
                            <span className="truncate">{descriptor.label}</span>
                          </span>
                          <Switch
                            size="sm"
                            checked={checked}
                            onCheckedChange={(nextChecked) =>
                              handleSelectOptionTarget(
                                applyTargetOptionChange(
                                  activeTarget,
                                  descriptor,
                                  nextChecked,
                                  descriptors,
                                ),
                              )
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
