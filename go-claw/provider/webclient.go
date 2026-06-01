// Package deepseek implements the api.Provider and api.APIClient interfaces
// for DeepSeek's web chat API (chat.deepseek.com) — the same interface used
// in a browser session. This avoids needing a DeepSeek-issued API key and
// instead reuses a session token captured from a logged-in browser.
package deepseek

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"claw-code-go/internal/api"
)

const (
	defaultBaseURL = "https://chat.deepseek.com"
	appVersion     = "20241129.1"
	clientVersion  = "2.0.0"
	headerOrigin   = "https://chat.deepseek.com"
)

// LoadAuth resolves a DeepSeek auth token from one of:
//   - DEEPSEEK_TOKEN env var
//   - ~/.deepseek/deepseek_token.txt (plain text)
//   - ~/.deepseek/auth.json (Chrome localStorage export)
func LoadAuth() string {
	if tok := strings.TrimSpace(os.Getenv("DEEPSEEK_TOKEN")); tok != "" {
		return tok
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}

	tokenFile := filepath.Join(home, ".deepseek", "deepseek_token.txt")
	if data, err := os.ReadFile(tokenFile); err == nil {
		if t := strings.TrimSpace(string(data)); t != "" {
			return t
		}
	}

	authFile := filepath.Join(home, ".deepseek", "auth.json")
	if data, err := os.ReadFile(authFile); err == nil {
		var authObj struct {
			Origins []struct {
				LocalStorage []struct {
					Key   string `json:"key"`
					Value string `json:"value"`
				} `json:"localStorage"`
			} `json:"origins"`
		}
		if json.Unmarshal(data, &authObj) == nil {
			for _, origin := range authObj.Origins {
				for _, ls := range origin.LocalStorage {
					if ls.Key == "token" || ls.Key == "ds_token" || ls.Key == "deepseek_token" {
						return ls.Value
					}
				}
			}
		}
	}

	return ""
}

// WebClient talks to chat.deepseek.com's HTTP API directly, the same way the
// website does in a browser. It manages a chat session, the PoW challenge
// (solved in WASM), and an optional WAF cookie.
type WebClient struct {
	BaseURL      string
	Token        string
	CookieHeader string
	client       *http.Client
	solver       *WasmSolver
	solverMu     sync.Mutex
	chatSession  string
	parentMsgID  *string
}

// NewWebClient constructs a client. If a solver is required (most sessions)
// and WASM init fails, the client still works but PoW challenges are skipped.
func NewWebClient(auth string) *WebClient {
	return &WebClient{
		BaseURL: defaultBaseURL,
		Token:   auth,
		client:  &http.Client{Timeout: 120 * time.Second},
	}
}

func (wc *WebClient) getSolver() *WasmSolver {
	wc.solverMu.Lock()
	defer wc.solverMu.Unlock()
	if wc.solver == nil {
		s, err := NewWasmSolver()
		if err != nil {
			fmt.Fprintf(os.Stderr, "[POW] WASM solver init error: %v\n", err)
			return nil
		}
		wc.solver = s
	}
	return wc.solver
}

func (wc *WebClient) buildBaseHeaders() http.Header {
	h := http.Header{}
	h.Set("Accept", "application/json, text/plain, */*")
	h.Set("Content-Type", "application/json")
	h.Set("Origin", headerOrigin)
	h.Set("Referer", headerOrigin+"/")
	h.Set("x-app-version", appVersion)
	h.Set("x-client-locale", "en_US")
	h.Set("x-client-platform", "web")
	h.Set("x-client-timezone-offset", "10800")
	h.Set("x-client-version", clientVersion)
	h.Set("sec-fetch-dest", "empty")
	h.Set("sec-fetch-mode", "cors")
	h.Set("sec-fetch-site", "same-origin")
	if wc.Token != "" {
		h.Set("Authorization", "Bearer "+wc.Token)
	}
	if wc.CookieHeader != "" {
		h.Set("Cookie", wc.CookieHeader)
	}
	return h
}

