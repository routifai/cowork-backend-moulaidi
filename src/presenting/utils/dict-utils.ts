/**
 * Generic nested-dict path helpers.
 * Port of presenting/engine/services/dict_utils.py — paths are arrays of
 * string (dict key) | number (array index), matching Python's tuple-of-Any.
 */

export type DictPath = (string | number)[];

export function getDictPathsWithKey(data: unknown, key: string): DictPath[] {
  const result: DictPath[] = [];

  function findPaths(obj: unknown, currentPath: DictPath): void {
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => findPaths(item, [...currentPath, i]));
    } else if (obj !== null && typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      if (key in o) result.push(currentPath);
      for (const [k, v] of Object.entries(o)) {
        findPaths(v, [...currentPath, k]);
      }
    }
  }

  findPaths(data, []);
  return result;
}

export function getDictAtPath(data: unknown, path: DictPath): unknown {
  let current: unknown = data;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

export function setDictAtPath(data: unknown, path: DictPath, value: unknown): void {
  if (path.length === 0) return;
  let current: unknown = data;
  for (const key of path.slice(0, -1)) {
    current = (current as Record<string | number, unknown>)[key];
  }
  if (current !== null && current !== undefined) {
    (current as Record<string | number, unknown>)[path[path.length - 1]] = value;
  }
}
