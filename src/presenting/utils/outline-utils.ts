/**
 * Outline title extraction and TOC helpers.
 * Port of presenting/engine/services/outline_utils.py and
 * presenton's utils/outline_utils.py (TOC slice).
 */
import type { PresentationOutlineModel, SlideOutlineModel, PresentationStructureModel } from "./models.js";

export function getPresentationTitleFromOutline(outline: PresentationOutlineModel): string {
  if (!outline.slides.length) return "Untitled Presentation";
  let text = outline.slides[0].content ?? "";
  if (/^\s*#{1,6}\s*Page\s+\d+\b/.test(text)) text = text.replace(/^\s*#{1,6}\s*Page\s+\d+\b[\s,:\-]*/u, "");
  return text.slice(0, 100).replace(/[#/\\\n]/g, " ").trim() || "Untitled Presentation";
}

export function getNoOfOutlinesToGenerateForNSlides(opts: { n_slides: number; toc: boolean; title_slide: boolean }): number {
  if (opts.toc) {
    const n1 = Math.ceil(((opts.n_slides - 1) / 10) * (opts.title_slide ? 1 : 0) + ((opts.n_slides) / 10) * (opts.title_slide ? 0 : 1));
    // simplified: n_toc_1 = ceil((n_slides-1)/10) if title_slide else ceil(n_slides/10)
    const nToc1 = Math.ceil((opts.title_slide ? opts.n_slides - 1 : opts.n_slides) / 10);
    const nToc2 = Math.ceil((opts.n_slides - nToc1) / 10);
    return opts.n_slides - nToc2;
  }
  return opts.n_slides;
}

export function getNoOfTocRequiredForNOutlines(opts: { n_outlines: number; title_slide: boolean; target_total_slides?: number }): number {
  if (opts.target_total_slides != null) {
    const adj = Math.max(opts.target_total_slides, opts.n_outlines);
    return getTocCountForTotalSlides(adj, opts.title_slide);
  }
  if (opts.n_outlines <= 0) return 0;
  return Math.ceil((opts.title_slide ? opts.n_outlines - 1 : opts.n_outlines) / 10);
}

function getTocCountForTotalSlides(total: number, titleSlide: boolean): number {
  if (total <= 0) return 0;
  const firstPass = Math.ceil((titleSlide ? total - 1 : total) / 10);
  return Math.ceil((total - firstPass) / 10);
}

function extractOutlineTitle(content: string): string {
  const headingMatch = content.match(/^\s{0,3}#+\s*(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();
  const sentenceMatch = content.trim().match(/^([^.?!]+?[.?!])/s);
  if (sentenceMatch) return sentenceMatch[1].trim();
  for (const line of content.split("\n")) { const t = line.trim(); if (t) return t; }
  return "Slide";
}

function splitOutlinesEvenly(outlines: SlideOutlineModel[], nSections: number): SlideOutlineModel[][] {
  if (nSections <= 0 || !outlines.length) return [];
  const total = outlines.length;
  const n = Math.max(1, nSections);
  const baseSize = Math.floor(total / n);
  const remainder = total % n;
  const sections: SlideOutlineModel[][] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const size = baseSize + (i < remainder ? 1 : 0);
    sections.push(outlines.slice(start, start + size));
    start += size;
  }
  return sections;
}

export function getPresentationOutlineModelWithToc(opts: { outline: PresentationOutlineModel; n_toc_slides: number; title_slide: boolean }): PresentationOutlineModel {
  if (opts.n_toc_slides <= 0) return opts.outline;
  const slides = [...opts.outline.slides.map((s) => ({ ...s }))];
  const insertionIndex = opts.title_slide ? 1 : 0;
  const outlinesForToc = slides.slice(insertionIndex);
  if (!outlinesForToc.length) return { slides };
  const sections = splitOutlinesEvenly(outlinesForToc, opts.n_toc_slides);
  if (!sections.length) return { slides };

  const tocSlides: SlideOutlineModel[] = [];
  let globalOutlineIndex = 0;
  for (const section of sections) {
    const lines = ["## Table of Contents", ""];
    const totalTocSlides = sections.length;
    const outlinesBefore = opts.title_slide ? 1 : 0;
    for (const outline of section) {
      const title = extractOutlineTitle(outline.content);
      const pageNum = outlinesBefore + totalTocSlides + globalOutlineIndex + 1;
      lines.push(`- Page number: ${pageNum}, Title: ${title}`);
      globalOutlineIndex++;
    }
    tocSlides.push({ content: lines.filter((l) => l !== undefined).join("\n").trim() });
  }

  for (let i = 0; i < tocSlides.length; i++) slides.splice(insertionIndex + i, 0, tocSlides[i]);
  return { slides };
}

export function insertTocLayouts(structure: PresentationStructureModel, nTocSlides: number, includeTitleSlide: boolean, tocSlideLayoutIndex: number): void {
  if (nTocSlides <= 0 || tocSlideLayoutIndex === -1) return;
  const insertionIndex = includeTitleSlide ? 1 : 0;
  for (let i = 0; i < nTocSlides; i++) structure.slides.splice(insertionIndex + i, 0, tocSlideLayoutIndex);
}
