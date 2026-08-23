/**
 * Derives a template.json `merged_components[]` array from a set of
 * `layouts[]`, in plain code with no model call.
 *
 * merged_components is NOT consumed by this codebase's renderer or
 * content-schema deriver (template-binding.ts / template-schema.ts both read
 * only `layouts[]` — confirmed by a repo-wide grep turning up zero
 * consumers). It's included in Imported Template output purely for
 * structural parity with Preset Templates, in case something starts
 * consuming it later — see docs/adr/0001-imported-template-full-schema-parity.md
 * for why this replaced an originally-planned LLM clustering pass.
 */
import type { SlideLayout, SlideComponent } from "./template-vision-generation.js";

export interface MergedComponent {
	id: string;
	description: string;
	variants: SlideComponent[];
}

/** Group every component across all layouts by id; each occurrence becomes a variant. */
export function deriveMergedComponents(layouts: SlideLayout[]): MergedComponent[] {
	const byId = new Map<string, MergedComponent>();
	for (const layout of layouts) {
		for (const component of layout.components) {
			const existing = byId.get(component.id);
			if (existing) {
				existing.variants.push(component);
			} else {
				byId.set(component.id, { id: component.id, description: component.description, variants: [component] });
			}
		}
	}
	return [...byId.values()];
}
