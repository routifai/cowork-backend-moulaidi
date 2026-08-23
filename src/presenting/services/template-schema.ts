const CONTENT_TYPES = new Set(["text", "image", "text-list", "table", "chart", "infographic"]);
const CHART_TYPE_VALUES = [
  "area", "bar", "bubble", "donut", "horizontal_bar", "horizontal_stacked_bar",
  "line", "pie", "polar_area", "radar", "scatter", "stacked_bar",
];
const REPEATED_NAME_SUFFIX_RE = /_\d+$/;
const JSON_SCHEMA_URI = "https://json-schema.org/draft/2020-12/schema";
const COMPONENT_REPEATED_NAME_TOKEN_RE = /_\d+(?=_|$)/;
const COMPONENT_SCHEMA_METADATA_KEYS = new Set([
  "$schema", "title", "description", "x-element-type", "x-element-path",
]);

// ── Public API ───────────────────────────────────────────────────────────────

export function getComponentSchema(component: unknown): Record<string, unknown> | null {
  const componentData = _componentData(component);
  const elements = componentData["elements"];
  if (!Array.isArray(elements)) throw new Error("component must contain an elements array");
  const properties = _componentSchemaProperties(elements);
  if (!properties || Object.keys(properties).length === 0) return null;
  return {
    $schema: JSON_SCHEMA_URI,
    type: "object",
    title: componentData["id"] ?? "component_content",
    description: componentData["description"],
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}

export function getRepeatedTopLevelGroupSchemaName(elements: unknown[]): string | null {
  const node = _componentRepeatedTopLevelGroupNode(elements, "elements");
  return node !== null ? node[0] : null;
}

export function getTemplateSchema(
  templateJson: unknown,
  sourceFile = "template.json",
): Record<string, unknown> {
  const templateData = _templateData(templateJson);
  const layouts = templateData["layouts"];
  if (!Array.isArray(layouts)) throw new Error("template JSON must contain a layouts array");
  const generatedLayouts = layouts
    .filter(
      (layout): layout is Record<string, unknown> =>
        typeof layout === "object" && layout !== null && !Array.isArray(layout),
    )
    .map((layout, index) => _templateLayoutSchema(layout, index + 1));
  return {
    source_file: sourceFile,
    layout_count: generatedLayouts.length,
    layouts: generatedLayouts,
  };
}

// ── Template-level helpers (simple schema) ───────────────────────────────────

function _propertiesSchema(elements: unknown[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, schema] of _nodesForElements(elements)) {
    _addProperty(properties, name, schema);
  }
  return properties;
}

function _nodesForElements(elements: unknown[]): [string, Record<string, unknown>][] {
  const nodes: [string, Record<string, unknown>][] = [];
  for (const value of elements) {
    const node = _nodeForElementValue(value);
    if (node !== null) nodes.push(node);
  }
  return nodes;
}

function _nodeForElementValue(value: unknown): [string, Record<string, unknown>] | null {
  const element = _elementDict(value);
  if (element === null) return null;
  return _nodeForElement(element);
}

function _nodeForElement(element: Record<string, unknown>): [string, Record<string, unknown>] | null {
  const elementType = element["type"];
  if (elementType === "container") return _nodeForElementValue(element["child"]);
  if (elementType === "flex" || elementType === "grid" || elementType === "group") {
    const children = element["children"];
    if (!Array.isArray(children)) return null;
    const nodes = _nodesForElements(children);
    if (!nodes.length) return null;
    const name = _elementName(element);
    if (name === null) return null;
    if (elementType === "flex" || elementType === "grid") {
      const arraySchema = _arraySchemaForRepeatedChildren(element, children, nodes);
      if (arraySchema !== null) return [name, arraySchema];
    }
    const properties: Record<string, unknown> = {};
    for (const [childName, childSchema] of nodes) _addProperty(properties, childName, childSchema);
    const schema: Record<string, unknown> = _objectSchema(properties);
    if (elementType === "flex" || elementType === "grid") {
      Object.assign(
        schema,
        _compact({ minProperties: element["min_children"], maxProperties: element["max_children"] }),
      );
    }
    return [name, schema];
  }
  if (!_isContentType(elementType) || !_isEditableElement(element)) return null;
  const name = _elementName(element);
  if (name === null) return null;
  return [name, _contentSchemaForElement(element)];
}

