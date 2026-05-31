package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

var openAIToolStartMarkers = []string{
	`{"tool_calls"`,
	`{"_calls"`,
	`{"tool"`,
	"<tool_call>",
	"<tool_calls>",
	"<function_calls>",
	"<_calls>",
	"<pi-tool-calls>",
	"<invoke",
	"<function_call",
}

var openAIToolEndMarkers = []string{
	"</tool_call>",
	"</tool_calls>",
	"</function_calls>",
	"</_calls>",
	"</pi-tool-calls>",
	"</invoke>",
	"</function_call>",
}

var modelMap = map[string]string{
	"gpt-4":         "expert",
	"gpt-4o":        "expert",
	"gpt-4-turbo":   "expert",
	"gpt-3.5-turbo": "default",
	"deepseek-chat": "default",
}

func mapModel(model string) string {
	if mapped, ok := modelMap[model]; ok {
		return mapped
	}
	if model == "" {
		return "default"
	}
	return "expert"
}

func validateAPIKey(r *http.Request, expectedKey string) bool {
	if expectedKey == "" {
		return true // No API key configured, allow all requests
	}
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return false
	}
	// Expected format: "Bearer <key>"
	if !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	return auth[7:] == expectedKey
}

func generateChatID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return fmt.Sprintf("chatcmpl-%x", b)
}

func messagesToPrompt(messages []OpenAIChatMessage) string {
	var parts []string
	for _, msg := range messages {
		var text string
		switch c := msg.Content.(type) {
		case string:
			text = c
		case []interface{}:
			var chunks []string
			for _, part := range c {
				if m, ok := part.(map[string]interface{}); ok {
					if t, ok := m["text"].(string); ok {
						chunks = append(chunks, t)
					}
				}
			}
			text = strings.Join(chunks, "")
		default:
			// Content may be nil if the message has tool calls
			if msg.Content != nil {
				text = fmt.Sprintf("%v", msg.Content)
			}
		}

		// Build the message part with extra context for tool calls
		var sb strings.Builder
		switch msg.Role {
		case "system":
			sb.WriteString("[System]\n" + text)
		case "user":
			sb.WriteString("[User]\n" + text)
		case "assistant":
			sb.WriteString("[Assistant]")
			if text != "" {
				sb.WriteString("\n" + text)
			}
			// Include prior tool calls for conversation continuity
			if len(msg.ToolCalls) > 0 {
				for _, tc := range msg.ToolCalls {
					sb.WriteString(fmt.Sprintf("\n<tool_call>\n<name>%s</name>\n<arguments>%s</arguments>\n</tool_call>", tc.Function.Name, tc.Function.Arguments))
				}
			}
		case "tool":
			sb.WriteString("[Tool Result")
			if msg.ToolCallID != "" {
				sb.WriteString(" (" + msg.ToolCallID + ")")
			}
			sb.WriteString("]\n" + text)
		default:
			sb.WriteString("[" + msg.Role + "]\n" + text)
		}
		parts = append(parts, sb.String())
	}
	return strings.Join(parts, "\n\n")
}

func openAIError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(OpenAIError{
		Error: OpenAIErrorDetail{
			Message: msg,
			Type:    "invalid_request_error",
			Code:    fmt.Sprintf("%d", status),
		},
	})
}

func handleModels(w http.ResponseWriter, r *http.Request) {
	models := []OpenAIModel{
		{ID: "deepseek-chat", Object: "model", Created: time.Now().Unix(), OwnedBy: "deepseek"},
		{ID: "gpt-4", Object: "model", Created: time.Now().Unix(), OwnedBy: "deepseek"},
		{ID: "gpt-4o", Object: "model", Created: time.Now().Unix(), OwnedBy: "deepseek"},
		{ID: "gpt-4-turbo", Object: "model", Created: time.Now().Unix(), OwnedBy: "deepseek"},
		{ID: "gpt-3.5-turbo", Object: "model", Created: time.Now().Unix(), OwnedBy: "deepseek"},
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(OpenAIModelList{Object: "list", Data: models})
}

func handleChatCompletions(w http.ResponseWriter, r *http.Request, client *WebClient, sessionID *string) {
	if r.Method != "POST" {
		openAIError(w, 405, "method not allowed")
		return
	}

	// Limit request body to 10MB
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)

	body, err := io.ReadAll(r.Body)
	if err != nil {
		openAIError(w, 400, "failed to read request body")
		return
	}
	defer r.Body.Close()

	var req OpenAIChatRequest
	if err := json.Unmarshal(body, &req); err != nil {
		openAIError(w, 400, "invalid JSON: "+err.Error())
		return
	}

	if len(req.Messages) == 0 {
		openAIError(w, 400, "messages array is required")
		return
	}

	prompt := messagesToPrompt(req.Messages)
	// Inject tool definitions if provided by the client
	if len(req.Tools) > 0 {
		prompt = injectToolDefs(prompt, req.Tools)
	}
	modelType := mapModel(req.Model)
	chatID := generateChatID()
	created := time.Now().Unix()

	if req.Stream {
		handleStreamingChat(w, r, client, sessionID, prompt, modelType, chatID, created, req.Model)
	} else {
		handleNonStreamingChat(w, client, sessionID, prompt, modelType, chatID, created, req.Model)
	}
}

