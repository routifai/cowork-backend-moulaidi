/**
 * Deterministic layout-risk inspector for Smart-mode generated HTML slides.
 * Port of presenton's servers/fastapi/utils/smart_slide_layout.py — same
 * regexes, same heuristics (Tailwind spacing-scale px conversion, absolute/
 * fixed positioning detection, sibling overlap on shared parents). Used by
 * smart-generation.ts to reject a generated slide before it's ever saved,
 * matching presenton's own validation gate.
 */
const SLIDE_WIDTH = 1280;
const SLIDE_HEIGHT = 720;

const MEDIA_TAGS = new Set(["canvas", "img", "svg", "table", "video"]);
const NEGATIVE_LAYOUT_CLASS = /^-(?:m[trblxy]?|translate-[xy])-(?:\[|\d)/i;
const NEGATIVE_LAYOUT_STYLE =
  /(?:margin(?:-top|-right|-bottom|-left)?\s*:\s*-|transform\s*:[^;]*translate(?:X|Y|3d)?\([^)]*-)/i;
const STYLE_VALUE = /(?:^|;)\s*(left|right|top|bottom|width|height|position|overflow)\s*:\s*([^;]+)/gi;
const ARBITRARY_PX_CLASS = /^(left|right|top|bottom|w|h)-\[(-?\d+(?:\.\d+)?)px\]$/i;
const SPACING_CLASS = /^(left|right|top|bottom|w|h)-(\d+(?:\.5)?)$/i;

interface LayoutNode {
  tag: string;
  attrs: Record<string, string>;
  parent: LayoutNode | null;
  children: LayoutNode[];
  text: string[];
}

function classesOf(node: LayoutNode): Set<string> {
  return new Set((node.attrs.class ?? "").split(/\s+/).filter(Boolean));
}

function stylesOf(node: LayoutNode): Record<string, string> {
  const styles: Record<string, string> = {};
  const raw = node.attrs.style ?? "";
  let match: RegExpExecArray | null;
  STYLE_VALUE.lastIndex = 0;
  while ((match = STYLE_VALUE.exec(raw))) {
    styles[match[1].toLowerCase()] = match[2].trim();
  }
  return styles;
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const TAG_TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
const ATTR_TOKEN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTR_TOKEN.lastIndex = 0;
  while ((match = ATTR_TOKEN.exec(raw))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = value;
  }
  return attrs;
}

/** Minimal SGML-ish tag-tree parser — mirrors Python's html.parser.HTMLParser
 * used by the original: not a strict HTML5 parser, just enough to build a
 * tag/attribute/text tree from well-formed LLM-generated markup, matching
 * this repo's preference for hand-rolling small parsers over new deps. */
function parseLayoutTree(html: string): LayoutNode | null {
  let root: LayoutNode | null = null;
  const stack: LayoutNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TAG_TOKEN.lastIndex = 0;

  const pushText = (text: string) => {
    if (!text) return;
    const current = stack.at(-1);
    if (current && current.tag !== "script" && current.tag !== "style") current.text.push(text);
  };

  while ((match = TAG_TOKEN.exec(html))) {
    pushText(html.slice(lastIndex, match.index));
    lastIndex = TAG_TOKEN.lastIndex;
    if (match[0].startsWith("<!--")) continue;

    const [, closing, tagName, attrsRaw, selfClosing] = match;
    const tag = tagName.toLowerCase();

    // Chart.js init scripts contain characters (comparisons, template
    // literals) that can look like tag starts to this regex tokenizer.
    // Match Python's html.parser default behavior: treat <script>/<style>
    // content as raw text up to its real closing tag.
    if (!closing && !selfClosing && (tag === "script" || tag === "style")) {
      const closeTag = `</${tag}`;
      const closeIndex = html.toLowerCase().indexOf(closeTag, lastIndex);
      const rawEnd = closeIndex === -1 ? html.length : closeIndex;
      pushText(html.slice(lastIndex, rawEnd));
      if (closeIndex !== -1) {
        const gt = html.indexOf(">", closeIndex);
        lastIndex = gt === -1 ? html.length : gt + 1;
      } else {
        lastIndex = html.length;
      }
      TAG_TOKEN.lastIndex = lastIndex;
      continue;
    }

    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const node: LayoutNode = { tag, attrs: parseAttrs(attrsRaw ?? ""), parent: stack.at(-1) ?? null, children: [], text: [] };
    if (root === null) root = node;
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node);
  }
  pushText(html.slice(lastIndex));
  return root;
}

function* walk(node: LayoutNode): Generator<LayoutNode> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

function visibleText(node: LayoutNode): string {
  const parts = [...node.text];
  for (const child of node.children) {
    if (child.tag !== "script" && child.tag !== "style") parts.push(visibleText(child));
  }
  return parts.join(" ").split(/\s+/).filter(Boolean).join(" ");
}

function containsMedia(node: LayoutNode): boolean {
  return MEDIA_TAGS.has(node.tag) || node.children.some(containsMedia);
}

function isDecorative(node: LayoutNode): boolean {
  let current: LayoutNode | null = node;
  while (current !== null) {
    if ((current.attrs["aria-hidden"] ?? "").toLowerCase() === "true") return true;
    if ((current.attrs["data-decorative"] ?? "").toLowerCase() === "true") return true;
    current = current.parent;
  }
  return false;
}

