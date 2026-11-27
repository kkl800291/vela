import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";
import type { DispatchAgentTarget } from "./velaDispatch";

export type CollabComposerBinding =
  | { readonly kind: "new_plan" }
  | { readonly kind: "adjust_plan"; readonly planId: string }
  | {
      readonly kind: "reply_step";
      readonly planId: string;
      readonly stepId: string;
      readonly stepNumber: number;
      readonly stepTitle: string;
    };

export interface CollabDeliveryConflict {
  readonly planId: string;
  readonly deliveryId: string;
  readonly expectedTargetState: string;
  readonly conflictFiles: ReadonlyArray<string>;
}

interface CollabUiStoreState {
  composerBindingByThread: Record<string, CollabComposerBinding | undefined>;
  deliveryConflictByPlan: Record<string, CollabDeliveryConflict | undefined>;
  collapsedAppliedPlanIds: Record<string, boolean | undefined>;
  justAppliedPlanId: string | null;
  setComposerBinding: (ref: ScopedThreadRef, binding: CollabComposerBinding | null) => void;
  setDeliveryConflict: (planId: string, conflict: CollabDeliveryConflict | null) => void;
  markAppliedCollapsed: (planId: string, collapsed: boolean) => void;
  triggerAppliedPulse: (planId: string) => void;
}

export const useCollabUiStore = create<CollabUiStoreState>()((set) => ({
  composerBindingByThread: {},
  deliveryConflictByPlan: {},
  collapsedAppliedPlanIds: {},
  justAppliedPlanId: null,
  setComposerBinding: (ref, binding) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      if (binding === null) {
        const { [key]: _removed, ...rest } = state.composerBindingByThread;
        return { composerBindingByThread: rest };
      }
      return {
        composerBindingByThread: {
          ...state.composerBindingByThread,
          [key]: binding,
        },
      };
    }),
  setDeliveryConflict: (planId, conflict) =>
    set((state) => {
      if (conflict === null) {
        const { [planId]: _removed, ...rest } = state.deliveryConflictByPlan;
        return { deliveryConflictByPlan: rest };
      }
      return {
        deliveryConflictByPlan: {
          ...state.deliveryConflictByPlan,
          [planId]: conflict,
        },
      };
    }),
  markAppliedCollapsed: (planId, collapsed) =>
    set((state) => ({
      collapsedAppliedPlanIds: {
        ...state.collapsedAppliedPlanIds,
        [planId]: collapsed,
      },
    })),
  triggerAppliedPulse: (planId) => {
    set({ justAppliedPlanId: planId });
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        set((state) => (state.justAppliedPlanId === planId ? { justAppliedPlanId: null } : state));
      }, 1400);
    }
  },
}));

interface CollabProjectPrefsState {
  devAgentByProjectRoot: Record<string, DispatchAgentTarget | null | undefined>;
  setProjectDevAgent: (projectRoot: string, agent: DispatchAgentTarget | null) => void;
}

export const useCollabProjectPrefsStore = create<CollabProjectPrefsState>()(
  persist(
    (set) => ({
      devAgentByProjectRoot: {},
      setProjectDevAgent: (projectRoot, agent) =>
        set((state) => ({
          devAgentByProjectRoot: {
            ...state.devAgentByProjectRoot,
            [projectRoot]: agent,
          },
        })),
    }),
    {
      name: "vela:collab-project-prefs:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);