func handleStreamingChat(w http.ResponseWriter, r *http.Request, client *WebClient, sessionID *string, prompt, modelType, chatID string, created int64, requestModel string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		openAIError(w, 500, "streaming not supported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(200)

	firstChunk := OpenAIChatCompletion{
		ID:      chatID,
		Object:  "chat.completion.chunk",
		Created: created,
		Model:   requestModel,
		Choices: []OpenAIChatChoice{{
			Index:        0,
			Delta:        &OpenAIChatMessage{Role: "assistant", Content: ""},
			FinishReason: nil,
		}},
	}
	data, _ := json.Marshal(firstChunk)
	fmt.Fprintf(w, "data: %s\n\n", data)
	flusher.Flush()

	var accumulatedText strings.Builder
	filterState := visibleDeltaFilterState{}
	client.ChatCompletionStream(
		CompletionOpts{
			SessionID: *sessionID,
			Prompt:    prompt,
			Model:     modelType,
		},
		func(event StreamEvent) {
			if event.Event != "content" {
				return
			}
			accumulatedText.WriteString(event.Data)
			visibleDelta := filterVisibleOpenAIDelta(event.Data, &filterState)
			if visibleDelta == "" {
				return
			}
			chunk := OpenAIChatCompletion{
				ID:      chatID,
				Object:  "chat.completion.chunk",
				Created: created,
				Model:   requestModel,
				Choices: []OpenAIChatChoice{{
					Index:        0,
					Delta:        &OpenAIChatMessage{Content: visibleDelta},
					FinishReason: nil,
				}},
			}
			data, _ := json.Marshal(chunk)
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		},
	)

	// Extract tool calls from the full accumulated text
	fullText := accumulatedText.String()
	toolCalls, _ := extractOpenAIToolCalls(fullText)

	stop := "stop"
	if len(toolCalls) > 0 {
		stop = "tool_calls"
		// Emit tool calls in a delta chunk before the final chunk
		toolCallDelta := &OpenAIChatMessage{Role: "assistant", ToolCalls: toolCalls}
		toolCallChunk := OpenAIChatCompletion{
			ID:      chatID,
			Object:  "chat.completion.chunk",
			Created: created,
			Model:   requestModel,
			Choices: []OpenAIChatChoice{{
				Index:        0,
				Delta:        toolCallDelta,
				FinishReason: nil,
			}},
		}
		if data, err := json.Marshal(toolCallChunk); err == nil {
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}

	final := OpenAIChatCompletion{
		ID:      chatID,
		Object:  "chat.completion.chunk",
		Created: created,
		Model:   requestModel,
		Choices: []OpenAIChatChoice{{
			Index:        0,
			Delta:        &OpenAIChatMessage{},
			FinishReason: &stop,
		}},
	}
	data, _ = json.Marshal(final)
	fmt.Fprintf(w, "data: %s\n\n", data)
	fmt.Fprintf(w, "data: [DONE]\n\n")
	flusher.Flush()
}

func handleNonStreamingChat(w http.ResponseWriter, client *WebClient, sessionID *string, prompt, modelType, chatID string, created int64, requestModel string) {
	var responseText strings.Builder

	err := client.ChatCompletionStream(
		CompletionOpts{
			SessionID: *sessionID,
			Prompt:    prompt,
			Model:     modelType,
		},
		func(event StreamEvent) {
			if event.Event == "content" {
				responseText.WriteString(event.Data)
			}
		},
	)
	if err != nil {
		openAIError(w, 500, "completion error: "+err.Error())
		return
	}

	stop := "stop"
	fullText := responseText.String()

	// Extract tool calls from the response (if any)
	toolCalls, cleanText := extractOpenAIToolCalls(fullText)

	var msg *OpenAIChatMessage
	if len(toolCalls) > 0 {
		stop = "tool_calls"
		msg = &OpenAIChatMessage{Role: "assistant", Content: cleanText, ToolCalls: toolCalls}
	} else {
		msg = &OpenAIChatMessage{Role: "assistant", Content: fullText}
	}

	resp := OpenAIChatCompletion{
		ID:      chatID,
		Object:  "chat.completion",
		Created: created,
		Model:   requestModel,
		Choices: []OpenAIChatChoice{{
			Index:        0,
			Message:      msg,
			FinishReason: &stop,
		}},
		Usage: &OpenAIChatUsage{
			PromptTokens:     len(strings.Fields(prompt)),
			CompletionTokens: len(strings.Fields(fullText)),
			TotalTokens:      len(strings.Fields(prompt)) + len(strings.Fields(fullText)),
		},
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(resp)
}

// SessionManager manages per-client sessions
type SessionManager struct {
	client   *WebClient
	sessions map[string]string // clientKey -> sessionID
	mu       sync.RWMutex
}

func NewSessionManager(client *WebClient) *SessionManager {
	return &SessionManager{
		client:   client,
		sessions: make(map[string]string),
	}
}

func (sm *SessionManager) GetSession(clientKey string) (string, error) {
	sm.mu.RLock()
	if sessionID, ok := sm.sessions[clientKey]; ok {
		sm.mu.RUnlock()
		return sessionID, nil
	}
	sm.mu.RUnlock()

	// Create new session
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Double-check after acquiring write lock
	if sessionID, ok := sm.sessions[clientKey]; ok {
		return sessionID, nil
	}

	sessionID, err := sm.client.CreateChatSession()
	if err != nil {
		return "", fmt.Errorf("create session: %w", err)
	}

	sm.sessions[clientKey] = sessionID
	fmt.Fprintf(os.Stderr, "[openai-proxy] Created session for client %s: %s\n", clientKey, sessionID)
	return sessionID, nil
}

func injectToolDefs(prompt string, toolsRaw json.RawMessage) string {
	var tools []map[string]interface{}
	if err := json.Unmarshal(toolsRaw, &tools); err != nil {
		return prompt
	}
	var sb strings.Builder
	sb.WriteString("\n\n[System]\nYou have access to the following OpenAI function tools. When you need to call a tool, output exactly one JSON object with this shape and no markdown fence:\n{\"tool_calls\":[{\"name\":\"TOOL_NAME\",\"arguments\":{\"arg\":\"value\"}}]}\n\nAvailable tools:\n")
	for _, t := range tools {
		if fn, ok := t["function"].(map[string]interface{}); ok {
			name, _ := fn["name"].(string)
			desc, _ := fn["description"].(string)
			params, _ := fn["parameters"].(map[string]interface{})
			paramsJSON, _ := json.Marshal(params)
			sb.WriteString(fmt.Sprintf("- %s: %s\n  Parameters: %s\n", name, desc, string(paramsJSON)))
		}
	}
	sb.WriteString("\nAfter calling a tool, wait for the result before continuing.")
	return prompt + sb.String()
}

func extractOpenAIToolCalls(text string) ([]OpenAIToolCall, string) {
	var calls []OpenAIToolCall
	remaining := text

	calls = append(calls, extractOpenAIJSONToolCalls(remaining)...)
	remaining = stripOpenAIJSONToolCalls(remaining)

	for {
		startIdx := strings.Index(remaining, "<tool_call>")
		if startIdx == -1 {
			break
		}
		endIdx := strings.Index(remaining[startIdx:], "</tool_call>")
		if endIdx == -1 {
			break
		}
		endIdx += startIdx + len("</tool_call>")
		block := remaining[startIdx:endIdx]
		remaining = remaining[:startIdx] + remaining[endIdx:]

		nameStart := strings.Index(block, "<name>")
		nameEnd := strings.Index(block, "</name>")
		argsStart := strings.Index(block, "<arguments>")
		argsEnd := strings.Index(block, "</arguments>")
		if nameStart == -1 || nameEnd == -1 || argsStart == -1 || argsEnd == -1 {
			continue
		}
		name := block[nameStart+len("<name>") : nameEnd]
		args := block[argsStart+len("<arguments>") : argsEnd]

		callID := fmt.Sprintf("call_%x", time.Now().UnixNano())
		calls = append(calls, OpenAIToolCall{
			ID:   callID,
			Type: "function",
			Function: OpenAIToolCallFunction{
				Name:      strings.TrimSpace(name),
				Arguments: strings.TrimSpace(args),
			},
		})
	}
	genericCalls := extractToolCalls(remaining)
	if len(genericCalls) > 0 {
		for _, call := range genericCalls {
			calls = append(calls, openAIToolCallFromNameArgs(call.Name, call.Arguments))
		}
	}
	remaining = stripOpenAIToolMarkup(remaining)
	remaining = strings.TrimSpace(remaining)
	return dedupeOpenAIToolCalls(calls), remaining
}

func openAIToolCallFromNameArgs(name string, args map[string]interface{}) OpenAIToolCall {
	argsJSON, err := json.Marshal(args)
	if err != nil {
		argsJSON = []byte("{}")
	}
	return OpenAIToolCall{
		ID:   fmt.Sprintf("call_%x", time.Now().UnixNano()),
		Type: "function",
		Function: OpenAIToolCallFunction{
			Name:      strings.TrimSpace(name),
			Arguments: string(argsJSON),
		},
	}
}

func dedupeOpenAIToolCalls(calls []OpenAIToolCall) []OpenAIToolCall {
	seen := make(map[string]bool)
	var out []OpenAIToolCall
	for _, call := range calls {
		key := call.Function.Name + ":" + call.Function.Arguments
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, call)
	}
	return out
}

func extractOpenAIJSONToolCalls(text string) []OpenAIToolCall {
	var calls []OpenAIToolCall
	for _, value := range extractJSONValuesFromText(text) {
		var parsed interface{}
		if json.Unmarshal([]byte(value), &parsed) != nil {
			continue
		}
		calls = append(calls, openAIToolCallsFromJSON(parsed)...)
	}
	return calls
}

func extractJSONValuesFromText(text string) []string {
	var values []string
	seen := make(map[int]bool)
	for _, marker := range []string{`{"tool_calls"`, `{"_calls"`, `{"tool"`, "["} {
		searchFrom := 0
		for {
			idx := strings.Index(text[searchFrom:], marker)
			if idx == -1 {
				break
			}
			idx += searchFrom
			if seen[idx] {
				searchFrom = idx + 1
				continue
			}
			seen[idx] = true
			value := extractJsonValue(text, idx)
			if value != "" {
				values = append(values, value)
			}
			searchFrom = idx + 1
		}
	}
	return values
}

func openAIToolCallsFromJSON(parsed interface{}) []OpenAIToolCall {
	var rawCalls []interface{}
	switch v := parsed.(type) {
	case map[string]interface{}:
		if arr, ok := v["tool_calls"].([]interface{}); ok {
			rawCalls = arr
		} else if arr, ok := v["_calls"].([]interface{}); ok {
			rawCalls = arr
		} else if toolName, ok := v["tool"].(string); ok {
			args := make(map[string]interface{})
			for key, value := range v {
				if key != "tool" {
					args[key] = value
				}
			}
			return []OpenAIToolCall{openAIToolCallFromNameArgs(toolName, args)}
		} else if name, ok := v["name"].(string); ok {
			args := normalizeOpenAIJSONArgs(v)
			return []OpenAIToolCall{openAIToolCallFromNameArgs(name, args)}
		}
	case []interface{}:
		rawCalls = v
	}

	var calls []OpenAIToolCall
	for _, item := range rawCalls {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		name := ""
		if n, ok := m["name"].(string); ok {
			name = n
		}
		if name == "" {
			if fn, ok := m["function"].(map[string]interface{}); ok {
				if n, ok := fn["name"].(string); ok {
					name = n
				}
			}
		}
		if name == "" {
			continue
		}
		calls = append(calls, openAIToolCallFromNameArgs(name, normalizeOpenAIJSONArgs(m)))
	}
	return calls
}

func normalizeOpenAIJSONArgs(m map[string]interface{}) map[string]interface{} {
	for _, key := range []string{"arguments", "args"} {
		if args, ok := m[key]; ok {
			switch a := args.(type) {
			case map[string]interface{}:
				return a
			case string:
				var parsed map[string]interface{}
				if json.Unmarshal([]byte(a), &parsed) == nil {
					return parsed
				}
				return map[string]interface{}{"input": a}
			}
		}
	}
	if fn, ok := m["function"].(map[string]interface{}); ok {
		return normalizeOpenAIJSONArgs(fn)
	}
	return map[string]interface{}{}
}

func stripOpenAIJSONToolCalls(text string) string {
	result := text
	for _, marker := range []string{`{"tool_calls"`, `{"_calls"`, `{"tool"`, "["} {
		for {
			idx := strings.Index(result, marker)
			if idx == -1 {
				break
			}
			value := extractJsonValue(result, idx)
			if value == "" {
				break
			}
			if len(openAIToolCallsFromJSONString(value)) == 0 {
				break
			}
			result = result[:idx] + result[idx+len(value):]
		}
	}
	return strings.TrimSpace(result)
}

func openAIToolCallsFromJSONString(value string) []OpenAIToolCall {
	var parsed interface{}
	if json.Unmarshal([]byte(value), &parsed) != nil {
		return nil
	}
	return openAIToolCallsFromJSON(parsed)
}

func stripOpenAIToolMarkup(text string) string {
	result := text
	for _, pair := range [][2]string{
		{"<tool_calls>", "</tool_calls>"},
		{"<function_calls>", "</function_calls>"},
		{"<_calls>", "</_calls>"},
		{"<pi-tool-calls>", "</pi-tool-calls>"},
		{"<invoke", "</invoke>"},
		{"<function_call", "</function_call>"},
	} {
		for {
			start := strings.Index(result, pair[0])
			if start == -1 {
				break
			}
			end := strings.Index(result[start:], pair[1])
			if end == -1 {
				result = result[:start]
				break
			}
			end += start + len(pair[1])
			result = result[:start] + result[end:]
		}
	}
	return strings.TrimSpace(result)
}

type visibleDeltaFilterState struct {
	suppressing bool
	pending     string
}

func filterVisibleOpenAIDelta(delta string, state *visibleDeltaFilterState) string {
	rest := state.pending + delta
	state.pending = ""
	var visible strings.Builder

	longestMarker := 0
	for _, marker := range openAIToolStartMarkers {
		if len(marker) > longestMarker {
			longestMarker = len(marker)
		}
	}

	for len(rest) > 0 {
		if state.suppressing {
			idx, marker := findFirstOpenAIMarker(rest, openAIToolEndMarkers)
			if idx == -1 {
				return visible.String()
			}
			rest = rest[idx+len(marker):]
			state.suppressing = false
			continue
		}

		idx, marker := findFirstOpenAIMarker(rest, openAIToolStartMarkers)
		if idx == -1 {
			keep := longestMarker - 1
			if keep < 0 {
				keep = 0
			}
			if keep > len(rest) {
				keep = len(rest)
			}
			emitLen := len(rest) - keep
			visible.WriteString(rest[:emitLen])
			state.pending = rest[emitLen:]
			break
		}
		visible.WriteString(rest[:idx])
		rest = rest[idx+len(marker):]
		state.suppressing = true
	}

	return visible.String()
}

func findFirstOpenAIMarker(text string, markers []string) (int, string) {
	bestIdx := -1
	bestMarker := ""
	for _, marker := range markers {
		idx := strings.Index(text, marker)
		if idx == -1 {
			continue
		}
		if bestIdx == -1 || idx < bestIdx {
			bestIdx = idx
			bestMarker = marker
		}
	}
	return bestIdx, bestMarker
}

func StartOpenAIServer(client *WebClient, sessionID *string, port string, apiKey string) error {
	sessionMgr := NewSessionManager(client)
	mux := http.NewServeMux()

	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == "OPTIONS" {
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.WriteHeader(204)
			return
		}
		if !validateAPIKey(r, apiKey) {
			openAIError(w, 401, "invalid api key")
			return
		}
		handleModels(w, r)
	})

	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == "OPTIONS" {
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.WriteHeader(204)
			return
		}
		if !validateAPIKey(r, apiKey) {
			openAIError(w, 401, "invalid api key")
			return
		}

		// Use client IP + User-Agent as session key
		clientKey := r.RemoteAddr + "|" + r.UserAgent()
		sessionID, err := sessionMgr.GetSession(clientKey)
		if err != nil {
			openAIError(w, 500, "failed to create session: "+err.Error())
			return
		}
		handleChatCompletions(w, r, client, &sessionID)
	})

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	addr := ":" + port
	fmt.Fprintf(os.Stderr, "[openai-proxy] Listening on %s\n", addr)
	fmt.Fprintf(os.Stderr, "[openai-proxy] POST http://localhost%s/v1/chat/completions\n", addr)
	fmt.Fprintf(os.Stderr, "[openai-proxy] GET  http://localhost%s/v1/models\n", addr)
	if apiKey != "" {
		fmt.Fprintf(os.Stderr, "[openai-proxy] API key authentication enabled\n")
	}
	return http.ListenAndServe(addr, mux)
}