function _contentSchemaForElement(element: Record<string, unknown>): Record<string, unknown> {
  const elementType = element["type"] as string;
  if (elementType === "text") {
    return _compact({ type: "string", minLength: element["min_length"], maxLength: element["max_length"] });
  }
  if (elementType === "image") {
    const key = element["is_icon"] === true ? "icon_query" : "image_prompt";
    return _objectSchema({ [key]: { type: "string" } });
  }
  if (elementType === "text-list") {
    return _compact({
      type: "array",
      minItems: element["min_items"],
      maxItems: element["max_items"],
      items: _compact({
        type: "string",
        minLength: element["min_item_length"],
        maxLength: element["max_item_length"],
      }),
    });
  }
  if (elementType === "table") {
    return _compact({
      type: "array",
      minItems: element["min_rows"],
      maxItems: element["max_rows"],
      items: _compact({
        type: "array",
        minItems: element["min_columns"],
        maxItems: element["max_columns"],
        items: { type: "string" },
      }),
    });
  }
  if (elementType === "chart") return _chartContentSchema();
  if (elementType === "infographic") return _infographicContentSchema();
  throw new Error(`unsupported content element type: ${elementType}`);
}

function _arraySchemaForRepeatedChildren(
  element: Record<string, unknown>,
  children: unknown[],
  nodes: [string, Record<string, unknown>][],
): Record<string, unknown> | null {
  if (nodes.length !== _elementCount(children)) return null;
  if (nodes.length < 2 && !_canExpandRepeatedChildren(element, nodes.length)) return null;
  const itemSchemas = nodes.map(([name, schema]) =>
    _schemaWithoutRepeatedNameSuffix(schema, _repeatedNameSuffix(name)),
  );
  const itemSchema = _componentMergeRepeatedSchemas(itemSchemas);
  if (itemSchema === null) return null;
  return _compact({
    type: "array",
    minItems: element["min_children"],
    maxItems: element["max_children"],
    items: itemSchema,
  });
}

function _objectSchema(
  properties: Record<string, unknown>,
  required?: string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: required ?? Object.keys(properties),
    additionalProperties: false,
  };
}

function _elementName(element: Record<string, unknown>): string | null {
  const name = element["name"];
  if (typeof name !== "string") return null;
  const stripped = name.trim();
  return stripped || null;
}

function _addProperty(
  properties: Record<string, unknown>,
  name: string,
  schema: unknown,
): void {
  let key = name;
  let suffix = 2;
  while (key in properties) { key = `${name}_${suffix}`; suffix++; }
  properties[key] = schema;
}

function _schemaWithoutRepeatedNameSuffix(
  schema: Record<string, unknown>,
  suffix: string | null,
): Record<string, unknown> {
  if (schema["type"] !== "object") {
    return Object.fromEntries(
      Object.entries(schema).map(([k, v]) => [k, _normalizeSchemaValue(v, suffix)]),
    );
  }
  const properties = schema["properties"];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return Object.fromEntries(
      Object.entries(schema).map(([k, v]) => [k, _normalizeSchemaValue(v, suffix)]),
    );
  }
  const propsRecord = properties as Record<string, unknown>;
  const normalizedProperties: Record<string, unknown> = {};
  const nameMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(propsRecord)) {
    const normalizedKey = _stripRepeatedSuffix(key, suffix);
    nameMap[key] = normalizedKey;
    normalizedProperties[normalizedKey] = _normalizeSchemaValue(value, suffix);
  }
  const normalizedSchema: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k !== "properties" && k !== "required") {
      normalizedSchema[k] = _normalizeSchemaValue(v, suffix);
    }
  }
  normalizedSchema["properties"] = normalizedProperties;
  const required = schema["required"];
  if (Array.isArray(required)) {
    normalizedSchema["required"] = required
      .filter((item): item is string => typeof item === "string")
      .map((item) => nameMap[item] ?? _stripRepeatedSuffix(item, suffix));
  }
  return normalizedSchema;
}

