import type { MarkdownBlock } from "../../shared/markdown.ts";
import { createOffThreadQueue, type OffThreadJob, type WorkerLike } from "./offThread.ts";

/**
 * How long a worker may take to parse a file for its Preview. Ordinary Markdown of a quarter
 * megabyte parses in a few milliseconds; past this the file opens as its source and says why.
 */
export const PREVIEW_BUDGET_MS = 2_000;

/** A file as read for its Preview: `whole` is false when only its start was read (reference links are then not read: a definition may lie past the cut). */
export interface PreviewText { text: string; whole: boolean }

const queue = createOffThreadQueue<PreviewText, MarkdownBlock[]>(
  () => new Worker(new URL("./markdownPreview.worker.ts", import.meta.url), { type: "module" }) as WorkerLike,
  PREVIEW_BUDGET_MS,
);

let last: (PreviewText & { blocks: MarkdownBlock[] | null }) | null = null;

export function knownPreview(text: string, whole: boolean): MarkdownBlock[] | null | undefined {
  return last !== null && last.text === text && last.whole === whole ? last.blocks : undefined;
}

export function parsePreviewOffThread(text: string, whole: boolean): OffThreadJob<MarkdownBlock[]> {
  const job = queue({ text, whole });
  let dropped = false;
  return {
    cancel: () => {
      if (job.cancel()) dropped = true;
      return dropped;
    },
    promise: job.promise.then((blocks) => {
      if (!dropped) last = { text, whole, blocks };
      return blocks;
    }),
  };
}
