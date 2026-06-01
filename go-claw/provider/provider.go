package deepseek

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"claw-code-go/internal/api"
)

// Provider implements api.Provider for DeepSeek's web chat API.
type Provider struct{}

// New returns a new DeepSeek Provider.
func New() *Provider { return &Provider{} }

func (p *Provider) Name() string               { return "deepseek" }
func (p *Provider) AuthMethod() api.AuthMethod { return api.AuthMethodAPIKey }

// NewClient creates a DeepSeek API client from the given config.
func (p *Provider) NewClient(cfg api.ProviderConfig) (api.APIClient, error) {
	token := cfg.APIKey
	if token == "" {
		// Fall back to ~/.deepseek / env var, the same sources the dpp Go
		// harness uses. This lets users run `claw-code-go --provider deepseek`
		// without any extra setup beyond dropping a token in ~/.deepseek/.
		token = LoadAuth()
	}
	if token == "" {
		return nil, fmt.Errorf("deepseek: no auth token — set DEEPSEEK_TOKEN or create ~/.deepseek/deepseek_token.txt")
	}
	model := cfg.Model
	if model == "" {
		model = DefaultModel
	}
	_ = cfg.BaseURL
	return &Client{
		token: token,
		model: model,
		web:   NewWebClient(token),
	}, nil
}

const DefaultModel = "expert"

// Client is the api.APIClient implementation for DeepSeek's web chat API.
// It translates claw-code-go's Anthropic-shaped request (system + messages +
// tools) into the web chat session format, and re-emits the streamed chunks
// as api.StreamEvent values compatible with the conversation loop.
type Client struct {
	token string
	model string
	web   *WebClient

	mu              sync.Mutex
	chatSessionID   string
	parentMessageID string

	// Per-model settings discovered from /api/v0/client/settings?scope=model.
	// Populated lazily on the first request and reused for the lifetime of
	// the client. Falls back to the hard-coded maxPromptTokens if the fetch
	// fails (network error, expired session, etc.).
	settingsOnce sync.Once
	settingsErr  error
	settings     map[string]ModelConfig
}

// fetchSettings lazily loads and caches the per-model settings from the
// server. Called from the pre-flight check so the limit can be picked from
// the actual server-advertised cap rather than a hard-coded guess.
func (c *Client) fetchSettings() (map[string]ModelConfig, error) {
	c.settingsOnce.Do(func() {
		c.settings, c.settingsErr = c.web.FetchModelSettings()
	})
	return c.settings, c.settingsErr
}

// limitForModel returns the per-model input-token cap, or 0 if unknown. The
// model_type is the only relevant dimension (thinking/search don't change
// the input cap on the web API).
func (c *Client) limitForModel(spec ModelSpec) int {
	if settings, err := c.fetchSettings(); err == nil {
		if cfg, ok := settings[spec.ModelType]; ok && cfg.InputCharacterLimit > 0 {
			return cfg.MaxInputTokens()
		}
	}
	// Fallback: hard-coded default for the model_type.
	switch spec.ModelType {
	case "expert":
		// Expert's input_character_limit is 163,840 → 40,960 tokens at 4
		// chars/token. Round down slightly for safety margin.
		return 38_000
	case "vision":
		return 600_000
	default:
		return maxPromptTokens
	}
}

// ensureSession creates a chat session on the DeepSeek side if we don't
// have one. Reused across all turns of a single conversation.
func (c *Client) ensureSession(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.chatSessionID != "" {
		return nil
	}
	sessID, err := c.web.CreateChatSession()
	if err != nil {
		return fmt.Errorf("deepseek: create session: %w", err)
	}
	c.chatSessionID = sessID
	return nil
}

// maxRetries is how many times to retry on transient errors (network blips,
// 5xx responses, PoW failures, etc.) before giving up.
const maxRetries = 3

// transientErrors contains substrings that indicate a retryable failure.
var transientErrors = []string{
	"connection reset",
	"connection refused",
	"EOF",
	"timeout",
	"EOF",
	"PoW",
	"500",
	"502",
	"503",
	"504",
	"rate limit",
	"temporarily unavailable",
	"stream error",
	"no session ID",
}

