/* oxlint-disable t3code/no-untranslated-copy -- Vela mobile collaboration card keeps inline Chinese copy aligned with desktop */
import type { EnvironmentId, VelaCollabProjection } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import {
  postCollabAction,
  useThreadCollab,
  type CollabEvidenceTarget,
} from "./collabApi";
import { CollabEvidenceSheet } from "./CollabEvidenceSheet";
import {
  COLLAB_ATTENTION_LABEL,
  COLLAB_PHASE_LABEL,
  COLLAB_STEP_LABEL,
  partitionCollabSteps,
  summarizeCollabBanner,
  type CollabStep,
} from "./collabModel";

interface EvidenceModalState {
  readonly title: string;
  readonly target: CollabEvidenceTarget;
}

export interface MobileCollabCardProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly projectRoot: string | null;
  readonly threadWorking: boolean;
  readonly canOperate: boolean;
}

function StepAttentionBox(props: {
  readonly step: CollabStep;
  readonly busy: boolean;
  readonly canOperate: boolean;
  readonly onDecide: (response: string) => void;
  readonly onConfirmChecks: (response: string) => void;
  readonly onRetryReview: () => void;
}) {
  const [customInput, setCustomInput] = useState("");
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
  const reason = props.step.attentionReason;
  const checks = props.step.manualChecks ?? [];

  return (
    <View className="mt-2 gap-2 rounded-lg border border-border-subtle bg-subtle/60 p-2.5">
      {reason ? (
        <Text className="font-t3-bold text-xs text-foreground">
          {COLLAB_ATTENTION_LABEL[reason]}
        </Text>
      ) : null}
      {props.step.attentionDetail ? (
        <Text className="text-xs leading-4 text-foreground-secondary">
          {props.step.attentionDetail}
        </Text>
      ) : null}

      {reason === "decision" && props.canOperate ? (
        <View className="gap-2">
          {(props.step.decisionOptions?.length ?? 0) > 0 ? (
            <View className="flex-row flex-wrap gap-1.5">
              {[...new Set(props.step.decisionOptions)].map((option) => (
                <Pressable
                  key={option}
                  disabled={props.busy}
                  onPress={() => props.onDecide(option)}
                  className="rounded-lg border border-border bg-card px-2.5 py-1.5 active:opacity-75"
                >
                  <Text className="text-xs text-foreground">{option}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View className="flex-row items-center gap-2">
            <TextInput
              value={customInput}
              onChangeText={setCustomInput}
              placeholder="输入自定义决定…"
              placeholderTextColor="#888888"
              editable={!props.busy}
              className="flex-1 rounded-lg border border-input-border bg-input px-2.5 py-1.5 text-xs text-foreground"
            />
            <Button
              label="提交"
              tone="primary"
              disabled={props.busy || !customInput.trim()}
              onPress={() => {
                const value = customInput.trim();
                if (!value) return;
                setCustomInput("");
                props.onDecide(value);
              }}
            />
          </View>
        </View>
      ) : null}

      {reason === "manual_check_required" && props.canOperate ? (
        <View className="gap-2">
          {checks.map((check) => {
            const checked = checkedIds.has(check.id);
            return (
              <Pressable
                key={check.id}
                disabled={props.busy}
                onPress={() =>
                  setCheckedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(check.id)) next.delete(check.id);
                    else next.add(check.id);
                    return next;
                  })
                }
                className="flex-row items-start gap-2"
              >
                <View
                  className={`mt-0.5 h-4 w-4 items-center justify-center rounded border ${
                    checked ? "border-foreground bg-foreground" : "border-border bg-card"
                  }`}
                >
                  {checked ? (
                    <Text className="text-3xs font-t3-bold text-screen">✓</Text>
                  ) : null}
                </View>
                <Text className="flex-1 text-xs leading-4 text-foreground">{check.text}</Text>
              </Pressable>
            );
          })}
          {props.step.reviewId && checks.length > 0 ? (
            <Button
              label="确认人工核验"
              tone="primary"
              disabled={props.busy || !checks.every((check) => checkedIds.has(check.id))}
              onPress={() =>
                props.onConfirmChecks(
                  checks.map((check) => `已核验 ${check.id} · ${check.text}`).join("\n"),
                )
              }
            />
          ) : null}
        </View>
      ) : null}

      {reason === "review_incomplete" && props.step.reviewId && props.canOperate ? (
        <Button
          label="重新入队审查"
          tone="secondary"
          disabled={props.busy}
          onPress={props.onRetryReview}
        />
      ) : null}
    </View>
  );
}

function StepRow(props: {
  readonly step: CollabStep;
  readonly busy: boolean;
  readonly canOperate: boolean;
  readonly onOpenSnapshot: (step: CollabStep) => void;
  readonly onDecide: (step: CollabStep, response: string) => void;
  readonly onConfirmChecks: (step: CollabStep, response: string) => void;
  readonly onRetryReview: (step: CollabStep) => void;
  readonly onCancelStep: (step: CollabStep) => void;
}) {
  const { step } = props;
  const cancellable =
    props.canOperate &&
    step.status !== "integrated" &&
    step.status !== "done" &&
    step.status !== "cancelled";

  return (
    <View className="rounded-xl border border-border-subtle bg-card p-3">
      <View className="flex-row items-start justify-between gap-2">
        <View className="min-w-0 flex-1">
          <Text className="font-t3-medium text-xs text-foreground" numberOfLines={2}>
            {step.title}
          </Text>
          <Text className="mt-0.5 text-2xs text-foreground-muted">
            {COLLAB_STEP_LABEL[step.status]}
            {step.phase !== "initial" ? ` · ${COLLAB_PHASE_LABEL[step.phase]} #${step.attempt}` : ""}
            {step.status === "queued_for_review" && step.queuePosition !== undefined
              ? ` · 队列 #${step.queuePosition}`
              : ""}
          </Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          {step.reviewId ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => props.onOpenSnapshot(step)}
              className="rounded-lg border border-border-subtle bg-subtle px-2 py-1 active:opacity-75"
            >
              <Text className="text-2xs font-t3-medium text-foreground">快照 Diff</Text>
            </Pressable>
          ) : null}
          {cancellable ? (
            <Pressable
              accessibilityRole="button"
              disabled={props.busy}
              onPress={() => props.onCancelStep(step)}
              className="rounded-lg border border-border-subtle px-2 py-1 active:opacity-75"
            >
              <Text className="text-2xs text-foreground-muted">取消</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {step.latestVerdict ? (
        <Text className="mt-1.5 text-2xs leading-4 text-foreground-secondary" numberOfLines={3}>
          {step.latestVerdict.verdict === "approve" ? "审查通过：" : "需修改："}
          {step.latestVerdict.summary}
        </Text>
      ) : null}

      {step.secondOpinion ? (
        <Text className="mt-1 text-2xs leading-4 text-foreground-muted" numberOfLines={2}>
          独立二审（{step.secondOpinion.blockingFindings} 阻塞）：{step.secondOpinion.summary}
        </Text>
      ) : null}

      {step.status === "needs_attention" ? (
        <StepAttentionBox
          step={step}
          busy={props.busy}
          canOperate={props.canOperate}
          onDecide={(response) => props.onDecide(step, response)}
          onConfirmChecks={(response) => props.onConfirmChecks(step, response)}
          onRetryReview={() => props.onRetryReview(step)}
        />
      ) : null}
    </View>
  );
}

export function MobileCollabCard(props: MobileCollabCardProps) {
  const { collab, refresh } = useThreadCollab({
    environmentId: props.environmentId,
    threadId: props.threadId,
    projectRoot: props.projectRoot,
    threadWorking: props.threadWorking,
    enabled: Boolean(props.projectRoot),
  });

  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [evidenceModal, setEvidenceModal] = useState<EvidenceModalState | null>(null);

  if (!collab) return null;

  const summary = summarizeCollabBanner(collab);
  const groups = partitionCollabSteps(collab);

  const runAction = async (
    pathname: `/api/vela/dispatch/v2/${string}`,
    body: Record<string, unknown>,
  ) => {
    setBusy(true);
    setActionError(null);
    await postCollabAction({
      environmentId: props.environmentId,
      pathname,
      body: { threadId: props.threadId, ...body },
    }).then(
      () => {
        refresh();
      },
      (err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err));
      },
    );
    setBusy(false);
  };

  const handleDeliver = (plan: VelaCollabProjection) => {
    if (!plan.delivery) return;
    const { delivery } = plan;
    Dialog.confirm({
      title: "确认应用交付改动？",
      message: "将把已通过整批验证的冻结交付快照一次性写入工作区（不会自动提交或推送）。",
      confirmText: "确认应用",
      cancelText: "取消",
      onConfirm: () => {
        void runAction("/api/vela/dispatch/v2/deliver", {
          planId: plan.planId,
          deliveryId: delivery.deliveryId,
          expectedTargetState: delivery.expectedTargetState,
        });
      },
    });
  };

  const handleRevertDelivery = (plan: VelaCollabProjection) => {
    const deliveryId = plan.appliedDelivery?.deliveryId ?? plan.deliveryId;
    if (!deliveryId) return;
    Dialog.confirm({
      title: "确认撤回已应用交付？",
      message: "将执行三方安全撤回，保留你的手动修改与真实 Git index。",
      confirmText: "确认撤回",
      cancelText: "取消",
      destructive: true,
      onConfirm: () => {
        void runAction("/api/vela/dispatch/v2/revert-delivery", {
          planId: plan.planId,
          deliveryId,
        });
      },
    });
  };

  const handleCancelPlan = (plan: VelaCollabProjection) => {
    Dialog.confirm({
      title: "取消协作计划？",
      message: "将停止尚未完成的步骤；已隔离的工作树不会自动改动你的目标分支。",
      confirmText: "取消计划",
      cancelText: "返回",
      destructive: true,
      onConfirm: () => {
        void runAction("/api/vela/dispatch/v2/plan", {
          action: "cancel",
          planId: plan.planId,
        });
      },
    });
  };

  const renderSection = (title: string, steps: ReadonlyArray<CollabStep>) => {
    if (steps.length === 0) return null;
    return (
      <View className="gap-1.5">
        <Text className="text-2xs font-t3-bold uppercase tracking-wide text-foreground-muted">
          {title}（{steps.length}）
        </Text>
        {steps.map((step) => (
          <StepRow
            key={step.stepId}
            step={step}
            busy={busy}
            canOperate={props.canOperate}
            onOpenSnapshot={(targetStep) => {
              if (!targetStep.reviewId) return;
              setEvidenceModal({
                title: targetStep.title,
                target: { reviewId: targetStep.reviewId },
              });
            }}
            onDecide={(targetStep, response) => {
              void runAction("/api/vela/dispatch/v2/step/resolve", {
                planId: collab.planId,
                stepId: targetStep.stepId,
                resolution: "human_decision",
                response,
              });
            }}
            onConfirmChecks={(targetStep, response) => {
              if (!targetStep.reviewId) return;
              void runAction("/api/vela/dispatch/v2/step/resolve", {
                planId: collab.planId,
                stepId: targetStep.stepId,
                reviewId: targetStep.reviewId,
                resolution: "human_manual_check",
                response,
              });
            }}
            onRetryReview={(targetStep) => {
              if (!targetStep.reviewId) return;
              void runAction("/api/vela/dispatch/v2/step/retry-review", {
                planId: collab.planId,
                stepId: targetStep.stepId,
                reviewId: targetStep.reviewId,
              });
            }}
            onCancelStep={(targetStep) => {
              void runAction("/api/vela/dispatch/v2/step/cancel", {
                planId: collab.planId,
                stepId: targetStep.stepId,
                expectedPlanVersion: collab.planVersion,
              });
            }}
          />
        ))}
      </View>
    );
  };

  return (
    <View className="mx-3 mb-2 overflow-hidden rounded-2xl border border-border bg-grouped-card">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((prev) => !prev)}
        className="flex-row items-center gap-2.5 px-3.5 py-2.5 active:opacity-80"
      >
        <Text className="text-sm text-foreground">✦</Text>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="font-t3-bold text-xs text-foreground">
            {collab.title}
          </Text>
          <Text numberOfLines={1} className="text-2xs text-foreground-muted">
            {summary.compactLine}
          </Text>
        </View>
        {summary.readyToDeliver || summary.attentionCount > 0 ? (
          <View className="rounded-full bg-prominent-action px-2 py-0.5">
            <Text className="text-3xs font-t3-bold text-prominent-action-foreground">
              {summary.readyToDeliver ? "待应用" : `${summary.attentionCount} 待处理`}
            </Text>
          </View>
        ) : null}
        <SymbolView
          name={expanded ? "chevron.down" : "chevron.right"}
          size={13}
          tintColorClassName="accent-icon-muted"
        />
      </Pressable>

      {expanded ? (
        <ScrollView
          nestedScrollEnabled
          style={{ maxHeight: 340 }}
          contentContainerClassName="gap-3 border-t border-border-subtle px-3.5 py-3"
        >
          {actionError ? (
            <View className="rounded-lg border border-danger-border bg-danger px-3 py-2">
              <Text className="text-xs text-danger-foreground">{actionError}</Text>
            </View>
          ) : null}

          {collab.attentionDetail ? (
            <View className="rounded-lg border border-warning-border bg-warning px-3 py-2">
              <Text className="text-xs leading-4 text-warning-foreground">
                {collab.attentionDetail}
              </Text>
            </View>
          ) : null}

          {collab.batchAudit ? (
            <View className="rounded-lg border border-border-subtle bg-card px-3 py-2">
              <Text className="font-t3-medium text-xs text-foreground">
                整批冷审计（{collab.batchAudit.blockingFindings} 阻塞）
              </Text>
              <Text className="mt-0.5 text-2xs leading-4 text-foreground-secondary">
                {collab.batchAudit.summary}
              </Text>
            </View>
          ) : null}

          {renderSection("需人工处理", groups.attention)}
          {renderSection("主控审查队列", groups.reviewQueue)}
          {renderSection("并行开发中", groups.developing)}
          {renderSection("已集成 / 已完成", groups.completed)}

          <View className="flex-row flex-wrap gap-2 border-t border-border-subtle pt-2.5">
            {collab.status === "draft" && props.canOperate ? (
              <Button
                label="启动协作"
                tone="primary"
                disabled={busy}
                onPress={() =>
                  void runAction("/api/vela/dispatch/v2/plan", {
                    action: "start",
                    planId: collab.planId,
                    expectedPlanVersion: collab.planVersion,
                  })
                }
              />
            ) : null}

            {collab.canRetryBatch && props.canOperate ? (
              <Button
                label="重试整批验证"
                tone="secondary"
                disabled={busy}
                onPress={() =>
                  void runAction("/api/vela/dispatch/v2/batch/retry", {
                    planId: collab.planId,
                    expectedPlanVersion: collab.planVersion,
                    ...(collab.integrationOid ? { integrationOid: collab.integrationOid } : {}),
                  })
                }
              />
            ) : null}

            {collab.deliveryId ? (
              <Button
                label="查看整批 Diff"
                tone="secondary"
                disabled={busy}
                onPress={() =>
                  setEvidenceModal({
                    title: `${collab.title} · 整批交付`,
                    target: { deliveryId: collab.deliveryId! },
                  })
                }
              />
            ) : null}

            {summary.readyToDeliver && props.canOperate ? (
              <Button
                label="确认应用交付"
                tone="primary"
                disabled={busy}
                onPress={() => handleDeliver(collab)}
              />
            ) : null}

            {collab.status === "delivered" &&
            !collab.appliedDelivery?.revertedAt &&
            props.canOperate ? (
              <Button
                label="安全撤回交付"
                tone="danger"
                disabled={busy}
                onPress={() => handleRevertDelivery(collab)}
              />
            ) : null}

            {(collab.status === "draft" || collab.status === "running") && props.canOperate ? (
              <Button
                label="取消计划"
                tone="text"
                disabled={busy}
                onPress={() => handleCancelPlan(collab)}
              />
            ) : null}
          </View>
        </ScrollView>
      ) : null}

      <CollabEvidenceSheet
        visible={evidenceModal !== null}
        environmentId={props.environmentId}
        threadId={props.threadId}
        planId={collab.planId}
        title={evidenceModal?.title ?? collab.title}
        target={evidenceModal?.target ?? null}
        onClose={() => setEvidenceModal(null)}
      />
    </View>
  );
}
