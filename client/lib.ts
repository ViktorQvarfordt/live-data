export class TypedEventEmitter<EventMap extends { [key: string]: (...args: any[]) => unknown }> {
  private listenersByName = new Map<keyof EventMap, Set<EventMap[keyof EventMap]>>()

  /** Adding the same listener twice is a no-op */
  on<Name extends keyof EventMap>(name: Name, listener: EventMap[Name]): void {
    if (!this.listenersByName.has(name)) {
      this.listenersByName.set(name, new Set())
    }

    this.listenersByName.get(name)?.add(listener)
  }

  once<Name extends keyof EventMap>(name: Name, listener: EventMap[Name]): void {
    const wrappedListener: EventMap[Name] = ((...args) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      listener(...args)
      this.off(name, wrappedListener)
    }) as EventMap[Name]

    this.on(name, wrappedListener)
  }

  /**
    - `off()` removes all listeners
    - `off(name)` removes all listeners on the given name
    - `off(name, listener)` removes the given listener on the given name
  */
  off(): void
  off<Name extends keyof EventMap>(name: Name): void
  off<Name extends keyof EventMap>(name: Name, listener: EventMap[Name]): void
  off<Name extends keyof EventMap>(name?: Name, listener?: EventMap[Name]): void {
    if (name !== undefined && listener !== undefined) {
      this.removeListener(name, listener)
    } else if (name !== undefined) {
      this.listenersByName.delete(name)
    } else {
      this.listenersByName = new Map()
    }
  }

  private removeListener<Name extends keyof EventMap>(name: Name, listener: EventMap[Name]): void {
    const listeners = this.listenersByName.get(name)
    if (listeners !== undefined) {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listenersByName.delete(name)
      }
    }
  }

  emit<Name extends keyof EventMap>(name: Name, ...args: Parameters<EventMap[Name]>): void {
    // Snapshot all listeners to make sure that the event is emitted only to current listeners.
    // (A listener can add or remove other listeners.)
    const listenersSnapshot = new Set(this.listenersByName.get(name))
    listenersSnapshot.forEach(listener => listener(...args))
  }
}
