package deepseek

// StreamEvent is a single parsed event from the DeepSeek SSE stream.
type StreamEvent struct {
	Event string // "content", "debug", "message_id"
	Data  string
}

// StreamHandler is the callback for each StreamEvent.
type StreamHandler func(event StreamEvent)

// SettingsLimits is the per-variant limit info we may pass through to
// ChatCompletionStream. The web API publishes the actual limits on
// /api/v0/client/settings?scope=model (see ModelConfig in models.go); this
// struct is kept for callers that want to override the cached values.
type SettingsLimits struct {
	MaxInputTokens  int
	MaxOutputTokens int
}

// CompletionOpts is the request shape for ChatCompletionStream. Spec
// carries the decomposed (model_type, thinking, search) and is preferred
// over the legacy Model string. Settings is optional and is used by the
// pre-flight check to enforce the per-variant cap.
type CompletionOpts struct {
	SessionID   string
	ParentMsgID *string
	Prompt      string
	Model       string    // legacy: "default" or "expert" or "vision"
	Spec        ModelSpec // preferred: decomposed (model_type, thinking, search)
	Settings    SettingsLimits
}