function _normalizeSchemaValue(value: unknown, suffix: string | null): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return _schemaWithoutRepeatedNameSuffix(value as Record<string, unknown>, suffix);
  }
  if (Array.isArray(value)) return value.map((item) => _normalizeSchemaValue(item, suffix));
  return value;
}

function _repeatedNameSuffix(value: string): string | null {
  const match = REPEATED_NAME_SUFFIX_RE.exec(value);
  return match ? match[0] : null;
}

function _stripRepeatedSuffix(value: string, suffix: string | null): string {
  if (suffix && value.endsWith(suffix)) return value.slice(0, -suffix.length);
  return value;
}

function _elementCount(values: unknown[]): number {
  return values.filter((v) => _elementDict(v) !== null).length;
}

function _canExpandRepeatedChildren(element: Record<string, unknown>, childCount: number): boolean {
  const maxChildren = element["max_children"];
  return typeof maxChildren === "number" && maxChildren > childCount;
}

function _compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== null && v !== undefined),
  );
}

function _elementDict(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

// ── Template layout schema ───────────────────────────────────────────────────

function _templateLayoutSchema(layout: Record<string, unknown>, slideIndex: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const rawComponents = layout["components"];
  const components: unknown[] = Array.isArray(rawComponents) ? rawComponents : [];

  const componentEntries: [string, Record<string, unknown>][] = [];
  for (const component of components) {
    const componentData = _componentDataOrNone(component);
    if (componentData === null) continue;
    const componentSchema = getComponentSchema(componentData);
    if (componentSchema === null) continue;
    componentEntries.push([_componentId(componentData), componentSchema]);
  }

  const componentCounts: Record<string, number> = {};
  for (const [componentId] of componentEntries) {
    componentCounts[componentId] = (componentCounts[componentId] ?? 0) + 1;
  }

  const componentIndexes: Record<string, number> = {};
  for (const [componentId, componentSchema] of componentEntries) {
    const componentIndex = componentIndexes[componentId] ?? 0;
    componentIndexes[componentId] = componentIndex + 1;
    const key = _templateComponentKey(componentId, {
      occurrenceIndex: componentIndex,
      occurrenceCount: componentCounts[componentId],
      properties,
    });
    properties[key] = _componentSchemaForTemplate(componentSchema);
    required.push(key);
  }

  let schema: Record<string, unknown> | null = null;
  if (Object.keys(properties).length > 0) {
    schema = {
      $schema: JSON_SCHEMA_URI,
      type: "object",
      title: layout["id"] ?? `slide_${slideIndex}`,
      description: layout["description"],
      additionalProperties: false,
      properties,
      required,
    };
  }

  return { slide: slideIndex, layout_id: layout["id"], schema };
}

function _componentSchemaForTemplate(
  componentSchema: Record<string, unknown>,
): Record<string, unknown> {
  const schema = _stripComponentSchemaMetadata(JSON.parse(JSON.stringify(componentSchema)));
  if (typeof schema === "object" && schema !== null && !Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  return componentSchema;
}

function _stripComponentSchemaMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(_stripComponentSchemaMetadata);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (COMPONENT_SCHEMA_METADATA_KEYS.has(key)) continue;
    if (key === "properties" && typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
      stripped[key] = Object.fromEntries(
        Object.entries(nested as Record<string, unknown>).map(([pn, ps]) => [
          pn,
          _stripComponentSchemaMetadata(ps),
        ]),
      );
      continue;
    }
    stripped[key] = _stripComponentSchemaMetadata(nested);
  }
  return stripped;
}

