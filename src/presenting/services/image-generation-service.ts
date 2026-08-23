/**
 * Multi-provider image generation: OpenAI (DALL-E 3, GPT-Image-1.5), Google
 * (Gemini Flash / Nanobanana Pro), Open WebUI, OpenAI-compatible endpoints,
 * Pexels/Pixabay stock photos.
 *
 * Port of presenting/engine/services/image_generation_service.py — same env
 * var names, same provider selection logic, same graceful-degradation path
 * (when no provider is configured, returns a placeholder marker).
 *
 * ComfyUI: deliberately not ported (niche, self-hosted workflow-graph engine).
 * A clear error is thrown if comfyui is selected.
 */

import { writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  isImageGenerationDisabled,
  isPixabaySelected,
  isPexelsSelected,
  isGeminiFlashSelected,
  isNanobananaProSelected,
  isDalle3Selected,
  isGptImage15Selected,
  isComfyuiSelected,
  isOpenWebuiSelected,
  isOpenaiCompatibleSelected,
  isStockProviderSelected,
} from "../utils/image-provider.js";
import { type ImagePrompt, imagePromptText, type ImageAsset } from "../utils/models.js";
import { getImagesDirectory } from "../utils/asset-directory-utils.js";

const PLACEHOLDER_IMAGE_PATH = "placeholder://image";

function isParallelImageGenerationEnabled(): boolean {
  const value = process.env.ENABLE_PARALLEL_IMAGE_GENERATION ?? "true";
  return value.toLowerCase() !== "false" && value !== "0" && value.toLowerCase() !== "no";
}

type ImageGenFunc = (prompt: string, outputDir: string) => Promise<string>;
type StockGenFunc = (prompt: string) => Promise<string>;

export class ImageGenerationService {
  private outputDirectory: string;
  private disabled: boolean;
  private imageGenFunc: ImageGenFunc | StockGenFunc | null;
  private lock = false;
  private lockQueue: Array<() => void> = [];

  constructor(outputDirectory?: string) {
    this.outputDirectory = outputDirectory ?? getImagesDirectory();
    this.disabled = isImageGenerationDisabled();
    this.imageGenFunc = this.getImageGenFunc();
  }

  private getImageGenFunc(): ImageGenFunc | StockGenFunc | null {
    if (this.disabled) return null;
    if (isPixabaySelected()) return (p: string) => this.getImageFromPixabay(p);
    if (isPexelsSelected()) return (p: string) => this.getImageFromPexels(p);
    if (isGeminiFlashSelected()) return (p, d) => this.generateImageGeminiFlash(p, d);
    if (isNanobananaProSelected()) return (p, d) => this.generateImageNanabananaPro(p, d);
    if (isDalle3Selected()) return (p, d) => this.generateImageDalle3(p, d);
    if (isGptImage15Selected()) return (p, d) => this.generateImageGptImage15(p, d);
    if (isComfyuiSelected()) return () => Promise.reject(new Error("ComfyUI not ported — set a different IMAGE_PROVIDER"));
    if (isOpenWebuiSelected()) return (p, d) => this.generateImageOpenWebui(p, d);
    if (isOpenaiCompatibleSelected()) return (p, d) => this.generateImageOpenaiCompatible(p, d);
    return null;
  }

  async generateImage(prompt: ImagePrompt): Promise<string | ImageAsset> {
    if (this.disabled || !this.imageGenFunc) return PLACEHOLDER_IMAGE_PATH;

    const text = imagePromptText(prompt, !isStockProviderSelected());

    if (isParallelImageGenerationEnabled()) {
      return this.callImageProvider(text);
    }

    // Serialize when parallel is disabled
    return new Promise((resolve, reject) => {
      const run = async () => {
        try {
          resolve(await this.callImageProvider(text));
        } catch (e) {
          reject(e);
        } finally {
          const next = this.lockQueue.shift();
          if (next) next(); else this.lock = false;
        }
      };
      if (!this.lock) {
        this.lock = true;
        run();
      } else {
        this.lockQueue.push(run);
      }
    });
  }

  private async callImageProvider(prompt: string): Promise<string | ImageAsset> {
    if (!this.imageGenFunc) return PLACEHOLDER_IMAGE_PATH;

    let imagePath: string;
    if (isStockProviderSelected()) {
      imagePath = await (this.imageGenFunc as StockGenFunc)(prompt);
    } else {
      imagePath = await (this.imageGenFunc as ImageGenFunc)(prompt, this.outputDirectory);
    }

    if (!imagePath) throw new Error("Image provider returned empty path");
    if (imagePath.startsWith("http")) return imagePath;

    const { existsSync } = await import("fs");
    if (existsSync(imagePath)) {
      return { path: imagePath, is_uploaded: false, extras: {} };
    }
    throw new Error(`Image not found at ${imagePath}`);
  }

