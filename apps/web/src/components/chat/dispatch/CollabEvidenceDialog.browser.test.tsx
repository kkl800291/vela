import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../../test/render";
import type { CollabEvidenceFile, CollabEvidenceResults } from "~/state/velaDispatch";
import { CollabEvidenceDialog } from "./CollabEvidenceDialog";

const fetchEvidence = vi.hoisted(() => vi.fn());
vi.mock(import("~/state/velaDispatch"), async (original) => ({
  ...(await original()),
  fetchCollabEvidence: fetchEvidence,
}));

const file: CollabEvidenceFile = {
  path: " example.txt ",
  status: "M",
  isBinary: false,
  sizeBytes: 20,
  oldOid: "old-object",
  newOid: "new-object",
  oldMode: "100644",
  newMode: "100644",
  additions: 1,
  deletions: 1,
};

const scope = {
  environmentId: EnvironmentId.make("environment-local"),
  threadId: "thread",
  planId: "plan",
  target: { reviewId: "review" },
  title: "Review snapshot",
  onClose: () => {},
};

it("loads the manifest first, then paginates only the selected file and rejoins split UTF-8", async () => {
  fetchEvidence.mockReset();
  const prefix = new TextEncoder().encode("@@ -4 +4 @@\n-old\n+雪\n");
  const split = prefix.length - 3;
  const page = (offset: number, bytes: Uint8Array, nextOffset: number | null) =>
    ({
      kind: "patch",
      file,
      offset,
      byteLength: bytes.length,
      nextOffset,
      encoding: "base64",
      dataBase64: btoa(String.fromCharCode(...bytes)),
    }) satisfies CollabEvidenceResults["diff"];

  fetchEvidence
    .mockResolvedValueOnce({ kind: "manifest", files: [file], offset: 0, nextOffset: null })
    .mockResolvedValueOnce(page(0, prefix.slice(0, split), split))
    .mockResolvedValueOnce(page(split, prefix.slice(split), null));

  await using screen = await render(<CollabEvidenceDialog {...scope} />);
  const fileButton = screen.getByRole("button", { name: /example\.txt/ });
  await expect.element(fileButton).toBeVisible();
  expect(fetchEvidence).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      view: "manifest",
      planId: "plan",
      target: { reviewId: "review" },
      offset: 0,
    }),
  );
  await fileButton.click();
  await expect.element(screen.getByText("-old", { exact: true })).toBeVisible();
  expect(fetchEvidence).toHaveBeenLastCalledWith(
    expect.objectContaining({ view: "diff", path: file.path, offset: 0 }),
  );
  await screen.getByRole("button", { name: "加载更多" }).click();
  await expect.element(screen.getByText("+雪", { exact: true })).toBeVisible();
  expect(fetchEvidence).toHaveBeenLastCalledWith(
    expect.objectContaining({ view: "diff", path: file.path, offset: split }),
  );
  await expect.element(screen.getByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
});

it("uses manifest metadata for binary files", async () => {
  fetchEvidence.mockReset();
  fetchEvidence.mockResolvedValueOnce({
    kind: "manifest",
    files: [{ ...file, path: "image.png", isBinary: true, additions: null, deletions: null }],
    offset: 0,
    nextOffset: null,
  });
  await using screen = await render(
    <CollabEvidenceDialog {...scope} target={{ deliveryId: "delivery" }} />,
  );
  await screen.getByRole("button", { name: /image\.png/ }).click();
  await expect.element(screen.getByText("old-object")).toBeVisible();
  await expect.element(screen.getByText("new-object")).toBeVisible();
  expect(fetchEvidence).toHaveBeenCalledTimes(1);
});
