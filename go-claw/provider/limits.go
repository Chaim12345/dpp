package deepseek

import "strings"

// DeepSeek's web API has a hard cap on prompt size. We set this conservatively
// below the true limit so we always have headroom for the response.
const (
	// maxPromptTokens is the estimated input token budget. DeepSeek's V3
	// model advertises a 64K context window; we leave a buffer for the
	// response and server-side overhead. Live testing has shown the
	// web API rejects prompts well above this; tune up if the API ceiling
	// is discovered to be higher.
	maxPromptTokens = 60_000

	// softPromptLimit is where we start warning and proactively compact.
	softPromptLimit = 28_000

	// charsPerToken is a rough heuristic. Real tokenizers vary, but for
	// English + code, ~4 chars/token is a safe floor.
	charsPerToken = 4
)

// EstimateTokens returns a rough character-based token estimate for a string.
func EstimateTokens(s string) int {
	if len(s) == 0 {
		return 0
	}
	return (len(s) + charsPerToken - 1) / charsPerToken
}

// FitToBudget truncates text to fit within maxTokens. If the text already
// fits, it's returned unchanged. Otherwise it's truncated and a marker is
// appended so the model knows content was dropped.
func FitToBudget(text string, maxTokens int) string {
	maxChars := maxTokens * charsPerToken
	if len(text) <= maxChars {
		return text
	}
	// Truncate at a line boundary when possible to keep the result readable.
	cut := maxChars - 80 // leave room for the marker
	if cut < 0 {
		cut = 0
	}
	truncated := text[:cut]
	if nl := strings.LastIndex(truncated, "\n"); nl > cut-200 && nl > 0 {
		truncated = truncated[:nl]
	}
	return truncated + "\n\n[... content truncated to fit context window ...]"
}