  // ── OpenAI (shared) ──────────────────────────────────────────────────────

  private async generateImageOpenai(
    prompt: string,
    outputDirectory: string,
    model: string,
    quality: string,
  ): Promise<string> {
    const { default: OpenAI, toFile } = await import("openai");
    const client = new OpenAI();

    if (model === "dall-e-3") {
      const result = await client.images.generate({
        model,
        prompt,
        n: 1,
        quality: quality as "standard" | "hd",
        response_format: "b64_json",
        size: "1024x1024",
      });
      const b64 = result.data?.[0]?.b64_json;
      if (!b64) throw new Error("OpenAI returned no image data");
      const imagePath = join(outputDirectory, `${randomUUID()}.png`);
      await writeFile(imagePath, Buffer.from(b64, "base64"));
      return imagePath;
    }

    // gpt-image-1.5 does not support b64_json; returns URL
    const result = await (client.images.generate as Function)({
      model,
      prompt,
      n: 1,
      quality,
      size: "1024x1024",
    });
    const item = ((result as any).data ?? result)[0] as any;
    if (item?.b64_json) {
      const imagePath = join(outputDirectory, `${randomUUID()}.png`);
      await writeFile(imagePath, Buffer.from(item.b64_json, "base64"));
      return imagePath;
    }
    if (item?.url) return item.url;
    throw new Error("OpenAI returned no image data");
  }

  private async generateImageDalle3(prompt: string, outputDirectory: string): Promise<string> {
    return this.generateImageOpenai(prompt, outputDirectory, "dall-e-3", process.env.DALL_E_3_QUALITY ?? "standard");
  }

  private async generateImageGptImage15(prompt: string, outputDirectory: string): Promise<string> {
    return this.generateImageOpenai(
      prompt,
      outputDirectory,
      "gpt-image-1.5",
      process.env.GPT_IMAGE_1_5_QUALITY ?? "medium",
    );
  }

  // ── Google Gemini ─────────────────────────────────────────────────────────

