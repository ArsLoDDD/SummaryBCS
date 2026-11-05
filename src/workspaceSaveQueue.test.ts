import { describe, expect, it, vi } from "vitest";
import { WorkspaceSaveQueue } from "./workspaceSaveQueue";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("WorkspaceSaveQueue", () => {
  it("serializes writes and saves the newest pending draft without stale overwrites", async () => {
    const first = deferred();
    const last = deferred();
    const save = vi.fn<(payload: string) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => last.promise);
    const queue = new WorkspaceSaveQueue(save);
    expect(queue.hasPending).toBe(false);

    const a = queue.enqueue("draft A");
    const b = queue.enqueue("draft B");
    const c = queue.enqueue("draft C");
    const completed = vi.fn();
    void b.then(completed);
    void c.then(completed);
    expect(save.mock.calls).toEqual([["draft A"]]);
    expect(queue.hasPending).toBe(true);

    first.resolve();
    await a;
    expect(save.mock.calls).toEqual([["draft A"], ["draft C"]]);
    expect(completed).not.toHaveBeenCalled();
    expect(queue.hasPending).toBe(true);

    last.resolve();
    await Promise.all([b, c]);
    expect(completed).toHaveBeenCalledTimes(2);
    expect(queue.hasPending).toBe(false);
  });

  it("flush waits for the last pending write and supports several callers", async () => {
    const first = deferred();
    const second = deferred();
    const queue = new WorkspaceSaveQueue(vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise));
    await queue.flush();
    const a = queue.enqueue("first");
    const b = queue.enqueue("second");
    const flushed = vi.fn();
    const flushA = queue.flush().then(flushed);
    const flushB = queue.flush().then(flushed);
    first.resolve();
    await a;
    expect(flushed).not.toHaveBeenCalled();
    second.resolve();
    await Promise.all([b, flushA, flushB]);
    expect(flushed).toHaveBeenCalledTimes(2);
    expect(queue.hasPending).toBe(false);
  });

  it("rejects failed writes and their flushes while allowing a pending replacement to succeed", async () => {
    const first = deferred();
    const second = deferred();
    const save = vi.fn<(payload: string) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const queue = new WorkspaceSaveQueue(save);
    const error = new Error("disk full");
    const failedSave = expect(queue.enqueue("old")).rejects.toBe(error);
    const next = queue.enqueue("latest");
    const failedFlush = expect(queue.flush()).rejects.toBe(error);
    first.reject(error);
    await Promise.all([failedSave, failedFlush]);
    expect(save.mock.calls).toEqual([["old"], ["latest"]]);
    expect(queue.hasPending).toBe(true);
    const retryFlush = queue.flush();
    second.resolve();
    await Promise.all([next, retryFlush]);
    expect(queue.hasPending).toBe(false);
  });

  it("recovers after a failed idle save, including a synchronously thrown error", async () => {
    const error = new Error("unavailable");
    const save = vi.fn<(payload: string) => Promise<void>>()
      .mockImplementationOnce(() => { throw error; })
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined);
    const queue = new WorkspaceSaveQueue(save);
    await expect(queue.enqueue("first")).rejects.toBe(error);
    expect(queue.hasPending).toBe(false);
    await expect(queue.enqueue("second")).rejects.toBe(error);
    expect(queue.hasPending).toBe(false);
    await queue.enqueue("third");
    await queue.flush();
    expect(save.mock.calls).toEqual([["first"], ["second"], ["third"]]);
    expect(queue.hasPending).toBe(false);
  });
});
