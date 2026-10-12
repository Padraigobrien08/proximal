// "Jobs were queued" signal. Services raise it after enqueueing; the worker (if running in this process) listens.
// Kept free of imports so services and the worker can both use it without an import cycle.

const g = globalThis as unknown as { __proximalJobsQueued?: () => void };

export function onJobsQueued(listener: () => void) {
  g.__proximalJobsQueued = listener;
}

/** Wake the worker. A no-op in scripts and tests, which drain jobs themselves. */
export function notifyJobsQueued() {
  g.__proximalJobsQueued?.();
}
