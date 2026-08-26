/**
 * Renders one slide's `ui` JSON (the TemplateV2 element tree — same shape
 * `template-binding.ts` produces: `{ components: [{ position, elements }] }`)
 * as real HTML/CSS on a fixed 1280x720 canvas.
 *
 * This is NOT meant to be a faithful visual renderer on its own — the point
 * is to hand the DOM to a real browser (see dom-layout-resolver.ts) so its
 * actual layout engine (flexbox, grid, text wrapping) computes exact pixel
 * geometry, instead of approximating that math in JS. Every "leaf" element
 * that's a native-export candidate (text, text-list, image, and axis-aligned
 * unrotated rectangle vectors with only a fill) gets a `data-leaf="<id>"`
 * marker so the resolver can read its `getBoundingClientRect()` back and
 * match it to the source element.
 *
 * Any element type/shape this doesn't know how to map to a real pptx native
 * shape (charts, tables, non-rect or stroked/rotated vectors, filled
 * containers, svg, infographic) flips `hasUnsupportedContent` — the caller
 * then discards this render entirely and falls back to the existing
 * raster (`json-to-image`) export path for that whole slide.
 */

export const STAGE_WIDTH = 1280;
export const STAGE_HEIGHT = 720;

export interface RenderedLeaf {
	id: string;
	kind: "text" | "text-list" | "image" | "rect";
	element: Record<string, unknown>;
}

