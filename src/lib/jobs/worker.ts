import "server-only";
import type { AppContext } from "../services/context";
import { logEvent } from "../logger";
import { drainJobs } from "./runner";
import { onJobsQueued } from "./signal";

/** Picks up jobs whose process died (expired lease) even when nothing new is enqueued. */
const POLL_MS = 5_000;

const g = globalThis as unknown as {
  __proximalWorker?: { makeCtx: () => AppContext; draining: boolean; again: boolean; timer: ReturnType<typeof setInterval> };
};

/** Start the in-process worker once per server process. Idempotent; later calls just kick it. */
export function startWorker(makeCtx: () => AppContext) {
  if (!g.__proximalWorker) {
    const timer = setInterval(() => kickWorker(), POLL_MS);
    // Never keep a script or test process alive just for the poll.
    timer.unref?.();
    g.__proximalWorker = { makeCtx, draining: false, again: false, timer };
    onJobsQueued(kickWorker);
  }
  kickWorker();
}

/** Run queued jobs now. A kick during a drain schedules one more pass, so no enqueue is missed. */
export function kickWorker() {
  const w = g.__proximalWorker;
  if (!w) return;
  if (w.draining) {
    w.again = true;
    return;
  }
  w.draining = true;
  void (async () => {
    try {
      do {
        w.again = false;
        await drainJobs(w.makeCtx);
      } while (w.again);
    } catch (err) {
      // A database or configuration failure: jobs stay queued and the next poll tries again.
      logEvent("worker_error", { name: (err as Error)?.name ?? "unknown", message: String((err as Error)?.message ?? err).slice(0, 300) }, "error");
    } finally {
      w.draining = false;
    }
  })();
}
