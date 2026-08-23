/**
 * Web search providers for presentation grounding.
 * Parity feature: port of presenton's utils/web_search.py + utils/llm_calls/generate_web_search_query.py
 *
 * Supported external providers: Tavily, Exa, Brave, Serper, SearXNG.
 * Native (model-tool-based) search is deferred — requires per-provider tool-calling support.
 */

export type WebSearchProvider = "auto" | "native" | "tavily" | "exa" | "brave" | "serper" | "searxng";

export interface WebSearchResult {
  title: string;
  url?: string;
  snippet: string;
}

const MAX_RESULTS = 5;

/** Build a simple, query-like string from content + instructions without calling the LLM. */
function buildWebSearchQuery(content: string, instructions?: string | null): string {
  // Take first 200 chars of content, strip markdown headers, combine with instruction hint
  const stripped = content
    .replace(/#{1,6}\s*/g, "")
    .replace(/\*\*|__|\*|_/g, "")
    .trim()
    .slice(0, 200);
  const base = stripped.split(/[\n.!?]/)[0].trim().slice(0, 120);
  const hint = instructions?.trim().slice(0, 80) ?? "";
  return hint ? `${base} ${hint}`.trim().slice(0, 200) : base;
}

/** Generate a search query via LLM — short, ≤12 words, factual. */
async function generateWebSearchQuery(
  deps: { modelRuntime: any; modelRegistry: any },
  content: string,
  provider: string,
  model: string,
  instructions?: string | null,
): Promise<string> {
  const found = deps.modelRegistry.find(provider, model);
  if (!found) return buildWebSearchQuery(content, instructions);

  const systemPrompt =
    "Generate a concise web search query (maximum 12 words) that finds authoritative, current, factual information about the given presentation topic. " +
    "Return ONLY a JSON object: {\"query\": \"<your query>\"}. No other text.";
  const userPrompt =
    `Topic: ${content.slice(0, 400)}` +
    (instructions ? `\nInstructions context: ${instructions.slice(0, 200)}` : "");

  try {
    const msg = await deps.modelRuntime.completeSimple(found, {
      systemPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
    });
    const text = extractText(msg);
    if (!text.trim()) return buildWebSearchQuery(content, instructions);
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;
    const q = typeof parsed.query === "string" ? parsed.query.trim() : "";
    return q || buildWebSearchQuery(content, instructions);
  } catch {
    return buildWebSearchQuery(content, instructions);
  }
}

function extractText(msg: unknown): string {
  if (typeof msg !== "object" || msg === null) return "";
  const content = (msg as any).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => typeof b === "object" && b !== null && (b as any).type === "text")
    .map((b) => (b as any).text)
    .join("");
}

function formatResults(results: WebSearchResult[]): string {
  if (!results.length) return "";
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`)
    .join("\n\n");
}

async function searchTavily(query: string, apiKey: string): Promise<WebSearchResult[]> {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: MAX_RESULTS, search_depth: "basic" }),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as any;
  return ((data.results ?? []) as any[]).slice(0, MAX_RESULTS).map((r: any) => ({
    title: String(r.title ?? ""),
    url: r.url,
    snippet: String(r.content ?? r.snippet ?? ""),
  }));
}

async function searchExa(query: string, apiKey: string): Promise<WebSearchResult[]> {
  const resp = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query, num_results: MAX_RESULTS, type: "neural" }),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as any;
  return ((data.results ?? []) as any[]).slice(0, MAX_RESULTS).map((r: any) => ({
    title: String(r.title ?? ""),
    url: r.url,
    snippet: String(r.text ?? r.snippet ?? r.highlights?.[0] ?? ""),
  }));
}

async function searchBrave(query: string, apiKey: string): Promise<WebSearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
  const resp = await fetch(url, { headers: { "Accept": "application/json", "X-Subscription-Token": apiKey } });
  if (!resp.ok) return [];
  const data = (await resp.json()) as any;
  return ((data.web?.results ?? []) as any[]).slice(0, MAX_RESULTS).map((r: any) => ({
    title: String(r.title ?? ""),
    url: r.url,
    snippet: String(r.description ?? ""),
  }));
}

async function searchSerper(query: string, apiKey: string): Promise<WebSearchResult[]> {
  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ q: query, num: MAX_RESULTS }),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as any;
  return ((data.organic ?? []) as any[]).slice(0, MAX_RESULTS).map((r: any) => ({
    title: String(r.title ?? ""),
    url: r.link,
    snippet: String(r.snippet ?? ""),
  }));
}

async function searchSearxng(query: string, baseUrl: string): Promise<WebSearchResult[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`;
  const resp = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!resp.ok) return [];
  const data = (await resp.json()) as any;
  return ((data.results ?? []) as any[]).slice(0, MAX_RESULTS).map((r: any) => ({
    title: String(r.title ?? ""),
    url: r.url,
    snippet: String(r.content ?? ""),
  }));
}

/** Resolve which external provider to actually use when providerName is "auto". */
function resolveAutoProvider(): WebSearchProvider | null {
  if (process.env.TAVILY_API_KEY) return "tavily";
  if (process.env.EXA_API_KEY) return "exa";
  if (process.env.BRAVE_SEARCH_API_KEY) return "brave";
  if (process.env.SERPER_API_KEY) return "serper";
  if (process.env.SEARXNG_BASE_URL) return "searxng";
  return null;
}

/** Fetch web search results and format them as a context string. */
async function getWebSearchContext(query: string, providerName: WebSearchProvider): Promise<string> {
  let results: WebSearchResult[] = [];

  try {
    const resolved: WebSearchProvider = providerName === "auto" ? (resolveAutoProvider() ?? "tavily") : providerName;
    if (resolved === "native") return ""; // native is handled at model-call level

    switch (resolved) {
      case "tavily":
        results = await searchTavily(query, process.env.TAVILY_API_KEY ?? "");
        break;
      case "exa":
        results = await searchExa(query, process.env.EXA_API_KEY ?? "");
        break;
      case "brave":
        results = await searchBrave(query, process.env.BRAVE_SEARCH_API_KEY ?? "");
        break;
      case "serper":
        results = await searchSerper(query, process.env.SERPER_API_KEY ?? "");
        break;
      case "searxng": {
        const baseUrl = process.env.SEARXNG_BASE_URL;
        if (!baseUrl) return "";
        results = await searchSearxng(query, baseUrl);
        break;
      }
      default:
        return "";
    }
  } catch {
    return "";
  }

  return formatResults(results);
}

/** Entry point: given content + opts, return a context string for outline generation. */
export async function buildWebSearchAdditionalContext(
  deps: { modelRuntime: any; modelRegistry: any },
  content: string,
  provider: string,
  model: string,
  webSearchProvider: WebSearchProvider = "auto",
  instructions?: string | null,
): Promise<string> {
  if (webSearchProvider === "native") return ""; // model handles it natively

  const query = await generateWebSearchQuery(deps, content, provider, model, instructions);
  if (!query.trim()) return "";

  return getWebSearchContext(query, webSearchProvider);
}
