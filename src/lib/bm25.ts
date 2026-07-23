/**
 * Okapi BM25 ranking over a small in-memory corpus (skill name+description
 * text — at most a few hundred documents). Hand-rolled rather than a
 * dependency: the formula is compact and this corpus size doesn't warrant
 * pulling in a search library.
 */

const K1 = 1.5;
const B = 0.75;

export interface Bm25Document {
	id: string;
	text: string;
}

export interface Bm25Result {
	id: string;
	score: number;
}

/**
 * Common English filler words, excluded from both documents and queries.
 * Without this, a query like "make me a PowerPoint presentation" can rank a
 * document matching only "make"/"me"/"a" above one matching the actual
 * subject ("powerpoint"/"presentation") — several weak stopword matches
 * outscoring one strong keyword match. Standard fix for BM25/TF-IDF.
 */
const STOPWORDS = new Set([
	"a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "for",
	"with", "as", "at", "by", "from", "is", "are", "was", "were", "be", "been",
	"being", "it", "its", "this", "that", "these", "those", "i", "you", "he",
	"she", "we", "they", "me", "my", "your", "his", "her", "our", "their",
	"do", "does", "did", "can", "could", "will", "would", "should", "may",
	"might", "must", "have", "has", "had", "not", "no", "so", "up", "out",
	"about", "into", "than", "then", "when", "make", "use", "uses", "used",
	"using", "please",
]);

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/**
 * Rank every document against the query using Okapi BM25. Returns all
 * documents sorted by descending score (including zero-score ones) — the
 * caller decides top-K and any zero-score filtering.
 */
export function rankBm25(query: string, documents: Bm25Document[]): Bm25Result[] {
	const queryTerms = tokenize(query);
	const docTokens = documents.map((doc) => tokenize(doc.text));

	const docCount = documents.length;
	const avgDocLength =
		docCount === 0 ? 0 : docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / docCount;

	// Document frequency per query term: how many documents contain it at least once.
	const docFrequency = new Map<string, number>();
	for (const term of new Set(queryTerms)) {
		let count = 0;
		for (const tokens of docTokens) {
			if (tokens.includes(term)) count++;
		}
		docFrequency.set(term, count);
	}

	const idf = new Map<string, number>();
	for (const [term, n] of docFrequency) {
		// "+1" smoothed IDF variant: stays non-negative even when a term
		// appears in more than half the corpus.
		idf.set(term, Math.log((docCount - n + 0.5) / (n + 0.5) + 1));
	}

	return documents
		.map((doc, i) => {
			const tokens = docTokens[i];
			const docLength = tokens.length;
			let score = 0;
			for (const term of queryTerms) {
				const termIdf = idf.get(term);
				if (!termIdf) continue;
				const termFreq = tokens.filter((t) => t === term).length;
				if (termFreq === 0) continue;
				const numerator = termFreq * (K1 + 1);
				const denominator =
					termFreq + K1 * (1 - B + B * (avgDocLength === 0 ? 0 : docLength / avgDocLength));
				score += termIdf * (numerator / denominator);
			}
			return { id: doc.id, score };
		})
		.sort((a, b) => b.score - a.score);
}