  private async generateImageGoogle(prompt: string, outputDirectory: string, model: string): Promise<string> {
    // @ts-ignore — @google/genai is an optional dep; installed by user if Gemini image gen is wanted
    const { GoogleGenAI } = await import("@google/genai");
    const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "" });

    const response = await client.models.generateContent({
      model,
      contents: prompt,
      config: { responseModalities: ["IMAGE"] },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const mimeType = part.inlineData.mimeType ?? "image/png";
        const ext = mimeType.startsWith("image/") ? mimeType.split("/")[1] : "png";
        const imagePath = join(outputDirectory, `${randomUUID()}.${ext}`);
        await writeFile(imagePath, Buffer.from(part.inlineData.data, "base64"));
        return imagePath;
      }
    }
    throw new Error(`No image generated by Google ${model}`);
  }

  private async generateImageGeminiFlash(prompt: string, outputDirectory: string): Promise<string> {
    return this.generateImageGoogle(prompt, outputDirectory, "gemini-2.5-flash-image");
  }

  private async generateImageNanabananaPro(prompt: string, outputDirectory: string): Promise<string> {
    return this.generateImageGoogle(prompt, outputDirectory, "gemini-3-pro-image-preview");
  }

  // ── Open WebUI ────────────────────────────────────────────────────────────

  private async generateImageOpenWebui(prompt: string, outputDirectory: string): Promise<string> {
    const baseUrl = (process.env.OPEN_WEBUI_IMAGE_URL ?? "").replace(/\/$/, "");
    if (!baseUrl) throw new Error("OPEN_WEBUI_IMAGE_URL is not set");
    const apiKey = process.env.OPEN_WEBUI_IMAGE_API_KEY ?? "";

    const url = new URL(baseUrl);
    const origin = `${url.protocol}//${url.host}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const resp = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt, n: 1, size: "1024x1024" }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!resp.ok) throw new Error(`Open WebUI image generation returned ${resp.status}: ${await resp.text()}`);

    const body = await resp.json();
    const items: unknown[] = Array.isArray(body) ? body : (body as any)?.data ?? [];
    if (!items.length) throw new Error("Open WebUI returned empty results");
    const item = items[0] as any;

    const imagePath = join(outputDirectory, `${randomUUID()}.png`);
    if (item.b64_json) {
      await writeFile(imagePath, Buffer.from(item.b64_json, "base64"));
    } else if (item.url) {
      let imageUrl = item.url.startsWith("/") ? origin + item.url : item.url;
      const dlHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      const dl = await fetch(imageUrl, { headers: dlHeaders, signal: AbortSignal.timeout(120_000) });
      if (!dl.ok) throw new Error(`Failed to download image from Open WebUI: ${dl.status}`);
      await writeFile(imagePath, Buffer.from(await dl.arrayBuffer()));
    } else {
      throw new Error("Open WebUI returned no image data");
    }
    return imagePath;
  }

  // ── OpenAI-compatible ────────────────────────────────────────────────────

  private async generateImageOpenaiCompatible(prompt: string, outputDirectory: string): Promise<string> {
    const baseUrl = process.env.OPENAI_COMPAT_IMAGE_BASE_URL;
    const apiKey = process.env.OPENAI_COMPAT_IMAGE_API_KEY;
    const model = process.env.OPENAI_COMPAT_IMAGE_MODEL;
    if (!baseUrl || !apiKey || !model) {
      throw new Error("OPENAI_COMPAT_IMAGE_BASE_URL, OPENAI_COMPAT_IMAGE_API_KEY and OPENAI_COMPAT_IMAGE_MODEL must be set");
    }

    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ baseURL: baseUrl, apiKey });
    const response = await client.images.generate({ model, prompt, n: 1, size: "1024x1024" } as any);
    const item = ((response as any).data?.[0] ?? (response as any)[0]) as any;

    const origin = (() => { const u = new URL(baseUrl); return `${u.protocol}//${u.host}`; })();
    const imagePath = join(outputDirectory, `${randomUUID()}.png`);

    if (item.b64_json) {
      await writeFile(imagePath, Buffer.from(item.b64_json, "base64"));
    } else if (item.url) {
      let imageUrl = item.url.startsWith("/") ? origin + item.url : item.url;
      const reqOrigin = (() => { try { const u = new URL(imageUrl); return `${u.protocol}//${u.host}`; } catch { return ""; } })();
      const headers: Record<string, string> = reqOrigin === origin ? { Authorization: `Bearer ${apiKey}` } : {};
      const dl = await fetch(imageUrl, { headers, signal: AbortSignal.timeout(120_000) });
      if (!dl.ok) throw new Error(`Failed to download image: ${dl.status}`);
      await writeFile(imagePath, Buffer.from(await dl.arrayBuffer()));
    } else {
      throw new Error("OpenAI-compatible provider returned no image data");
    }
    return imagePath;
  }

  // ── Stock providers ───────────────────────────────────────────────────────

  async getImageFromPexels(prompt: string, limit = 1): Promise<string> {
    const apiKey = (process.env.PEXELS_API_KEY ?? "").trim();
    const perPage = Math.max(1, Math.min(limit, 80));
    const url = new URL("https://api.pexels.com/v1/search");
    url.searchParams.set("query", prompt);
    url.searchParams.set("per_page", String(perPage));
    const headers: Record<string, string> = apiKey ? { Authorization: apiKey } : {};
    const resp = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(20_000) });
    if (resp.status === 401 || resp.status === 403) throw new Error("Invalid Pexels API key");
    if (!resp.ok) throw new Error(`Pexels request failed: ${await resp.text()}`);
    const data = await resp.json() as any;
    const urls = (data.photos ?? []).map((p: any) => p?.src?.large).filter(Boolean);
    if (limit <= 1) return urls[0] ?? "";
    return urls.slice(0, limit);
  }

  async getImageFromPixabay(prompt: string, limit = 1): Promise<string> {
    const apiKey = (process.env.PIXABAY_API_KEY ?? "").trim();
    const perPage = Math.max(3, Math.min(limit, 200));
    const url = new URL("https://pixabay.com/api/");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("q", prompt.substring(0, 99));
    url.searchParams.set("image_type", "photo");
    url.searchParams.set("per_page", String(perPage));
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(20_000) });
    if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
      const text = await resp.text();
      throw new Error(`Invalid Pixabay API key: ${text}`);
    }
    if (!resp.ok) throw new Error(`Pixabay request failed: ${await resp.text()}`);
    const data = await resp.json() as any;
    const urls = (data.hits ?? []).map((h: any) => h?.largeImageURL).filter(Boolean);
    if (limit <= 1) return urls[0] ?? "";
    return urls.slice(0, limit);
  }
}

export const IMAGE_GENERATION_SERVICE = new ImageGenerationService();
