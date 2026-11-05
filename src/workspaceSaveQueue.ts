interface SaveWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface PendingSave {
  payload: string;
  waiters: SaveWaiter[];
}

/** Keeps one writer active and coalesces waiting snapshots to the newest draft. */
export class WorkspaceSaveQueue {
  private active: PendingSave | undefined;
  private pending: PendingSave | undefined;
  private flushWaiters: SaveWaiter[] = [];

  constructor(private readonly save: (payload: string) => Promise<void>) {}

  get hasPending(): boolean {
    return this.active !== undefined || this.pending !== undefined;
  }

  /** Resolves once this snapshot, or a newer snapshot that supersedes it, is saved. */
  enqueue(payload: string): Promise<void> {
    const completion = new Promise<void>((resolve, reject) => {
      if (this.pending) {
        this.pending.payload = payload;
        this.pending.waiters.push({ resolve, reject });
      } else {
        this.pending = { payload, waiters: [{ resolve, reject }] };
      }
    });
    this.startNext();
    return completion;
  }

  /** Waits until every active or pending save has settled successfully. */
  flush(): Promise<void> {
    if (!this.hasPending) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.flushWaiters.push({ resolve, reject });
    });
  }

  private startNext(): void {
    if (this.active || !this.pending) return;
    const entry = this.pending;
    this.pending = undefined;
    this.active = entry;
    let operation: Promise<void>;
    try {
      operation = this.save(entry.payload);
    } catch (error) {
      this.finish(entry, { error });
      return;
    }
    void operation.then(
      () => this.finish(entry),
      (error: unknown) => this.finish(entry, { error }),
    );
  }

  private finish(entry: PendingSave, failure?: { error: unknown }): void {
    this.active = undefined;
    for (const waiter of entry.waiters) {
      if (failure) waiter.reject(failure.error);
      else waiter.resolve();
    }
    if (failure) {
      const waiters = this.flushWaiters;
      this.flushWaiters = [];
      for (const waiter of waiters) waiter.reject(failure.error);
    }
    if (this.pending) {
      this.startNext();
    } else if (!failure) {
      const waiters = this.flushWaiters;
      this.flushWaiters = [];
      for (const waiter of waiters) waiter.resolve();
    }
  }
}
