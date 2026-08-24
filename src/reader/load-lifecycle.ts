/** Internal cancellation marker for superseded or destroyed Reader loads. */
export class ReaderLoadCancelledError extends Error {
  constructor() {
    super('Reader load cancelled');
    this.name = 'ReaderLoadCancelledError';
  }
}

export function throwIfReaderLoadCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new ReaderLoadCancelledError();
  }
}

export function isReaderLoadCancelled(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true || error instanceof ReaderLoadCancelledError) {
    return true;
  }
  return (
    (error instanceof DOMException || error instanceof Error) &&
    (error.name === 'AbortError' || error.name === 'ReaderLoadCancelledError')
  );
}

/** Let the overlay cancel click run during a long archive open. */
export async function yieldReaderLoad(signal?: AbortSignal): Promise<void> {
  throwIfReaderLoadCancelled(signal);
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') {
    await scheduler.yield();
  } else {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throwIfReaderLoadCancelled(signal);
}
