/**
 * Image-generation failure -> chat-facing warning dict.
 * Port of presenting/engine/services/image_generation_error.py.
 */

export interface ImageGenerationWarning {
  status_code: number;
  detail: string;
  code: string | null;
}

export function imageGenerationWarning(error: Error): ImageGenerationWarning {
  return {
    status_code: 500,
    detail: error.message || "Image generation failed. Please try again or use a different prompt.",
    code: null,
  };
}