function _templateComponentKey(
  componentId: string,
  opts: { occurrenceIndex: number; occurrenceCount: number; properties: Record<string, unknown> },
): string {
  const { occurrenceIndex, occurrenceCount, properties } = opts;
  const key = occurrenceCount > 1 ? `${componentId}_${occurrenceIndex}` : componentId;
  let suffix = 1;
  let uniqueKey = key;
  while (uniqueKey in properties) { uniqueKey = `${key}_${suffix}`; suffix++; }
  return uniqueKey;
}

function _componentData(component: unknown): Record<string, unknown> {
  const componentData = _componentDataOrNone(component);
  if (componentData !== null) return componentData;
  throw new Error("component must be a Component or JSON object");
}

function _componentDataOrNone(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }
  return null;
}

function _templateData(templateJson: unknown): Record<string, unknown> {
  if (typeof templateJson === "object" && templateJson !== null && !Array.isArray(templateJson)) {
    return JSON.parse(JSON.stringify(templateJson)) as Record<string, unknown>;
  }
  throw new Error("template JSON must be a JSON object");
}

function _componentId(componentData: Record<string, unknown>): string {
  const componentId = componentData["id"];
  if (typeof componentId === "string") return componentId;
  throw new Error("component must include a string id");
}

// ── Component schema (rich, with x-element-path metadata) ───────────────────

function _componentSchemaProperties(elements: unknown[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, schema] of _componentSchemaNodesForElements(elements, "elements")) {
    _componentAddSchemaProperty(properties, name, schema);
  }
  return properties;
}

function _componentSchemaNodesForElements(
  elements: unknown[],
  path: string,
): [string, Record<string, unknown>][] {
  const repeatedTopLevelGroups = _componentRepeatedTopLevelGroupNode(elements, path);
  if (repeatedTopLevelGroups !== null) return [repeatedTopLevelGroups];
  const nodes: [string, Record<string, unknown>][] = [];
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (typeof element === "object" && element !== null && !Array.isArray(element)) {
      nodes.push(
        ..._componentSchemaNodesForElement(element as Record<string, unknown>, `${path}.${index}`),
      );
    }
  }
  return nodes;
}

function _componentSchemaNodesForElement(
  element: Record<string, unknown>,
  path: string,
): [string, Record<string, unknown>][] {
  const elementType = element["type"];
  const name = _componentSchemaElementName(element);

  if (typeof elementType === "string" && CONTENT_TYPES.has(elementType) && _isEditableElement(element) && name !== null) {
    return [[name, _componentContentFieldSchema({ name, path, element })]];
  }

  if (elementType === "container") {
    const child = element["child"];
    const childNodes =
      typeof child === "object" && child !== null && !Array.isArray(child)
        ? _componentSchemaNodesForElement(child as Record<string, unknown>, `${path}.child`)
        : [];
    if (name === null || !childNodes.length) return childNodes;
    return [[name, _componentObjectSchemaFromNodes(childNodes)]];
  }

  if (elementType === "flex" || elementType === "grid" || elementType === "group") {
    const children = element["children"];
    if (!Array.isArray(children)) return [];
    const childNodeSets = children.map((child, index) =>
      typeof child === "object" && child !== null && !Array.isArray(child)
        ? _componentSchemaNodesForElement(child as Record<string, unknown>, `${path}.children.${index}`)
        : [],
    );
    const childNodes = childNodeSets.flat();
    if (name === null || !childNodes.length) return childNodes;

    const supportsRepeatedChildren =
      elementType === "flex" ||
      elementType === "grid" ||
      (elementType === "group" &&
        children.every(
          (child) =>
            typeof child === "object" &&
            child !== null &&
            !Array.isArray(child) &&
            (child as Record<string, unknown>)["type"] === "group",
        ));

    if (supportsRepeatedChildren) {
      const arraySchema = _componentArraySchemaForRepeatedChildren(element, childNodeSets);
      if (arraySchema !== null) return [[name, arraySchema]];
    }
    return [[name, _componentObjectSchemaFromNodes(childNodes)]];
  }

  return [];
}

