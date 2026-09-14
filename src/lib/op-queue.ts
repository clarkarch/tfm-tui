// --- Serial async op queue: destructive file ops (trash/restore/delete,
// copy/move) must not interleave on the same paths. Every op enqueues behind
// the previous one; failures reject only their own caller and never break
// the chain. Pure — no fs/renderer imports. ---

export const makeOpQueue = () => {
  let tail: Promise<void> = Promise.resolve();
  // in-flight + queued-behind count: restart refuses while nonzero (the
  // parent loop freezes inside spawnSync, so a live op would race the
  // child's orphan sweep — see app/restart)
  let active = 0;
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    active++;
    const run = tail.then(fn, fn);
    // keep the chain alive even when this op rejects — the rejection still
    // propagates to this caller via `run`
    tail = run.then(
      () => {
        active--;
      },
      () => {
        active--;
      },
    );
    return run;
  };
  const isIdle = (): boolean => active === 0;
  return { enqueue, isIdle };
};

type OpQueue = ReturnType<typeof makeOpQueue>;

// module-level shared queue for all file mutations so trash + transfer +
// restore (different factories) still serialize against each other
let shared: OpQueue | null = null;
export const sharedOpQueue = (): OpQueue => {
  if (!shared) shared = makeOpQueue();
  return shared;
};
