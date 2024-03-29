export type NotUndefined<T> = T extends undefined ? never : T;

export function isNotUndefined<T>(val: T): val is NotUndefined<T> {
  return val !== undefined;
}
export function isNonNullable<T>(val: T): val is NonNullable<T> {
  return val !== undefined && val !== null;
}

export function assertIsNonNullable<T>(val: T): asserts val is NonNullable<T> {
  if (!isNonNullable(val)) {
    throw new Error(
      `AssertionError: Expected ${JSON.stringify(val)} to be NonNullable.`
    );
  }
}

export function asNonNullable<T>(val: T): NonNullable<T> {
  assertIsNonNullable(val);
  return val;
}