function _componentRepeatedTopLevelGroupNode(
  elements: unknown[],
  path: string,
): [string, Record<string, unknown>] | null {
  const groups = elements.filter(
    (e): e is Record<string, unknown> =>
      typeof e === "object" && e !== null && !Array.isArray(e),
  );
  if (
    groups.length !== elements.length ||
    !groups.length ||
    groups.some((g) => g["type"] !== "group")
  )
    return null;

  const nodeSets = groups.map((group, index) =>
    _componentSchemaNodesForElement(group, `${path}.${index}`),
  );

  const result = _componentRepeatedChildrenSchemaResult(
    { type: "group", children: groups },
    nodeSets,
  );
  if (result === null || !nodeSets[0]?.length) return null;

  const [schema, strategy] = result as [Record<string, unknown>, "numeric" | "none" | "prefix"];
  const firstName = nodeSets[0][0][0];
  const token = _componentNormalizationTokenForNodes(nodeSets[0], strategy);
  return [_componentStripRepeatedSuffix(firstName, token), schema];
}

function _componentSchemaElementName(element: Record<string, unknown>): string | null {
  const name = element["name"];
  if (typeof name !== "string") return null;
  const stripped = name.trim();
  return stripped || null;
}

function _componentObjectSchemaFromNodes(
  nodes: [string, Record<string, unknown>][],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, schema] of nodes) _componentAddSchemaProperty(properties, name, schema);
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}

function _componentAddSchemaProperty(
  properties: Record<string, unknown>,
  name: string,
  schema: unknown,
): void {
  let key = name;
  let suffix = 2;
  while (key in properties) { key = `${name}_${suffix}`; suffix++; }
  properties[key] = schema;
}

function _componentArraySchemaForRepeatedChildren(
  element: Record<string, unknown>,
  childNodeSets: [string, Record<string, unknown>][][],
): Record<string, unknown> | null {
  const result = _componentRepeatedChildrenSchemaResult(element, childNodeSets);
  return result !== null ? result[0] : null;
}

function _componentRepeatedChildrenSchemaResult(
  element: Record<string, unknown>,
  childNodeSets: [string, Record<string, unknown>][][],
): [Record<string, unknown>, string] | null {
  const populatedNodeSets = childNodeSets.filter((ns) => ns.length > 0);
  if (populatedNodeSets.length !== childNodeSets.length) return null;
  if (populatedNodeSets.length < 2 && !_canExpandRepeatedChildren(element, populatedNodeSets.length)) return null;

  for (const strategy of ["numeric", "none", "prefix"] as const) {
    const normalizedItemSchemas = populatedNodeSets.map((ns) =>
      _componentNormalizedRepeatedItemSchema(ns, strategy),
    );
    const mergedItemSchema = _componentMergeRepeatedSchemas(normalizedItemSchemas);
    if (mergedItemSchema !== null) {
      const [minItems, maxItems] = _componentRepeatedItemLimits(element, childNodeSets.length);
      return [
        _withoutNoneValues({ type: "array", minItems, maxItems, items: mergedItemSchema }) as Record<string, unknown>,
        strategy,
      ];
    }
  }
  return null;
}

function _componentRepeatedItemLimits(
  element: Record<string, unknown>,
  itemCount: number,
): [unknown, unknown] {
  if (element["type"] !== "group") return [element["min_children"], element["max_children"]];
  return [Math.floor(itemCount / 2), itemCount];
}

