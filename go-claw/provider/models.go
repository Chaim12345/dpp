package deepseek

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// ModelSpec captures the three orthogonal knobs the DeepSeek web API exposes
// for a chat completion: the base model_type (default / expert / vision) plus
// the thinking and search flags. The web API publishes a per-variant
// input_character_limit on /api/v0/client/settings?scope=model — see
// ModelConfig and FetchModelSettings.
type ModelSpec struct {
	ModelType       string // "default", "expert", "vision"
	ThinkingEnabled bool
	SearchEnabled   bool
}

// ModelConfig is the per-variant info the web API returns from
// /api/v0/client/settings?scope=model. The "Instant" entry is the default
// fast mode; "Expert" is the more capable reasoner; "Vision" handles
// images. input_character_limit is in *characters* (not tokens); the client
// divides by charsPerToken to convert.
type ModelConfig struct {
	Name                string `json:"name"`
	Description         string `json:"description"`
	ModelType           string `json:"model_type"`
	IsDefault           bool   `json:"is_default"`
	Enabled             bool   `json:"enabled"`
	Switchable          bool   `json:"switchable"`
	InputCharacterLimit int    `json:"input_character_limit"`
	// ThinkEnabled / SearchEnabled are derived from the feature objects
	// (think_feature / search_feature) being non-nil in the raw response.
	ThinkEnabled bool
	SearchEnabled bool
}

// MaxInputTokens is the per-variant server-side prompt cap, expressed in
// our estimated-tokens units. It uses InputCharacterLimit / charsPerToken,
// rounded down. Zero means "no limit advertised" (which would be unusual
// for the web API — every observed variant has a limit).
func (c ModelConfig) MaxInputTokens() int {
	if c.InputCharacterLimit <= 0 {
		return 0
	}
	return c.InputCharacterLimit / charsPerToken
}

// MaxInputChars is the raw character limit from the server. Use this when
// you need to compare against len(prompt) directly without tokenization.
func (c ModelConfig) MaxInputChars() int {
	return c.InputCharacterLimit
}

// ParseModelName maps a friendly model name to its (model_type, thinking,
// search) decomposition. We support the three names the web UI exposes
// ("Instant", "Expert", "Vision") plus the legacy "default"/"expert" tokens
// that the original dpp harness used, plus compact aliases for the four
// orthogonal combinations per model_type.
//
// Mapping rules (derived from observed web API behaviour):
//   - "instant", "default", "deepseek-chat"          -> default, no thinking, no search
//   - "instant-thinking"                             -> default, thinking,    no search
//   - "instant-search"                               -> default, no thinking, search
//   - "instant-thinking-search"                      -> default, thinking,    search
//   - "expert", "reasoner", "r1"                     -> expert, no thinking, no search
//   - "expert-thinking", "reasoner-thinking"         -> expert, thinking,    no search
//   - "vision"                                       -> vision, no thinking, no search
//   - "vision-thinking"                              -> vision, thinking,    no search
//
// "Expert" maps to the deep reasoning mode; "Instant Expert" in user
// parlance is just "expert" (the model_type that handles complex problems).
// The Expert model advertises search_feature=null so we never send
// search_enabled=true for it, even if the user asks — the server will
// silently drop it.
func ParseModelName(name string) ModelSpec {
	name = strings.ToLower(strings.TrimSpace(name))
	switch name {
	case "", "instant", "default", "deepseek-chat", "flash":
		return ModelSpec{ModelType: "default", ThinkingEnabled: false, SearchEnabled: false}
	case "instant-thinking", "thinking", "think":
		return ModelSpec{ModelType: "default", ThinkingEnabled: true, SearchEnabled: false}
	case "instant-search", "search":
		return ModelSpec{ModelType: "default", ThinkingEnabled: false, SearchEnabled: true}
	case "instant-thinking-search", "thinking-search", "thinking+search":
		return ModelSpec{ModelType: "default", ThinkingEnabled: true, SearchEnabled: true}

	case "expert", "instant-expert", "reasoner", "r1", "deepseek-reasoner":
		return ModelSpec{ModelType: "expert", ThinkingEnabled: false, SearchEnabled: false}
	case "expert-thinking", "reasoner-thinking", "r1-thinking", "deepseek-reasoner-thinking":
		return ModelSpec{ModelType: "expert", ThinkingEnabled: true, SearchEnabled: false}

	case "vision", "deepseek-vision":
		return ModelSpec{ModelType: "vision", ThinkingEnabled: false, SearchEnabled: false}
	case "vision-thinking", "deepseek-vision-thinking":
		return ModelSpec{ModelType: "vision", ThinkingEnabled: true, SearchEnabled: false}
	}
	fmt.Fprintf(os.Stderr, "[deepseek] unknown model name %q — defaulting to instant\n", name)
	return ModelSpec{ModelType: "default", ThinkingEnabled: false, SearchEnabled: false}
}

