/**
 * JSON-schema manipulation helpers.
 * Port of presenting/engine/services/schema_utils.py
 */

type JsonSchema = Record<string, unknown>;

function stripNode(node: unknown, fieldsToRemove: string[]): void {
  if (Array.isArray(node)) { node.forEach((item) => stripNode(item, fieldsToRemove)); return; }
  if (typeof node !== "object" || node === null) return;
  const obj = node as JsonSchema;
  const props = obj.properties;
  if (typeof props === "object" && props !== null) {
    const p = props as Record<string, unknown>;
    for (const f of fieldsToRemove) delete p[f];
  }
  if (Array.isArray(obj.required)) obj.required = (obj.required as string[]).filter((f) => !fieldsToRemove.includes(f));
  for (const v of Object.values(obj)) stripNode(v, fieldsToRemove);
}

export function removeFieldsFromSchema(schema: JsonSchema, fieldsToRemove: string[]): JsonSchema {
  const copy = JSON.parse(JSON.stringify(schema)) as JsonSchema;
  stripNode(copy, fieldsToRemove);
  return copy;
}

export function addFieldInSchema(schema: JsonSchema, field: Record<string, unknown>, required = false): JsonSchema {
  const entries = Object.entries(field);
  if (entries.length !== 1) throw new Error("`field` must have exactly one entry");
  const [fieldName, fieldSchema] = entries[0];
  const updated = JSON.parse(JSON.stringify(schema)) as JsonSchema;
  if (typeof updated.properties !== "object" || updated.properties === null) updated.properties = {};
  (updated.properties as Record<string, unknown>)[fieldName] = fieldSchema;
  let existingRequired = Array.isArray(updated.required) ? [...(updated.required as string[])] : [];
  if (required) { if (!existingRequired.includes(fieldName)) existingRequired.push(fieldName); }
  else { existingRequired = existingRequired.filter((n) => n !== fieldName); }
  if (existingRequired.length) updated.required = existingRequired;
  else delete updated.required;
  return updated;
}

function isArraySchemaType(typeVal: unknown): boolean {
  if (typeVal === "array") return true;
  if (Array.isArray(typeVal)) return typeVal.includes("array");
  return false;
}

function ensureNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(ensureNode);
  if (typeof node !== "object" || node === null) return node;
  const obj = node as JsonSchema;
  if (isArraySchemaType(obj.type) && !("items" in obj)) obj.items = { type: "string" };
  for (const [k, v] of Object.entries(obj)) obj[k] = ensureNode(v);
  return obj;
}

export function ensureArraySchemasHaveItems(schema: JsonSchema): JsonSchema {
  return ensureNode(JSON.parse(JSON.stringify(schema))) as JsonSchema;
}
