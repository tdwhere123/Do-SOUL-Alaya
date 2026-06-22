// Intentionally duplicated across package-local helpers in protocol, core, storage, and soul:
// merging them would require a shared util that violates the current dependency direction.
export function deepFreeze<T>(value: T): Readonly<T> {
  freezeRecursive(value, new WeakSet<object>());
  return value as Readonly<T>;
}

// WeakSet guard stops a cyclic object graph from overflowing the stack.
function freezeRecursive(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      freezeRecursive(item, seen);
    }
  } else {
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      freezeRecursive(nestedValue, seen);
    }
  }

  Object.freeze(value);
}
