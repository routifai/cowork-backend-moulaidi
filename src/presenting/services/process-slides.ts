/**
 * Resolve image/icon prompts embedded in slide content into real asset URLs.
 *
 * Port of presenting/engine/services/process_slides.py. Uses DictPath helpers
 * to find prompt/query keys at arbitrary nesting depth and replace them with
 * resolved image/icon URLs. Template-asset fields use flat `image_url` /
 * `icon_url`; non-template slides use `__image_url__` / `__icon_url__`.
 */

import { getDictPathsWithKey, getDictAtPath, setDictAtPath, type DictPath } from "../utils/dict-utils.js";
import { normalizeSlideAssetUrl, filesystemImagePathToAppDataUrl } from "../utils/asset-directory-utils.js";
import { normalizeIconWeight, DEFAULT_ICON_WEIGHT } from "../utils/icon-weights.js";
import { imageGenerationWarning, type ImageGenerationWarning } from "../utils/image-generation-error.js";
import { type ImageAsset } from "../utils/models.js";
import { IMAGE_GENERATION_SERVICE } from "./image-generation-service.js";
import { ICON_FINDER_SERVICE } from "./icon-finder-service.js";

const IMAGE_PROMPT_KEYS = ["__image_prompt__", "image_prompt", "prompt"] as const;
const ICON_QUERY_KEYS = ["__icon_query__", "icon_query", "query"] as const;
const TEMPLATE_ASSET_MARKER_KEYS = ["image_url", "icon_url", "image_prompt", "icon_query"];

function usesTemplateAssetFields(slideContent: Record<string, unknown>, slideUi?: unknown): boolean {
  if (slideUi && typeof slideUi === "object") return true;
  if (slideContent && typeof slideContent === "object") {
    for (const key of TEMPLATE_ASSET_MARKER_KEYS) {
      if (getDictPathsWithKey(slideContent, key).length > 0) return true;
    }
  }
  return false;
}

function assetUrlKey(assetType: "image" | "icon", template: boolean): string {
  if (assetType === "image") return template ? "image_url" : "__image_url__";
  return template ? "icon_url" : "__icon_url__";
}

function setAssetUrl(asset: Record<string, unknown>, assetType: "image" | "icon", url: string, template: boolean): void {
  const key = assetUrlKey(assetType, template);
  asset[key] = url;
  if (template) delete asset[`__${assetType}_url__`];
}

function getAssetUrl(asset: Record<string, unknown>, assetType: "image" | "icon", template: boolean): string | null {
  const primary = assetUrlKey(assetType, template);
  const secondary = `__${assetType}_url__`;
  const keys = template ? [primary, secondary] : [primary];
  for (const k of keys) {
    const v = asset[k];
    if (typeof v === "string") return v;
  }
  return null;
}

function dictPathsWithAnyKey(content: Record<string, unknown>, keys: readonly string[]): DictPath[] {
  const seen = new Set<string>();
  const result: DictPath[] = [];
  for (const key of keys) {
    for (const path of getDictPathsWithKey(content, key)) {
      const sig = JSON.stringify(path);
      if (!seen.has(sig)) { seen.add(sig); result.push(path); }
    }
  }
  return result;
}