// CanonicalName returns the friendly name we use internally, matching the
// labels in the web UI. Used in logs and error messages.
func (s ModelSpec) CanonicalName() string {
	switch s.ModelType {
	case "expert":
		if s.ThinkingEnabled {
			return "Expert+Thinking"
		}
		return "Expert"
	case "vision":
		if s.ThinkingEnabled {
			return "Vision+Thinking"
		}
		return "Vision"
	}
	base := "Instant"
	if s.ThinkingEnabled {
		base += "+Thinking"
	}
	if s.SearchEnabled {
		base += "+Search"
	}
	return base
}

// ModelKey returns the key under which a ModelSpec's per-variant settings
// would live in a map keyed by (model_type, thinking, search). The web API
// does not actually key settings this way (it returns three flat configs
// for Instant/Expert/Vision) but the key is useful for our own caches.
func (s ModelSpec) ModelKey() string {
	return fmt.Sprintf("%s|t=%v|s=%v", s.ModelType, s.ThinkingEnabled, s.SearchEnabled)
}

// FetchModelSettings queries /api/v0/client/settings?scope=model and returns
// a map keyed by model_type (default / expert / vision) of the per-variant
// config. The endpoint is the same one the web UI calls to populate its
// model selector. We do a best-effort decode: if the request fails
// (network error, session expired, etc.) we return nil and the caller
// falls back to the hard-coded maxPromptTokens.
//
// Note: the web API does not actually return *per-feature* settings for the
// thinking and search toggles — it returns one config per (model_type,
// default_state). The thinking and search flags are sent per-request via
// the "thinking_enabled" and "search_enabled" fields on the completion
// payload, not configured at the model level. We use the
// think_feature/search_feature objects being non-nil to detect which
// model_types support which features.
func (wc *WebClient) FetchModelSettings() (map[string]ModelConfig, error) {
	url := wc.BaseURL + "/api/v0/client/settings?scope=model"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("settings request: %w", err)
	}
	req.Header = wc.buildBaseHeaders()

	resp, err := wc.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("settings fetch: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("settings status %d: %s", resp.StatusCode, string(body))
	}

	// Parse just enough to find the model_configs array. The full response
	// is huge (the Instant config has a 7KB file_feature listing every
	// supported file extension) so we trim aggressively.
	var probe struct {
		Data struct {
			BizData struct {
				Settings struct {
					ModelConfigs struct {
						Value []json.RawMessage `json:"value"`
					} `json:"model_configs"`
				} `json:"settings"`
			} `json:"biz_data"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&probe); err != nil {
		return nil, fmt.Errorf("settings parse: %w", err)
	}

	out := make(map[string]ModelConfig, 3)
	for _, raw := range probe.Data.BizData.Settings.ModelConfigs.Value {
		var cfg ModelConfig
		if err := json.Unmarshal(raw, &cfg); err != nil {
			continue
		}
		// Detect feature support by checking the raw feature objects. We
		// only need to know if a feature is *available* — the actual
		// on/off is a per-request flag. If the feature object is missing
		// or null, the model doesn't support it.
		var rawMap map[string]json.RawMessage
		if json.Unmarshal(raw, &rawMap) == nil {
			if v, ok := rawMap["think_feature"]; ok && len(v) > 0 && string(v) != "null" {
				cfg.ThinkEnabled = true
			}
			if v, ok := rawMap["search_feature"]; ok && len(v) > 0 && string(v) != "null" {
				cfg.SearchEnabled = true
			}
		}
		out[cfg.ModelType] = cfg
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no model configs in settings response")
	}
	return out, nil
}