func isTransient(errMsg string) bool {
	low := strings.ToLower(errMsg)
	for _, hint := range transientErrors {
		if strings.Contains(low, strings.ToLower(hint)) {
			return true
		}
	}
	return false
}

// StreamResponse sends a streaming request to DeepSeek and returns a channel
// of api.StreamEvent values matching the conversation loop's expectations.
func (c *Client) StreamResponse(ctx context.Context, req api.CreateMessageRequest) (<-chan api.StreamEvent, error) {
	if err := c.ensureSession(ctx); err != nil {
		return nil, err
	}

	prompt := buildPrompt(req.System, req.Messages, req.Tools)

	// Resolve the model spec for this request. cfg.Model is the friendly
	// name (e.g. "expert-thinking", "instant-search"). When the caller
	// doesn't set one we default to the Expert model — the deeper reasoning
	// variant that the web UI highlights for "complex problems". The
	// spec tells us which model_type and feature flags to send to the
	// server, and which per-model input cap to use.
	spec := ParseModelName(c.model)
	if c.model == "" {
		spec = ParseModelName(DefaultModel)
	}
	modelCap := c.limitForModel(spec)

	// Pre-flight: estimate input tokens and reject if we'd blow past the
	// model-specific cap. The conversation loop's ShouldCompact uses
	// EstimateTokens as a fallback, but the actual prompt we send is bigger
	// (we flatten the system prompt + tool descriptions + messages into a
	// single string), so check against the true prompt.
	estimatedInput := EstimateTokens(prompt)
	if modelCap > 0 && estimatedInput > modelCap {
		return nil, fmt.Errorf(
			"deepseek: prompt too large for %s (~%d tokens, limit %d). Compact the session or reduce history",
			spec.CanonicalName(), estimatedInput, modelCap,
		)
	}
	if estimatedInput > softPromptLimit {
		fmt.Fprintf(os.Stderr, "[deepseek] warning: prompt at ~%d tokens (soft limit %d) for %s\n",
			estimatedInput, softPromptLimit, spec.CanonicalName())
	}

	// Compute the output token budget. The request sets MaxTokens; we use it
	// to truncate the streamed response so the conversation loop and tool
	// detection see a coherent (cut-off) answer rather than something that
	// might have been truncated mid-thought by the upstream server.
	outputBudget := req.MaxTokens
	if outputBudget <= 0 {
		outputBudget = 4096
	}
	maxOutputChars := outputBudget * charsPerToken

	c.mu.Lock()
	parentID := c.parentMessageID
	c.mu.Unlock()
	var parentPtr *string
	if parentID != "" {
		parentPtr = &parentID
	}

	sessID := c.chatSessionID

	ch := make(chan api.StreamEvent, 64)

	go func() {
		defer close(ch)

		send := func(ev api.StreamEvent) bool {
			select {
			case ch <- ev:
				return true
			case <-ctx.Done():
				return false
			}
		}

		// Kick off the turn with a message_start, including the estimated
		// input token count so the conversation loop's compaction logic
		// (which checks CompactionState.LastInputTokens) fires on time.
		if !send(api.StreamEvent{
			Type:        api.EventMessageStart,
			InputTokens: estimatedInput,
		}) {
			return
		}

		// Track all streamed content so we can run tool-call detection on it.
		var fullText strings.Builder
		// Track output tokens for the EventMessageDelta Usage field.
		var outputChars int
		// Hit the budget? Stop accepting new content but keep the goroutine
		// running so we can still emit tool-call blocks and the final events.
		var budgetExceeded bool

		// Open a text content block for the streamed response.
		if !send(api.StreamEvent{
			Type:         api.EventContentBlockStart,
			Index:        0,
			ContentBlock: api.ContentBlockInfo{Type: "text", Index: 0},
		}) {
			return
		}

		// Retry loop for transient errors. We retry the whole stream
		// because the DeepSeek web API has no concept of resumable
		// streaming — if a request fails mid-stream, we have to start over.
		var (
			newID string
			err   error
		)
		for attempt := 0; attempt < maxRetries; attempt++ {
			if attempt > 0 {
				// Exponential backoff with jitter. Bounded so we don't sleep
				// forever on repeated failures.
				backoff := time.Duration(1<<attempt) * 200 * time.Millisecond
				select {
				case <-time.After(backoff):
				case <-ctx.Done():
					return
				}
				fmt.Fprintf(os.Stderr, "[deepseek] retry %d/%d after %v\n", attempt+1, maxRetries, backoff)
				// Clear the buffer so a partial response doesn't leak into
				// the next attempt's tool detection.
				fullText.Reset()
				outputChars = 0
				budgetExceeded = false
			}

			newID, err = c.web.ChatCompletionStream(
				CompletionOpts{
					SessionID:   sessID,
					ParentMsgID: parentPtr,
					Prompt:      prompt,
					Spec:        spec,
				},
				func(event StreamEvent) {
				if event.Event != "content" {
					if event.Event == "message_id" {
						c.mu.Lock()
						c.parentMessageID = event.Data
						c.mu.Unlock()
					}
					return
				}
				// Always append to fullText — even after the budget trips —
				// so tool-call detection can still see what the model tried
				// to emit (it's better to extract a partial tool call than
				// none at all).
				fullText.WriteString(event.Data)
				outputChars += len(event.Data)
				if budgetExceeded {
					return
				}
				if outputChars > maxOutputChars {
					// We've hit the output budget. Note it for later and
					// stop pushing more deltas — but keep the partial
					// response in fullText so tool detection still works.
					budgetExceeded = true
					fmt.Fprintf(os.Stderr, "[deepseek] output budget exhausted at %d chars; truncating stream\n", outputChars)
					return
				}
					if !send(api.StreamEvent{
						Type:  api.EventContentBlockDelta,
						Index: 0,
						Delta: api.Delta{Type: "text_delta", Text: event.Data},
					}) {
						return
					}
				},
			)

			if err == nil {
				break
			}
			if !isTransient(err.Error()) {
				break
			}
			fmt.Fprintf(os.Stderr, "[deepseek] transient error: %v\n", err)
		}
		if err != nil {
			send(api.StreamEvent{
				Type:         api.EventError,
				ErrorMessage: fmt.Sprintf("deepseek: %s", err.Error()),
			})
			return
		}
		if newID != "" {
			c.mu.Lock()
			c.parentMessageID = newID
			c.mu.Unlock()
		}

		// If we hit the output budget mid-tool-call, append a marker so the
		// model (next turn) understands the previous turn was cut short.
		text := fullText.String()
		if budgetExceeded && !strings.HasSuffix(strings.TrimSpace(text), "…") {
			text += "\n\n[…response truncated by client to fit max_tokens…]"
		}

		calls := ExtractToolCalls(text)

		// Close the text content block.
		if !send(api.StreamEvent{Type: api.EventContentBlockStop, Index: 0}) {
			return
		}

		// Emit one tool_use block per detected call. The conversation loop
		// recognises EventContentBlockStart with type=tool_use and the
		// following input_json_delta as a tool invocation.
		for i, tc := range calls {
			idx := i + 1
			argsJSON, _ := json.Marshal(tc.Arguments)
			if !send(api.StreamEvent{
				Type:  api.EventContentBlockStart,
				Index: idx,
				ContentBlock: api.ContentBlockInfo{
					Type:  "tool_use",
					Index: idx,
					ID:    fmt.Sprintf("toolu_%s_%d", newID, i),
					Name:  tc.Name,
				},
			}) {
				return
			}
			if !send(api.StreamEvent{
				Type:  api.EventContentBlockDelta,
				Index: idx,
				Delta: api.Delta{Type: "input_json_delta", PartialJSON: string(argsJSON)},
			}) {
				return
			}
			if !send(api.StreamEvent{Type: api.EventContentBlockStop, Index: idx}) {
				return
			}
		}

		stopReason := "end_turn"
		if len(calls) > 0 {
			stopReason = "tool_use"
		}
		send(api.StreamEvent{
			Type:       api.EventMessageDelta,
			StopReason: stopReason,
		})
		send(api.StreamEvent{Type: api.EventMessageStop})
	}()

	return ch, nil
}

