import { getRepeatedTopLevelGroupSchemaName } from "./template-schema.js";

export function hydrateRepeatedTopLevelGroups(
  elements: unknown[],
  content: unknown,
  applyItem: (source: Record<string, unknown>, value: unknown) => unknown,
): unknown[] | null {
  if (typeof content !== "object" || content === null || Array.isArray(content)) return null;
  const contentRecord = content as Record<string, unknown>;
  const fieldName = getRepeatedTopLevelGroupSchemaName(elements);
  if (fieldName === null) return null;
  const values = contentRecord[fieldName];
  if (!Array.isArray(values) || !elements.length) return null;
  const hydrated: unknown[] = [];
  for (let index = 0; index < values.length; index++) {
    const source = JSON.parse(
      JSON.stringify(elements[Math.min(index, elements.length - 1)]),
    ) as unknown;
    if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
    hydrated.push(applyItem(source as Record<string, unknown>, values[index]));
  }
  return hydrated;
}
