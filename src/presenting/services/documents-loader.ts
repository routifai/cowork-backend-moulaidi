/**
 * Document text extraction for the Uploaded Template path.
 * Port of presenting/engine/services/documents_loader.py +
 * liteparse_service.py — in-process call to @llamaindex/liteparse
 * instead of a subprocess bridge (we're already in Node, so no subprocess needed).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import { join, extname, basename } from "path";
import { liteparseDir } from "../paths.js";

const execFileAsync = promisify(execFile);

export class DocumentLoadError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = "DocumentLoadError";
    this.statusCode = statusCode;
  }
}

const PDF_EXTENSIONS = new Set([".pdf"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm", ".rtf"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff", ".tif", ".webp"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".odt", ".odp", ".ods"]);

const LITEPARSE_TIMEOUT_MS = 600_000;

function getLiteparseRunnerPath(): string {
  const runner = join(liteparseDir(), "liteparse_runner.mjs");
  if (existsSync(runner)) return runner;
  throw new DocumentLoadError("LiteParse runner not found. Run the presenting vendor sync scripts first.");
}

function getLiteparseNpmRoot(): string {
  return liteparseDir();
}

async function parseWithLiteparse(filePath: string, opts: { ocrLanguage?: string; dpi?: number } = {}): Promise<string> {
  const runnerPath = getLiteparseRunnerPath();
  const npmRoot = getLiteparseNpmRoot();
  const args = [
    runnerPath,
    "--file", filePath,
    "--ocr-enabled", "true",
    "--ocr-language", opts.ocrLanguage ?? "eng",
    "--dpi", String(opts.dpi ?? 120),
    "--num-workers", "1",
    "--python-bridge", "plain",
  ];
  const ocr_server = process.env.LITEPARSE_OCR_SERVER_URL;
  if (ocr_server) args.push("--ocr-server-url", ocr_server);

  try {
    const { stdout, stderr } = await execFileAsync("node", args, {
      cwd: npmRoot,
      timeout: LITEPARSE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.replace(/^\uFEFF/, "");
  } catch (err: any) {
    throw new DocumentLoadError(
      `LiteParse failed for ${basename(filePath)}: ${err.message ?? String(err)}`,
    );
  }
}

function cleanLiteparseText(text: string): string {
  if (!text) return text;
  const s = text.trimStart();
  if (!s.startsWith("{")) return text;
  try {
    const parsed = JSON.parse(s) as Record<string, unknown>;
    if (parsed.ok === true && typeof parsed.text === "string") return parsed.text;
  } catch {}
  // Try to extract text from malformed JSON
  const m = /"text"\s*:\s*"/.exec(s);
  if (m) {
    try {
      // Extract quoted string value after "text":
      const start = m.index + m[0].length;
      let out = "";
      let i = start;
      while (i < s.length) {
        const c = s[i];
        if (c === "\\" && i + 1 < s.length) {
          const e = s[i + 1];
          if (e === '"' || e === "\\") { out += e; i += 2; }
          else if (e === "n") { out += "\n"; i += 2; }
          else if (e === "t") { out += "\t"; i += 2; }
          else if (e === "r") { out += "\r"; i += 2; }
          else if (e === "u" && i + 5 < s.length) {
            try { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); } catch { out += s.slice(i, i + 6); }
            i += 6;
          } else { out += e; i += 2; }
        } else if (c === '"') {
          return out;
        } else { out += c; i++; }
      }
      return out;
    } catch {}
  }
  return text;
}

async function loadTextFile(filePath: string): Promise<string> {
  return readFileSync(filePath, "utf-8");
}

async function loadOfficeDocument(filePath: string, ocrLanguage?: string): Promise<string> {
  return parseWithLiteparse(filePath, { ocrLanguage });
}

export async function extractDocumentText(filePath: string, language?: string | null): Promise<string> {
  if (!existsSync(filePath)) {
    throw new DocumentLoadError(`File not found: ${filePath}`, 404);
  }
  const ext = extname(filePath).toLowerCase();
  const ocrLang = languageToOcrCode(language ?? null);

  let text: string;
  if (PDF_EXTENSIONS.has(ext)) {
    text = await parseWithLiteparse(filePath, { ocrLanguage: ocrLang });
  } else if (TEXT_EXTENSIONS.has(ext)) {
    text = await loadTextFile(filePath);
  } else if (OFFICE_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)) {
    text = await parseWithLiteparse(filePath, { ocrLanguage: ocrLang });
  } else {
    text = await parseWithLiteparse(filePath, { ocrLanguage: ocrLang });
  }

  return cleanLiteparseText(text);
}

function languageToOcrCode(language: string | null): string {
  if (!language) return "eng";
  const map: Record<string, string> = {
    en: "eng", english: "eng",
    fr: "fra", french: "fra",
    de: "deu", german: "deu",
    es: "spa", spanish: "spa",
    it: "ita", italian: "ita",
    pt: "por", portuguese: "por",
    nl: "nld", dutch: "nld",
    ar: "ara", arabic: "ara",
    zh: "chi_sim", chinese: "chi_sim",
    ja: "jpn", japanese: "jpn",
    ko: "kor", korean: "kor",
    ru: "rus", russian: "rus",
    hi: "hin", hindi: "hin",
  };
  const key = language.toLowerCase().split(/[-_]/)[0];
  return map[key] ?? "eng";
}