function _componentNormalizedRepeatedItemSchema(
  nodes: [string, Record<string, unknown>][],
  strategy: "numeric" | "none" | "prefix",
): Record<string, unknown> {
  const token = _componentNormalizationTokenForNodes(nodes, strategy);
  const itemSchema =
    nodes.length === 1 && nodes[0][1]["type"] === "object"
      ? nodes[0][1]
      : _componentObjectSchemaFromNodes(nodes);
  const normalized = _componentSchemaWithoutRepeatedNameSuffix(itemSchema, token);
  if (
    token &&
    nodes.length === 1 &&
    typeof (normalized as Record<string, unknown>)["title"] === "string"
  ) {
    (normalized as Record<string, unknown>)["title"] = _componentContentFieldTitle(
      _componentStripRepeatedSuffix(nodes[0][0], token),
    );
  }
  return normalized;
}

function _componentNormalizationTokenForNodes(
  nodes: [string, Record<string, unknown>][],
  strategy: "numeric" | "none" | "prefix",
): string | null {
  if (strategy === "none") return null;
  const tokenGetter =
    strategy === "numeric" ? _componentNumericNameToken : _componentPrefixNameToken;
  const tokens = nodes.map(([name]) => tokenGetter(name)).filter((t): t is string => t !== null);
  if (!tokens.length) return null;
  const firstToken = tokens[0];
  if (tokens.every((t) => t === firstToken)) return firstToken;
  return null;
}

function _componentNumericNameToken(value: string): string | null {
  const match = COMPONENT_REPEATED_NAME_TOKEN_RE.exec(value);
  return match ? match[0] : null;
}

function _componentPrefixNameToken(value: string): string | null {
  const sepIndex = value.indexOf("_");
  if (sepIndex === -1 || sepIndex === 0) return null;
  return `${value.slice(0, sepIndex)}_`;
}

function _componentSchemaWithoutRepeatedNameSuffix(
  schema: Record<string, unknown>,
  suffix: string | null,
): Record<string, unknown> {
  const normalized = _componentNormalizeSchemaValue(schema, suffix);
  if (typeof normalized === "object" && normalized !== null && !Array.isArray(normalized)) {
    return normalized as Record<string, unknown>;
  }
  return schema;
}

function _componentNormalizeSchemaValue(value: unknown, suffix: string | null): unknown {
  if (Array.isArray(value)) return value.map((item) => _componentNormalizeSchemaValue(item, suffix));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (key === "x-element-path") continue;
    if (key === "properties" && typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
      const properties: Record<string, unknown> = {};
      for (const [propertyName, propertySchema] of Object.entries(nested as Record<string, unknown>)) {
        const normalizedName = _componentStripRepeatedSuffix(propertyName, suffix);
        const normalizedSchema = _componentNormalizeSchemaValue(propertySchema, suffix);
        if (
          typeof normalizedSchema === "object" &&
          normalizedSchema !== null &&
          !Array.isArray(normalizedSchema) &&
          "title" in (normalizedSchema as Record<string, unknown>)
        ) {
          (normalizedSchema as Record<string, unknown>)["title"] =
            _componentContentFieldTitle(normalizedName);
        }
        properties[normalizedName] = normalizedSchema;
      }
      normalized[key] = properties;
      continue;
    }
    if (key === "required" && Array.isArray(nested)) {
      normalized[key] = nested
        .filter((item): item is string => typeof item === "string")
        .map((item) => _componentStripRepeatedSuffix(item, suffix));
      continue;
    }
    normalized[key] = _componentNormalizeSchemaValue(nested, suffix);
  }
  return normalized;
}

function _componentStripRepeatedSuffix(value: string, suffix: string | null): string {
  if (suffix && value.includes(suffix)) return value.replace(suffix, "");
  return value;
}

function _componentMergeRepeatedSchemas(
  schemas: Record<string, unknown>[],
): Record<string, unknown> | null {
  if (!schemas.length) return null;
  const first = JSON.stringify(_componentComparableRepeatedSchema(schemas[0]));
  if (schemas.some((s) => JSON.stringify(_componentComparableRepeatedSchema(s)) !== first)) return null;
  return _withoutNoneValues(JSON.parse(JSON.stringify(schemas[0]))) as Record<string, unknown>;
}

