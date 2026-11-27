import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadFeedPresentation,
  type ThreadFeedEntry,
  type ThreadFeedMessage,
} from "../../lib/threadActivity";

const THREAD_ID = ThreadId.make("thread-collab-1");

function makeMessageEntry(
  overrides: Omit<Partial<ThreadFeedMessage>, "id" | "role" | "text" | "createdAt"> & {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly createdAt: string;
  },
): ThreadFeedEntry {
  const { id, role, text, createdAt, ...rest } = overrides;
  return {
    type: "message",
    id,
    createdAt,
    message: {
      id: MessageId.make(id),
      role,
      text,
      attachments: [],
      runId: null,
      streaming: false,
      visibility: "local",
      sourceThreadId: THREAD_ID,
      createdAt,
      updatedAt: createdAt,
      ...rest,
    },
  };
}

describe("mobile collaboration review folding", () => {
  it("folds consecutive routine review wakes while preserving escalations and delivery summaries", () => {
    const run1 = RunId.make("run-review-1");
    const run2 = RunId.make("run-review-2");
    const runDeliver = RunId.make("run-deliver");
    const feed: ThreadFeedEntry[] = [
      makeMessageEntry({
        id: "user-1",
        role: "user",
        text: "请拆卡并行开发",
        runId: RunId.make("run-0"),
        createdAt: "2026-11-26T10:00:00.000Z",
      }),
      makeMessageEntry({
        id: "vela-collab:review:1",
        role: "user",
        text: "[Vela collaboration review]\nStep s1 ready",
        runId: run1,
        createdBy: "system",
        creationSource: "server",
        createdAt: "2026-11-26T10:01:00.000Z",
      }),
      makeMessageEntry({
        id: "assistant-review-1",
        role: "assistant",
        text: "审查通过 s1",
        runId: run1,
        createdAt: "2026-11-26T10:01:10.000Z",
      }),
      makeMessageEntry({
        id: "vela-collab:review:2",
        role: "user",
        text: "[Vela collaboration review]\nStep s2 ready",
        runId: run2,
        createdBy: "system",
        creationSource: "server",
        createdAt: "2026-11-26T10:02:00.000Z",
      }),
      makeMessageEntry({
        id: "assistant-review-2",
        role: "assistant",
        text: "审查通过 s2",
        runId: run2,
        createdAt: "2026-11-26T10:02:10.000Z",
      }),
      makeMessageEntry({
        id: "vela-collab:delivery:1",
        role: "user",
        text: "[Vela collaboration delivery ready]\nAll steps verified",
        runId: runDeliver,
        createdBy: "system",
        creationSource: "server",
        createdAt: "2026-11-26T10:03:00.000Z",
      }),
      makeMessageEntry({
        id: "assistant-delivery-1",
        role: "assistant",
        text: "整批验证通过，请确认应用交付。",
        runId: runDeliver,
        createdAt: "2026-11-26T10:03:05.000Z",
      }),
    ];

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    const foldRow = collapsed.find((row) => row.type === "run-fold");
    expect(foldRow).toBeDefined();
    expect(foldRow?.type === "run-fold" ? foldRow.label : null).toBe("已折叠 2 轮常规审查");
    expect(collapsed.some((row) => row.id === "vela-collab:review:1")).toBe(false);
    expect(collapsed.some((row) => row.id === "assistant-review-2")).toBe(false);
    expect(collapsed.some((row) => row.id === "vela-collab:delivery:1")).toBe(true);
    expect(collapsed.some((row) => row.id === "assistant-delivery-1")).toBe(true);

    const expanded = deriveThreadFeedPresentation(
      feed,
      null,
      new Set([foldRow!.type === "run-fold" ? foldRow!.runId : RunId.make("x")]),
    );
    expect(expanded.some((row) => row.id === "vela-collab:review:1")).toBe(true);
    expect(expanded.some((row) => row.id === "assistant-review-2")).toBe(true);
  });
});