function isMeaningful(node: LayoutNode): boolean {
  return Boolean(visibleText(node)) || containsMedia(node);
}

function isPositioned(node: LayoutNode): boolean {
  const classes = classesOf(node);
  if (classes.has("absolute") || classes.has("fixed")) return true;
  const position = stylesOf(node).position?.toLowerCase();
  return position === "absolute" || position === "fixed";
}

function dimensionValue(node: LayoutNode, property: "width" | "height" | "left" | "right" | "top" | "bottom"): number | null {
  const styleValue = stylesOf(node)[property];
  if (styleValue) {
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(styleValue.trim());
    if (match) return Number(match[1]);
  }
  const classProperty = property === "width" ? "w" : property === "height" ? "h" : property;
  for (const token of classesOf(node)) {
    const arbitrary = ARBITRARY_PX_CLASS.exec(token);
    if (arbitrary && arbitrary[1].toLowerCase() === classProperty) return Number(arbitrary[2]);
    const spacing = SPACING_CLASS.exec(token);
    if (spacing && spacing[1].toLowerCase() === classProperty) return Number(spacing[2]) * 4;
  }
  return null;
}

function edgeValue(node: LayoutNode, edge: "left" | "right" | "top" | "bottom"): number | null {
  const classes = classesOf(node);
  if (classes.has("inset-0") || classes.has(`${edge}-0`)) return 0;
  return dimensionValue(node, edge);
}

function nodeSize(node: LayoutNode | null): [number | null, number | null] {
  if (!node || node.parent === null) return [SLIDE_WIDTH, SLIDE_HEIGHT];
  let width = dimensionValue(node, "width");
  let height = dimensionValue(node, "height");
  const classes = classesOf(node);
  if (classes.has("w-full")) width = nodeSize(node.parent)[0];
  if (classes.has("h-full")) height = nodeSize(node.parent)[1];
  return [width, height];
}

type Rect = { x: number; y: number; width: number; height: number };

function positionedRect(node: LayoutNode): Rect | null {
  const [parentWidth, parentHeight] = nodeSize(node.parent);
  let left = edgeValue(node, "left");
  const right = edgeValue(node, "right");
  let top = edgeValue(node, "top");
  const bottom = edgeValue(node, "bottom");
  let [width, height] = nodeSize(node);

  if (width == null && left != null && right != null && parentWidth != null) width = parentWidth - left - right;
  if (height == null && top != null && bottom != null && parentHeight != null) height = parentHeight - top - bottom;
  if (left == null && right != null && width != null && parentWidth != null) left = parentWidth - right - width;
  if (top == null && bottom != null && height != null && parentHeight != null) top = parentHeight - bottom - height;
  if (left == null || top == null || width == null || height == null) return null;
  return { x: left, y: top, width, height };
}

function rectanglesOverlap(a: Rect, b: Rect): boolean {
  const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapWidth > 4 && overlapHeight > 4;
}

/** Return deterministic risks that commonly produce clipped/overlapping slides. */
export function inspectSmartSlideLayout(html: string): string[] {
  const root = parseLayoutTree(html);
  if (!root) return [];

  const issues: string[] = [];
  const positionedByParent = new Map<LayoutNode | null, Array<{ node: LayoutNode; rect: Rect }>>();

  for (const node of walk(root)) {
    if (node === root || !isMeaningful(node) || isDecorative(node)) continue;

    const classes = classesOf(node);
    const hasNegativeClass = [...classes].some((token) => NEGATIVE_LAYOUT_CLASS.test(token));
    if (hasNegativeClass || NEGATIVE_LAYOUT_STYLE.test(node.attrs.style ?? "")) {
      issues.push("Meaningful content uses a negative margin or translation that can overlap nearby content.");
    }

    const hasHiddenOverflow = classes.has("overflow-hidden") || stylesOf(node).overflow?.toLowerCase() === "hidden";
    if (hasHiddenOverflow && visibleText(node)) {
      issues.push("A nested container hides text overflow instead of fitting all text visibly.");
    }

    if (!isPositioned(node)) continue;
    const rect = positionedRect(node);
    if (rect === null) {
      issues.push("Absolutely positioned meaningful content is missing a complete pixel box; use flex/grid or provide left/top/width/height.");
      continue;
    }
    const [parentWidth, parentHeight] = nodeSize(node.parent);
    if (rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0) {
      issues.push("Positioned meaningful content has invalid or off-canvas geometry.");
    } else if (parentWidth != null && rect.x + rect.width > parentWidth + 1) {
      issues.push("Positioned meaningful content crosses the right slide/container boundary.");
    } else if (parentHeight != null && rect.y + rect.height > parentHeight + 1) {
      issues.push("Positioned meaningful content crosses the bottom slide/container boundary.");
    }

    const siblings = positionedByParent.get(node.parent) ?? [];
    siblings.push({ node, rect });
    positionedByParent.set(node.parent, siblings);
  }

  for (const siblings of positionedByParent.values()) {
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        if (rectanglesOverlap(siblings[i].rect, siblings[j].rect)) {
          issues.push("Absolutely positioned sibling content boxes overlap; reflow them with flex/grid and explicit gaps.");
        }
      }
    }
  }

  return [...new Set(issues)];
}