function _componentComparableRepeatedSchema(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => _componentComparableRepeatedSchema(item));
    if ((key === "enum" || key === "required") && items.every((item) => typeof item === "string")) {
      return (items as string[]).sort();
    }
    return items;
  }
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const comparable: Record<string, unknown> = {};
  for (const nestedKey of Object.keys(record).sort()) {
    if (nestedKey === "x-element-path") continue;
    comparable[nestedKey] = _componentComparableRepeatedSchema(record[nestedKey], nestedKey);
  }
  return comparable;
}

function _componentContentFieldSchema(field: {
  name: string;
  path: string;
  element: Record<string, unknown>;
}): Record<string, unknown> {
  const { name, path, element } = field;
  const elementType = element["type"] as string;
  let schema: Record<string, unknown>;

  if (elementType === "text") {
    schema = { type: "string", minLength: element["min_length"], maxLength: element["max_length"] };
  } else if (elementType === "image") {
    const promptKey = _componentImagePromptKey(element);
    schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        [promptKey]: {
          type: "string",
          description: _componentImagePromptDescription(element),
        },
      },
      required: [promptKey],
    };
  } else if (elementType === "text-list") {
    schema = {
      type: "array",
      items: {
        type: "string",
        minLength: element["min_item_length"],
        maxLength: element["max_item_length"],
      },
      minItems: element["min_items"],
      maxItems: element["max_items"],
    };
  } else if (elementType === "table") {
    schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        columns: {
          type: "array",
          items: { type: "string" },
          minItems: element["min_columns"],
          maxItems: element["max_columns"],
        },
        rows: {
          type: "array",
          items: {
            type: "array",
            items: { type: "string" },
            minItems: element["min_columns"],
            maxItems: element["max_columns"],
          },
          minItems: element["min_rows"],
          maxItems: element["max_rows"],
        },
      },
      required: ["columns", "rows"],
    };
  } else if (elementType === "chart") {
    schema = _chartContentSchema();
  } else if (elementType === "infographic") {
    schema = _infographicContentSchema();
  } else {
    schema = {};
  }

  return {
    ...(_withoutNoneValues(schema) as Record<string, unknown>),
    title: _componentContentFieldTitle(name),
    "x-element-type": elementType,
    "x-element-path": path,
  };
}

function _infographicDataContentSchema(infographicType: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { const: infographicType },
      min_value: { type: "number" },
      max_value: { type: "number" },
      value: { type: "number" },
    },
    required: ["type", "min_value", "max_value", "value"],
  };
}

function _infographicContentSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      data: {
        oneOf: [
          _infographicDataContentSchema("progress_bar"),
          _infographicDataContentSchema("gauge"),
        ],
      },
      colors: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["data"],
  };
}

function _chartContentSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      chart_type: { type: "string", enum: CHART_TYPE_VALUES },
      title: { type: ["string", "null"] },
      categories: { type: "array", items: { type: "string" }, maxItems: 24 },
      series: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            values: { type: "array", items: { type: "number" }, maxItems: 24 },
          },
          required: ["name", "values"],
        },
        maxItems: 12,
      },
    },
    required: ["chart_type", "categories", "series"],
  };
}

function _componentContentFieldTitle(name: string): string {
  const parts = name.split("_").filter((p) => p);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ") || name;
}

function _componentImagePromptKey(element: Record<string, unknown>): string {
  return element["is_icon"] === true ? "icon_query" : "image_prompt";
}

function _componentImagePromptDescription(element: Record<string, unknown>): string {
  return element["is_icon"] === true
    ? "Search query for the replacement icon."
    : "Prompt for the replacement image.";
}

function _withoutNoneValues(value: unknown): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, _withoutNoneValues(v)]),
    );
  }
  if (Array.isArray(value)) return value.map(_withoutNoneValues);
  return value;
}

function _isEditableElement(element: Record<string, unknown>): boolean {
  return element["decorative"] === false;
}

function _isContentType(value: unknown): value is string {
  return typeof value === "string" && CONTENT_TYPES.has(value);
}