function promptValue(parent: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = parent[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function assetDictsWithPrompt(
  content: Record<string, unknown>,
  keys: readonly string[],
): Array<[DictPath, Record<string, unknown>, string]> {
  const results: Array<[DictPath, Record<string, unknown>, string]> = [];
  for (const path of dictPathsWithAnyKey(content, keys)) {
    const parent = getDictAtPath(content, path) as Record<string, unknown>;
    if (!parent || typeof parent !== "object") continue;
    const prompt = promptValue(parent, keys);
    if (prompt !== null) results.push([path, parent, prompt]);
  }
  return results;
}

export interface SlideForProcessing {
  content: Record<string, unknown>;
  ui?: unknown;
}

export async function processSlideAndFetchAssets(
  slide: SlideForProcessing,
  outlineImageUrls?: string[],
  iconWeight = DEFAULT_ICON_WEIGHT,
  allowImageFallback = false,
  imageWarnings?: ImageGenerationWarning[],
): Promise<ImageAsset[]> {
  const resolvedIconWeight = normalizeIconWeight(iconWeight);
  const template = usesTemplateAssetFields(slide.content, slide.ui);

  const imageAssets = assetDictsWithPrompt(slide.content, IMAGE_PROMPT_KEYS);
  const iconAssets = assetDictsWithPrompt(slide.content, ICON_QUERY_KEYS);

  type Task =
    | { kind: "image"; path: DictPath; prompt: string; skipIndex: number | null }
    | { kind: "icon"; path: DictPath; query: string };

  const tasks: Task[] = [];

  for (let i = 0; i < imageAssets.length; i++) {
    const [imagePath, imageParent, imagePrompt] = imageAssets[i];
    if (outlineImageUrls && i < outlineImageUrls.length && outlineImageUrls[i]) {
      setAssetUrl(imageParent, "image", normalizeSlideAssetUrl(outlineImageUrls[i]), template);
      setDictAtPath(slide.content, imagePath, imageParent);
      continue;
    }
    tasks.push({ kind: "image", path: imagePath, prompt: imagePrompt, skipIndex: null });
  }

  for (const [iconPath, , iconQuery] of iconAssets) {
    tasks.push({ kind: "icon", path: iconPath, query: iconQuery });
  }

  const results = await Promise.all(
    tasks.map((task) => {
      if (task.kind === "image") {
        const p = IMAGE_GENERATION_SERVICE.generateImage({ prompt: task.prompt });
        return allowImageFallback ? p.catch((e: unknown) => e) : p;
      }
      return Promise.resolve(ICON_FINDER_SERVICE.searchIcons(task.query, 1, resolvedIconWeight));
    }),
  );

  const returnAssets: ImageAsset[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const result = results[i];

    if (task.kind === "image") {
      const imageDict = getDictAtPath(slide.content, task.path) as Record<string, unknown>;
      if (result instanceof Error || (typeof result === "object" && result !== null && "stack" in result && "message" in result)) {
        if (!allowImageFallback) throw result;
        setAssetUrl(imageDict, "image", normalizeSlideAssetUrl("/static/images/placeholder.jpg"), template);
        if (imageWarnings && result instanceof Error) imageWarnings.push(imageGenerationWarning(result));
        setDictAtPath(slide.content, task.path, imageDict);
        continue;
      }
      if (typeof result === "object" && result !== null && "path" in result) {
        returnAssets.push(result as ImageAsset);
        setAssetUrl(imageDict, "image", filesystemImagePathToAppDataUrl((result as ImageAsset).path), template);
      } else {
        setAssetUrl(imageDict, "image", normalizeSlideAssetUrl(result as string), template);
      }
      setDictAtPath(slide.content, task.path, imageDict);
      continue;
    }

    // icon
    if (result instanceof Error) throw result;
    const iconDict = getDictAtPath(slide.content, task.path) as Record<string, unknown>;
    const iconList = result as string[];
    const iconUrl = iconList.length > 0 ? normalizeSlideAssetUrl(iconList[0]) : normalizeSlideAssetUrl("/static/icons/placeholder.svg");
    setAssetUrl(iconDict, "icon", iconUrl, template);
    setDictAtPath(slide.content, task.path, iconDict);
  }

  return returnAssets;
}

export async function processOldAndNewSlidesAndFetchAssets(
  oldContent: Record<string, unknown>,
  newContent: Record<string, unknown>,
  iconWeight = DEFAULT_ICON_WEIGHT,
  useTemplateAssetFields = false,
  allowImageFallback = false,
  imageWarnings?: ImageGenerationWarning[],
): Promise<ImageAsset[]> {
  const resolvedIconWeight = normalizeIconWeight(iconWeight);
  const oldImageAssets = assetDictsWithPrompt(oldContent, IMAGE_PROMPT_KEYS);
  const oldIconAssets = assetDictsWithPrompt(oldContent, ICON_QUERY_KEYS);
  const newImageAssets = assetDictsWithPrompt(newContent, IMAGE_PROMPT_KEYS);
  const newIconAssets = assetDictsWithPrompt(newContent, ICON_QUERY_KEYS);

  const oldImageUrls = new Map<string, string>();
  for (const [, asset, prompt] of oldImageAssets) {
    const url = getAssetUrl(asset, "image", useTemplateAssetFields);
    if (url) oldImageUrls.set(prompt, url);
  }
  const oldIconUrls = new Map<string, string>();
  for (const [, asset, query] of oldIconAssets) {
    const url = getAssetUrl(asset, "icon", useTemplateAssetFields);
    if (url) oldIconUrls.set(query, url);
  }

  const imageFetchTargets: Array<Record<string, unknown>> = [];
  const imageFetchTasks: Promise<unknown>[] = [];
  for (const [, newImage, imagePrompt] of newImageAssets) {
    if (oldImageUrls.has(imagePrompt)) {
      setAssetUrl(newImage, "image", oldImageUrls.get(imagePrompt)!, useTemplateAssetFields);
      continue;
    }
    const p = IMAGE_GENERATION_SERVICE.generateImage({ prompt: imagePrompt });
    imageFetchTasks.push(allowImageFallback ? p.catch((e: unknown) => e) : p);
    imageFetchTargets.push(newImage);
  }

  const iconFetchTargets: Array<Record<string, unknown>> = [];
  const iconFetchTasks: Promise<string[]>[] = [];
  for (const [, newIcon, iconQuery] of newIconAssets) {
    if (oldIconUrls.has(iconQuery)) {
      setAssetUrl(newIcon, "icon", oldIconUrls.get(iconQuery)!, useTemplateAssetFields);
      continue;
    }
    iconFetchTasks.push(Promise.resolve(ICON_FINDER_SERVICE.searchIcons(iconQuery, 1, resolvedIconWeight)));
    iconFetchTargets.push(newIcon);
  }

  const [newImages, newIcons] = await Promise.all([
    Promise.all(imageFetchTasks),
    Promise.all(iconFetchTasks),
  ]);

  const newAssets: ImageAsset[] = [];

  for (let i = 0; i < imageFetchTargets.length; i++) {
    const target = imageFetchTargets[i];
    const fetched = newImages[i];
    let imageUrl: string;
    if (fetched instanceof Error || (typeof fetched === "object" && fetched !== null && "stack" in fetched && "message" in fetched)) {
      if (!allowImageFallback) throw fetched;
      imageUrl = normalizeSlideAssetUrl("/static/images/placeholder.jpg");
      if (imageWarnings && fetched instanceof Error) imageWarnings.push(imageGenerationWarning(fetched));
    } else if (typeof fetched === "object" && fetched !== null && "path" in fetched) {
      newAssets.push(fetched as ImageAsset);
      imageUrl = filesystemImagePathToAppDataUrl((fetched as ImageAsset).path);
    } else {
      imageUrl = normalizeSlideAssetUrl(fetched as string);
    }
    setAssetUrl(target, "image", imageUrl, useTemplateAssetFields);
  }

  for (let i = 0; i < iconFetchTargets.length; i++) {
    const iconList = newIcons[i];
    const iconUrl = iconList.length > 0 ? normalizeSlideAssetUrl(iconList[0]) : normalizeSlideAssetUrl("/static/icons/placeholder.svg");
    setAssetUrl(iconFetchTargets[i], "icon", iconUrl, useTemplateAssetFields);
  }

  for (const [path, asset] of newImageAssets) setDictAtPath(newContent, path, asset);
  for (const [path, asset] of newIconAssets) setDictAtPath(newContent, path, asset);

  return newAssets;
}

export function processSlideAddPlaceholderAssets(slide: SlideForProcessing): void {
  const template = usesTemplateAssetFields(slide.content, slide.ui);
  const imagePaths = dictPathsWithAnyKey(slide.content, IMAGE_PROMPT_KEYS);
  const iconPaths = dictPathsWithAnyKey(slide.content, ICON_QUERY_KEYS);

  for (const imagePath of imagePaths) {
    const imageDict = getDictAtPath(slide.content, imagePath) as Record<string, unknown>;
    setAssetUrl(imageDict, "image", normalizeSlideAssetUrl("/static/images/placeholder.jpg"), template);
    setDictAtPath(slide.content, imagePath, imageDict);
  }
  for (const iconPath of iconPaths) {
    const iconDict = getDictAtPath(slide.content, iconPath) as Record<string, unknown>;
    setAssetUrl(iconDict, "icon", normalizeSlideAssetUrl("/static/icons/placeholder.svg"), template);
    setDictAtPath(slide.content, iconPath, iconDict);
  }
}