func (c *Client) modelType() string {
	// Legacy shim used by the original dpp harness. We keep it so callers
	// that pass a raw model_type string ("default" / "expert") still work.
	switch c.model {
	case "deepseek-reasoner", "deepseek-r1", "reasoner", "expert":
		return "expert"
	case "vision":
		return "vision"
	}
	return "default"
}

// buildPrompt flattens an Anthropic-style request into the single-prompt
// shape that chat.deepseek.com's /completion endpoint expects.
func buildPrompt(system string, messages []api.Message, tools []api.Tool) string {
	var parts []string

	toolDesc := describeTools(tools)

	if system != "" {
		parts = append(parts, system)
	}
	if toolDesc != "" {
		parts = append(parts, toolDesc)
	}

	for _, msg := range messages {
		switch msg.Role {
		case "user":
			var textParts []string
			var toolResults []string
			for _, block := range msg.Content {
				switch block.Type {
				case "text":
					if block.Text != "" {
						textParts = append(textParts, block.Text)
					}
				case "tool_result":
					content := extractToolResultText(block)
					toolResults = append(toolResults, fmt.Sprintf("[Tool:%s result]\n%s", block.ToolUseID, content))
				}
			}
			if len(textParts) > 0 {
				parts = append(parts, "[User]\n"+strings.Join(textParts, "\n"))
			}
			if len(toolResults) > 0 {
				parts = append(parts, strings.Join(toolResults, "\n\n"))
			}
		case "assistant":
			var textParts []string
			for _, block := range msg.Content {
				switch block.Type {
				case "text":
					if block.Text != "" {
						textParts = append(textParts, block.Text)
					}
				case "tool_use":
					argsJSON, _ := json.Marshal(block.Input)
					textParts = append(textParts, fmt.Sprintf("[Assistant tool call: %s(%s)]", block.Name, string(argsJSON)))
				}
			}
			if len(textParts) > 0 {
				parts = append(parts, "[Assistant]\n"+strings.Join(textParts, "\n"))
			}
		}
	}

	parts = append(parts, "\nRespond with the next assistant turn. To call a tool, output a JSON object like {\"tool_calls\":[{\"name\":\"...\",\"arguments\":{...}}]} on its own line (no markdown fences).")

	return strings.Join(parts, "\n\n")
}

func extractToolResultText(block api.ContentBlock) string {
	var parts []string
	for _, c := range block.Content {
		if c.Text != "" {
			parts = append(parts, c.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func describeTools(tools []api.Tool) string {
	if len(tools) == 0 {
		return ""
	}
	var lines []string
	lines = append(lines, "Available tools (output as JSON: {\"tool_calls\":[{\"name\":...,\"arguments\":{...}}]}):")
	for _, t := range tools {
		lines = append(lines, fmt.Sprintf("- %s: %s", t.Name, t.Description))
		var props []string
		required := map[string]bool{}
		for _, r := range t.InputSchema.Required {
			required[r] = true
		}
		for k, p := range t.InputSchema.Properties {
			req := ""
			if required[k] {
				req = " (required)"
			}
			lines = append(lines, fmt.Sprintf("    - %s [%s]%s: %s", k, p.Type, req, p.Description))
		}
		_ = props
	}
	return strings.Join(lines, "\n")
}

// SaveToken persists a token to ~/.deepseek/deepseek_token.txt for
// subsequent runs. Called by /login flow.
func SaveToken(token string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".deepseek")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "deepseek_token.txt"), []byte(strings.TrimSpace(token)+"\n"), 0o600)
}
