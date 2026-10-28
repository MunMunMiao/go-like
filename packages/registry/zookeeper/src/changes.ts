/** Receives one local post-commit reconciliation signal. */
export interface ChangeListener {
  /** Reconciles one attached watcher before a local mutation returns. */
  (): Promise<void>
}

/** Coordinates lossless same-Registry transitions with backend one-shot watches. */
export interface ChangeBus {
  /** Publishes one local post-commit signal. */
  notify(): Promise<void>
  /** Attaches one watcher and returns an exact unsubscribe function. */
  subscribe(listener: ChangeListener): () => void
}

/** Creates one Registry-local change bus. */
export function newChangeBus(): ChangeBus {
  const listeners = new Set<ChangeListener>()
  return Object.freeze({
    /** Waits until each currently attached watcher has reconciled. */
    async notify(): Promise<void> {
      for (const listener of Array.from(listeners)) await listener()
    },
    /** Attaches one exact watcher callback. */
    subscribe(listener: ChangeListener): () => void {
      listeners.add(listener)
      /** Detaches exactly this callback. */
      function unsubscribe(): void {
        listeners.delete(listener)
      }
      return unsubscribe
    }
  })
}
