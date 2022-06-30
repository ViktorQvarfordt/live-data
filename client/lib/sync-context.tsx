import { createContext, FC, ReactNode, useCallback, useContext } from "react";

type ContextValue = {
  activeKeys: string
}

const Context = createContext<ContextValue>(undefined)

// const useSyncContext = (): Context => {

// }

const useContextValue = (): ContextValue => {

}

export const SyncContext: FC<{ children: ReactNode }> = ({ children }) => {
  const value = useContextValue()

  if (value === undefined) return null
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export const useCollaborativeAuthoringContext = (): ContextValue => {
  const context = useContext(Context)
  if (context === undefined)
    throw new Error('Expected component to be wrapped in a CollaborativeAuthoringContext on some level.')

  return context
}


// Exclude undefined from T
type NonUndefined<T> = T extends undefined ? never : T;

/**
 * We use `undefined` to signal that the state is loading. User can never set state to be undefined
 */
const useSyncedState = <T,>(key: string): [T | undefined, (t: NonUndefined<T>) => void] => {
  const state = useSseState(key)
  
  const setState = useCallback(() => {
    // TODO
    // fetch('/generic/state/update')
  }, [])

  return [state, setState]
}

type SyncedMap<T> = {
  has(key: string): boolean
  get(key: string): void
  set(key: string, value: T): void
  delete(key: string): void
  keys(): string[]
  values(): T[]
  entries(): [string, T][]
  size(): number
}

type MapOperation =
  | { type: 'set', key: string, value: unknown }
  | { type: 'delete', key: string }

type KeyState = {} // ?

/**
 * We use `undefined` to signal that the state is loading. User can never set state to be undefined
 */
const useSyncedMap = <T,>(key: string): SyncedMap => {
  const state = useSseState(key)

  const setState = useCallback(() => {
    // TODO
    // fetch('/generic/map/update')
  }, [])

  return [state, setState]
}

type Status = 'optimistic'


/**
 * Problem for maps:
 * 1. optimistic update
 * 2. other update comes in, removing optimistict change
 * 3. optimistic update bounces back
 * 
 * Solution:
 * - Broadcast key updates, not the full state. Keep track of opimism per key.
 */

/**
 * Server doesn't need to know about types. But keep client typesafe.
 */
