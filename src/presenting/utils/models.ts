/**
 * Presentation domain types (Smart-mode subset).
 */
export const MAX_NUMBER_OF_SLIDES = 50;

export interface ImagePrompt {
  prompt: string;
  theme_prompt?: string;
}

export function imagePromptText(p: ImagePrompt, withTheme = true): string {
  const parts = [p.prompt];
  if (withTheme && p.theme_prompt) parts.push(p.theme_prompt);
  return parts.join(", ");
}

export interface ImageAsset {
  path: string;
  is_uploaded: boolean;
  extras?: Record<string, unknown>;
}