// CreateChatSession opens a new chat session and returns the session ID.
func (wc *WebClient) CreateChatSession() (string, error) {
	url := wc.BaseURL + "/api/v0/chat_session/create"
	body := map[string]interface{}{"from": "sidebar"}
	payload, _ := json.Marshal(body)

	req, err := http.NewRequest("POST", url, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("request create: %w", err)
	}
	req.Header = wc.buildBaseHeaders()

	resp, err := wc.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("create session: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("create session status %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Data struct {
			BizData struct {
				ID          string `json:"id"`
				ChatSession struct {
					ID string `json:"id"`
				} `json:"chat_session"`
			} `json:"biz_data"`
			ChatSessionID string `json:"chat_session_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("parse create response: %w", err)
	}
	sessionID := result.Data.BizData.ChatSession.ID
	if sessionID == "" {
		sessionID = result.Data.BizData.ID
	}
	if sessionID == "" {
		sessionID = result.Data.ChatSessionID
	}
	if sessionID == "" {
		return "", fmt.Errorf("no session ID in response: %s", string(respBody))
	}
	return sessionID, nil
}

// fetchPowChallenge asks the server for a PoW challenge and solves it.
// Returns the base64-encoded JSON response header value, or "" if skipped.
func (wc *WebClient) fetchPowChallenge() string {
	url := wc.BaseURL + "/api/v0/chat/create_pow_challenge"
	payload := map[string]string{"target_path": "/api/v0/chat/completion"}
	data, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		return ""
	}
	req.Header = wc.buildBaseHeaders()

	resp, err := wc.client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[POW] request error: %v\n", err)
		return ""
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return ""
	}

	var result struct {
		Data struct {
			BizData struct {
				Challenge struct {
					Algorithm  string `json:"algorithm"`
					Challenge  string `json:"challenge"`
					Salt       string `json:"salt"`
					Difficulty int    `json:"difficulty"`
					ExpireAt   int64  `json:"expire_at"`
					Signature  string `json:"signature"`
					TargetPath string `json:"target_path"`
				} `json:"challenge"`
			} `json:"biz_data"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return ""
	}

	ch := result.Data.BizData.Challenge
	if ch.Challenge == "" || ch.Algorithm != "DeepSeekHashV1" {
		return ""
	}

	solver := wc.getSolver()
	if solver == nil {
		return ""
	}

	powResult, solveErr := solver.Solve(ch.Challenge, ch.Salt, ch.ExpireAt, ch.Difficulty, ch.Signature, ch.TargetPath)
	if solveErr != nil {
		fmt.Fprintf(os.Stderr, "[POW] solve error: %v\n", solveErr)
		return ""
	}
	return powResult
}

func generateClientStreamID() string {
	now := time.Now()
	b := make([]byte, 8)
	rand.Read(b)
	return fmt.Sprintf("%04d%02d%02d-%x", now.Year(), now.Month(), now.Day(), b)
}

// ChatCompletionStream sends a streaming completion request and invokes the
// handler for each parsed event. The responseMessageID is captured for the
// caller to chain follow-up requests.
func (wc *WebClient) ChatCompletionStream(opts CompletionOpts, handler StreamHandler) (string, error) {
	url := wc.BaseURL + "/api/v0/chat/completion"

	// Resolve model_type and feature flags. Callers can pass either the
	// legacy Model string (e.g. "expert" or "default") or a fully-decomposed
	// Spec. We honour Spec when its model_type is non-empty; otherwise we
	// fall back to parsing Model as a friendly name.
	spec := opts.Spec
	if spec.ModelType == "" {
		if opts.Model != "" {
			spec = ParseModelName(opts.Model)
		} else {
			spec = ModelSpec{ModelType: "default"}
		}
	}

	clientStreamID := generateClientStreamID()
	powHeader := wc.fetchPowChallenge()

	payload := map[string]interface{}{
		"chat_session_id":  opts.SessionID,
		"prompt":           opts.Prompt,
		"model_type":       spec.ModelType,
		"stream":           true,
		"ref_file_ids":     []string{},
		"thinking_enabled": spec.ThinkingEnabled,
		"search_enabled":   spec.SearchEnabled,
		"preempt":          false,
		"client_stream_id": clientStreamID,
	}
	if opts.ParentMsgID != nil && *opts.ParentMsgID != "" {
		var id int64
		fmt.Sscanf(*opts.ParentMsgID, "%d", &id)
		if id > 0 {
			payload["parent_message_id"] = id
		}
	}
	data, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("request completion: %w", err)
	}
	req.Header = wc.buildBaseHeaders()
	req.Header.Set("x-client-stream-id", clientStreamID)
	if powHeader != "" {
		req.Header.Set("x-ds-pow-response", powHeader)
	}

	resp, err := wc.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("chat completion: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("completion status %d: %s", resp.StatusCode, string(body))
	}

	var lastID string
	parseSSE(resp.Body, func(event StreamEvent) {
		if event.Event == "content" {
			handler(event)
		} else if event.Event == "debug" {
			fmt.Fprintf(os.Stderr, "[DEBUG] %s\n", event.Data)
		} else if event.Event == "message_id" {
			lastID = event.Data
		}
	})

	return lastID, nil
}

func parseSSE(r io.Reader, handler StreamHandler) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}

		// Try to capture response_message_id from any data line.
		var probe map[string]interface{}
		if json.Unmarshal([]byte(data), &probe) == nil {
			if rid, ok := probe["response_message_id"].(float64); ok {
				handler(StreamEvent{Event: "message_id", Data: fmt.Sprintf("%.0f", rid)})
			}
		}

		if content := parseDeepSeekSseData(data); content != "" {
			handler(StreamEvent{Event: "content", Data: content})
		}
	}
}

func parseDeepSeekSseData(dataStr string) string {
	var data map[string]interface{}
	if err := json.Unmarshal([]byte(dataStr), &data); err != nil {
		return ""
	}

	if v, ok := data["v"].(map[string]interface{}); ok {
		if resp, ok := v["response"].(map[string]interface{}); ok {
			if frags, ok := resp["fragments"].([]interface{}); ok {
				for _, f := range frags {
					if frag, ok := f.(map[string]interface{}); ok {
						if content, _ := frag["content"].(string); content != "" {
							return content
						}
					}
				}
			}
		}
	}

	if p, _ := data["p"].(string); p == "response/fragments" && data["o"] == "APPEND" {
		if arr, ok := data["v"].([]interface{}); ok {
			for _, item := range arr {
				if frag, ok := item.(map[string]interface{}); ok {
					if content, _ := frag["content"].(string); content != "" {
						return content
					}
				}
			}
		}
	}

	if p, _ := data["p"].(string); strings.HasSuffix(p, "/content") {
		if v, ok := data["v"].(string); ok && v != "" {
			return v
		}
	}

	if v, ok := data["v"].(string); ok && v != "" {
		return v
	}

	if choices, ok := data["choices"].([]interface{}); ok && len(choices) > 0 {
		if choice, ok := choices[0].(map[string]interface{}); ok {
			if delta, ok := choice["delta"].(map[string]interface{}); ok {
				if content, ok := delta["content"].(string); ok && content != "" {
					return content
				}
			}
		}
	}

	return ""
}

// Compile-time interface check.
var _ api.APIClient = (*Client)(nil)
var _ api.Provider = (*Provider)(nil)
