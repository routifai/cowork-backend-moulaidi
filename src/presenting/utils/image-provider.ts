/**
 * Image-provider selection from environment variables.
 * Port of presenting/engine/services/image_provider.py — same env var
 * names/values so existing IMAGE_PROVIDER configs carry over unchanged.
 */

export type ImageProvider =
  | "pexels"
  | "pixabay"
  | "gemini_flash"
  | "nanobanana_pro"
  | "dall-e-3"
  | "gpt-image-1.5"
  | "comfyui"
  | "open_webui"
  | "openai_compatible";

export function getSelectedImageProvider(): ImageProvider | null {
  const value = process.env.IMAGE_PROVIDER;
  return value ? (value as ImageProvider) : null;
}

export function isImageGenerationDisabled(): boolean {
  const value = process.env.DISABLE_IMAGE_GENERATION;
  return value?.toLowerCase() === "true" || value === "1";
}

export function isPexelsSelected(): boolean {
  return getSelectedImageProvider() === "pexels";
}

export function isPixabaySelected(): boolean {
  return getSelectedImageProvider() === "pixabay";
}

export function isGeminiFlashSelected(): boolean {
  return getSelectedImageProvider() === "gemini_flash";
}

export function isNanobananaProSelected(): boolean {
  return getSelectedImageProvider() === "nanobanana_pro";
}

export function isDalle3Selected(): boolean {
  return getSelectedImageProvider() === "dall-e-3";
}

export function isGptImage15Selected(): boolean {
  return getSelectedImageProvider() === "gpt-image-1.5";
}

export function isComfyuiSelected(): boolean {
  return getSelectedImageProvider() === "comfyui";
}

export function isOpenWebuiSelected(): boolean {
  return getSelectedImageProvider() === "open_webui";
}

export function isOpenaiCompatibleSelected(): boolean {
  return getSelectedImageProvider() === "openai_compatible";
}

export function isStockProviderSelected(): boolean {
  return isPexelsSelected() || isPixabaySelected();
}