export interface SlideDomRender {
	html: string;
	leaves: RenderedLeaf[];
	hasUnsupportedContent: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function esc(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(text: string): string {
	return esc(text).replace(/"/g, "&quot;");
}

function styleAttr(styles: Record<string, string | number | undefined | null>): string {
	return Object.entries(styles)
		.filter(([, v]) => v !== undefined && v !== null && v !== "")
		.map(([k, v]) => `${k}:${v}`)
		.join(";");
}

function cssAlign(value: unknown): string {
	const v = typeof value === "string" ? value : "stretch";
	if (v === "center" || v === "flex-start" || v === "flex-end" || v === "stretch") return v;
	return "stretch";
}

function cssJustify(value: unknown): string {
	const v = typeof value === "string" ? value : "flex-start";
	if (v === "center" || v === "flex-start" || v === "flex-end") return v;
	if (v === "space-between" || v === "space-around" || v === "space-evenly") return v;
	return "flex-start";
}

function isAxisAlignedRect(points: Array<{ x: number; y: number }>): boolean {
	if (points.length !== 4) return false;
	const xs = new Set(points.map((p) => p.x));
	const ys = new Set(points.map((p) => p.y));
	return xs.size === 2 && ys.size === 2;
}

function rectBoxFromPoints(points: Array<{ x: number; y: number }>): { x: number; y: number; width: number; height: number } {
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function renderSlideUiToHtml(ui: Record<string, unknown>): SlideDomRender {
	const leaves: RenderedLeaf[] = [];
	let hasUnsupportedContent = false;
	let counter = 0;
	const nextId = () => `leaf-${counter++}`;

	function renderRuns(runsValue: unknown): string {
		const runs = Array.isArray(runsValue) ? runsValue : [];
		return runs
			.map((r) => {
				const run = asRecord(r);
				if (!run) return "";
				const isLatex = run.type === "latex";
				const text = isLatex ? String(run.latex ?? "") : String(run.text ?? "");
				const font = asRecord(run.font) ?? {};
				const style = styleAttr({
					"font-weight": font.bold ? 700 : undefined,
					"font-style": font.italic ? "italic" : undefined,
					"text-decoration": font.underline ? "underline" : undefined,
					color: typeof font.color === "string" ? font.color : undefined,
					"font-size": num(font.size) != null ? `${num(font.size)}px` : undefined,
					"font-family": typeof font.family === "string" ? `${font.family}, sans-serif` : undefined,
				});
				return `<span${style ? ` style="${style}"` : ""}>${esc(text)}</span>`;
			})
			.join("");
	}

	/** flowManaged: true when this element is a normal-flow child of a flex/grid parent (CSS positions it); false means it's absolutely positioned at its own stored x/y (component-level or container/group children). */
	function renderElement(element: Record<string, unknown>, flowManaged: boolean): string {
		const type = typeof element.type === "string" ? element.type : "";
		const layout = asRecord(element.layout) ?? {};
		const position = asRecord(element.position);
		const size = asRecord(element.size);

		const box: Record<string, string | number | undefined> = {};
		if (!flowManaged) {
			box.position = "absolute";
			box.left = `${num(position?.x) ?? 0}px`;
			box.top = `${num(position?.y) ?? 0}px`;
		} else {
			const grow = num(layout.grow);
			const basis = num(layout.basis);
			const colSpan = num(layout.column_span);
			const rowSpan = num(layout.row_span);
			if (grow != null) box["flex-grow"] = grow;
			if (basis != null) box["flex-basis"] = `${basis}px`;
			if (colSpan != null) box["grid-column"] = `span ${colSpan}`;
			if (rowSpan != null) box["grid-row"] = `span ${rowSpan}`;
			const alignSelf = layout.align_self;
			if (typeof alignSelf === "string") box["align-self"] = cssAlign(alignSelf);
		}
		if (size) {
			const w = num(size.width);
			const h = num(size.height);
			if (w != null) box.width = `${w}px`;
			if (h != null) box.height = `${h}px`;
		}
		if (num(element.opacity) != null) box.opacity = num(element.opacity) as number;

		// --- leaf types -------------------------------------------------------
		if (type === "text") {
			const rotation = num(element.rotation);
			if (rotation) hasUnsupportedContent = true; // rotation unsupported by pptx-from-json's textbox shape
			const id = nextId();
			leaves.push({ id, kind: "text", element });
			const font = asRecord(element.font) ?? {};
			const alignment = asRecord(element.alignment) ?? {};
			const justify = alignment.horizontal === "center" ? "center" : alignment.horizontal === "right" ? "flex-end" : "flex-start";
			const alignItems = alignment.vertical === "middle" ? "center" : alignment.vertical === "bottom" ? "flex-end" : "flex-start";
			const style = styleAttr({
				...box,
				display: "flex",
				"flex-direction": "column",
				"justify-content": alignItems,
				overflow: "hidden",
			});
			const innerStyle = styleAttr({
				"text-align": (alignment.horizontal as string) ?? "left",
				"font-family": `${(font.family as string) ?? "Arial"}, sans-serif`,
				"font-size": `${num(font.size) ?? 18}px`,
				color: (font.color as string) ?? "#111827",
				"font-weight": font.bold ? 700 : 400,
				"font-style": font.italic ? "italic" : "normal",
				"line-height": num(font.line_height) ?? 1.15,
				"white-space": "pre-wrap",
				"overflow-wrap": "break-word",
				width: "100%",
			});
			return `<div data-leaf="${id}" style="${style}"><div style="${innerStyle}">${renderRuns(element.runs)}</div></div>`;
		}

		if (type === "text-list") {
			const rotation = num(element.rotation);
			if (rotation) hasUnsupportedContent = true;
			const id = nextId();
			leaves.push({ id, kind: "text-list", element });
			const font = asRecord(element.font) ?? {};
			const items = Array.isArray(element.items) ? (element.items as unknown[]) : [];
			const style = styleAttr({
				...box,
				"font-family": `${(font.family as string) ?? "Arial"}, sans-serif`,
				"font-size": `${num(font.size) ?? 18}px`,
				color: (font.color as string) ?? "#111827",
				"line-height": num(font.line_height) ?? 1.15,
				margin: 0,
				"padding-left": "1.2em",
				overflow: "hidden",
			});
			const itemsHtml = items.map((runs) => `<li>${renderRuns(runs)}</li>`).join("");
			return `<ul data-leaf="${id}" style="${style}">${itemsHtml}</ul>`;
		}

		if (type === "image") {
			const rotation = num(element.rotation);
			if (rotation) hasUnsupportedContent = true;
			const id = nextId();
			leaves.push({ id, kind: "image", element });
			const src = typeof element.data === "string" ? element.data : "";
			const fitRaw = element.fit;
			const fit = fitRaw === "fill" ? "fill" : fitRaw === "contain" ? "contain" : "cover";
			const style = styleAttr({ ...box, overflow: "hidden", background: "#e5e7eb" });
			const imgStyle = styleAttr({ width: "100%", height: "100%", "object-fit": fit, display: "block" });
			return `<div data-leaf="${id}" style="${style}">${src ? `<img src="${escAttr(src)}" style="${imgStyle}" />` : ""}</div>`;
		}

		// --- structural (non-leaf) types ---------------------------------------
		if (type === "container") {
			const alignment = asRecord(element.alignment) ?? {};
			const padding = asRecord(element.padding) ?? {};
			const fill = asRecord(element.fill)?.color;
			const stroke = element.stroke;
			if (fill || stroke) hasUnsupportedContent = true; // filled/stroked container -> not a native autoshape candidate in v1
			const justify = alignment.horizontal === "center" ? "center" : alignment.horizontal === "right" ? "flex-end" : "flex-start";
			const alignItems = alignment.vertical === "middle" ? "center" : alignment.vertical === "bottom" ? "flex-end" : "flex-start";
			const style = styleAttr({
				...box,
				display: "flex",
				"justify-content": justify,
				"align-items": alignItems,
				"padding-top": num(padding.top) ? `${num(padding.top)}px` : undefined,
				"padding-right": num(padding.right) ? `${num(padding.right)}px` : undefined,
				"padding-bottom": num(padding.bottom) ? `${num(padding.bottom)}px` : undefined,
				"padding-left": num(padding.left) ? `${num(padding.left)}px` : undefined,
			});
			const child = asRecord(element.child);
			return `<div style="${style}">${child ? renderElement(child, false) : ""}</div>`;
		}

		if (type === "flex" || type === "grid") {
			const padding = asRecord(element.padding) ?? {};
			const gap = num(element.gap);
			const columnGap = num(element.column_gap) ?? gap ?? undefined;
			const rowGap = num(element.row_gap) ?? gap ?? undefined;
			const children = Array.isArray(element.children) ? (element.children as unknown[]).filter((c): c is Record<string, unknown> => !!asRecord(c)) : [];

			let display: Record<string, string | number | undefined>;
			if (type === "flex") {
				const direction = element.direction === "row" ? "row" : "column";
				display = {
					display: "flex",
					"flex-direction": direction,
					"flex-wrap": element.wrap === true ? "wrap" : "nowrap",
					"align-items": cssAlign(element.align_items),
					"justify-content": cssJustify(element.justify_content),
					"row-gap": rowGap != null ? `${rowGap}px` : undefined,
					"column-gap": columnGap != null ? `${columnGap}px` : undefined,
				};
			} else {
				const columns = num(element.columns) ?? 1;
				const rows = num(element.rows);
				display = {
					display: "grid",
					"grid-template-columns": `repeat(${columns}, 1fr)`,
					"grid-template-rows": rows != null ? `repeat(${rows}, 1fr)` : undefined,
					"align-items": cssAlign(element.align_items),
					"justify-items": cssAlign(element.justify_items),
					"row-gap": rowGap != null ? `${rowGap}px` : undefined,
					"column-gap": columnGap != null ? `${columnGap}px` : undefined,
				};
			}
			const style = styleAttr({
				...box,
				...display,
				"padding-top": num(padding.top) ? `${num(padding.top)}px` : undefined,
				"padding-right": num(padding.right) ? `${num(padding.right)}px` : undefined,
				"padding-bottom": num(padding.bottom) ? `${num(padding.bottom)}px` : undefined,
				"padding-left": num(padding.left) ? `${num(padding.left)}px` : undefined,
			});
			const childrenHtml = children.map((c) => renderElement(c, true)).join("");
			return `<div style="${style}">${childrenHtml}</div>`;
		}

		if (type === "group") {
			const children = Array.isArray(element.children) ? (element.children as unknown[]).filter((c): c is Record<string, unknown> => !!asRecord(c)) : [];
			const style = styleAttr({ ...box, position: box.position ?? "relative" });
			const childrenHtml = children.map((c) => renderElement(c, false)).join("");
			return `<div style="${style}">${childrenHtml}</div>`;
		}

		if (type === "vector") {
			const points = Array.isArray(element.points)
				? (element.points as unknown[])
						.map((p) => asRecord(p))
						.filter((p): p is Record<string, unknown> => !!p)
						.map((p) => ({ x: num(p.x) ?? 0, y: num(p.y) ?? 0 }))
				: [];
			const fill = asRecord(element.fill)?.color;
			const stroke = element.stroke;
			const rotation = num(element.rotation);
			const isRect = element.shape !== "ellipse" && isAxisAlignedRect(points) && !stroke && !rotation && typeof fill === "string";
			if (!isRect) {
				hasUnsupportedContent = true;
				return "";
			}
			const rectBox = rectBoxFromPoints(points);
			const id = nextId();
			leaves.push({ id, kind: "rect", element: { ...element, position: { x: rectBox.x, y: rectBox.y }, size: { width: rectBox.width, height: rectBox.height } } });
			const style = styleAttr({
				position: "absolute",
				left: `${rectBox.x}px`,
				top: `${rectBox.y}px`,
				width: `${rectBox.width}px`,
				height: `${rectBox.height}px`,
				background: fill,
			});
			return `<div data-leaf="${id}" style="${style}"></div>`;
		}

		// chart / table / svg / infographic / anything else -> unsupported
		hasUnsupportedContent = true;
		return "";
	}

	const components = Array.isArray(ui.components) ? (ui.components as unknown[]) : [];
	const componentsHtml = components
		.map((c) => {
			const comp = asRecord(c);
			if (!comp) return "";
			const position = asRecord(comp.position);
			const x = num(position?.x) ?? 0;
			const y = num(position?.y) ?? 0;
			const elements = Array.isArray(comp.elements) ? (comp.elements as unknown[]) : [];
			const inner = elements
				.map((el) => {
					const record = asRecord(el);
					return record ? renderElement(record, false) : "";
				})
				.join("");
			return `<div style="position:absolute; left:${x}px; top:${y}px;">${inner}</div>`;
		})
		.join("\n");

	const html = `<!doctype html><html><head><meta charset="utf-8" /><style>
		* { box-sizing: border-box; margin: 0; padding: 0; }
		html, body { width: ${STAGE_WIDTH}px; height: ${STAGE_HEIGHT}px; overflow: hidden; }
		body { position: relative; background: #ffffff; font-family: Arial, sans-serif; }
	</style></head><body>${componentsHtml}</body></html>`;

	return { html, leaves, hasUnsupportedContent };
}
