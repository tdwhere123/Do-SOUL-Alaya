// Intentionally duplicated across package-local helpers in core, storage, and soul:
// merging them would require a shared util that violates the current dependency direction.
export function deepFreeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }

    return Object.freeze(value) as Readonly<T>;
  }

  if (value !== null && typeof value === "object") {
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nestedValue);
    }

    return Object.freeze(value) as Readonly<T>;
  }

  return value as Readonly<T>;
}
