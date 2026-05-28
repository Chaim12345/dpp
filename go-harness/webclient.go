package main

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
)

func LoadAuth() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}

	tokenFile := filepath.Join(home, ".deepseek", "deepseek_token.txt")
	data, err := os.ReadFile(tokenFile)
	if err == nil {
		t := strings.TrimSpace(string(data))
		if t != "" {
			return t
		}
	}

	authFile := filepath.Join(home, ".deepseek", "auth.json")
	data, err = os.ReadFile(authFile)
	if err != nil {
		return ""
	}
	var authObj struct {
		Origins []struct {
			LocalStorage []struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			} `json:"localStorage"`
		} `json:"origins"`
	}
	if err := json.Unmarshal(data, &authObj); err != nil {
		return ""
	}
	for _, origin := range authObj.Origins {
		for _, ls := range origin.LocalStorage {
			if ls.Key == "token" || ls.Key == "ds_token" || ls.Key == "deepseek_token" {
				return ls.Value
			}
		}
	}
	return ""
}

type WebClient struct {
	BaseURL     string
	Token       string
	CookieHeader string
	client      *http.Client
	solver      *WasmSolver
	solverMu    sync.Mutex
}

func NewWebClient(auth string) *WebClient {
	return &WebClient{
		BaseURL: "https://chat.deepseek.com",
		Token:   auth,
		client:  &http.Client{Timeout: 120 * time.Second},
	}
}

// getSolver returns a cached WASM solver instance.
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
	h.Set("Origin", "https://chat.deepseek.com")
	h.Set("Referer", "https://chat.deepseek.com/")
	h.Set("x-app-version", "20241129.1")
	h.Set("x-client-locale", "en_US")
	h.Set("x-client-platform", "web")
	h.Set("x-client-timezone-offset", "10800")
	h.Set("x-client-version", "2.0.0")
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
		fmt.Fprintf(os.Stderr, "[POW] status=%d\n", resp.StatusCode)
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

	fmt.Fprintf(os.Stderr, "[POW] solved\n")
	return powResult
}

type CompletionOpts struct {
	SessionID    string
	ParentMsgID  *string
	Prompt       string
	Model        string
}

type StreamEvent struct {
	Event string
	Data  string
}

type StreamHandler func(event StreamEvent)

type MessageIDTracker struct {
	ResponseMessageID string
}

func generateClientStreamID() string {
	now := time.Now()
	b := make([]byte, 8)
	rand.Read(b)
	return fmt.Sprintf("%04d%02d%02d-%x", now.Year(), now.Month(), now.Day(), b)
}

func (wc *WebClient) ChatCompletionStream(opts CompletionOpts, handler StreamHandler) error {
	url := wc.BaseURL + "/api/v0/chat/completion"

	modelType := opts.Model
	if modelType == "" {
		modelType = "default"
	}

	clientStreamID := generateClientStreamID()
	powHeader := wc.fetchPowChallenge()

	payload := map[string]interface{}{
		"chat_session_id":  opts.SessionID,
		"prompt":           opts.Prompt,
		"model_type":       modelType,
		"stream":           true,
		"ref_file_ids":     []string{},
		"thinking_enabled": false,
		"search_enabled":   false,
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
		return fmt.Errorf("request completion: %w", err)
	}
	req.Header = wc.buildBaseHeaders()
	req.Header.Set("x-client-stream-id", clientStreamID)
	if powHeader != "" {
		req.Header.Set("x-ds-pow-response", powHeader)
	}

	resp, err := wc.client.Do(req)
	if err != nil {
		return fmt.Errorf("chat completion: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("completion status %d: %s", resp.StatusCode, string(body))
	}

	tracker := &MessageIDTracker{}
	parseSSE(resp.Body, handler, tracker)

	if tracker.ResponseMessageID != "" && opts.ParentMsgID != nil {
		*opts.ParentMsgID = tracker.ResponseMessageID
	}
	return nil
}

func parseSSE(r io.Reader, handler StreamHandler, tracker *MessageIDTracker) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	lastFragmentType := ""

	for scanner.Scan() {
		line := scanner.Text()

		if !strings.HasPrefix(line, "data:") {
			continue
		}

		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))

		if data == "[DONE]" {
			break
		}

		if tracker != nil && tracker.ResponseMessageID == "" {
			var msgData map[string]interface{}
			if json.Unmarshal([]byte(data), &msgData) == nil {
				if rid, ok := msgData["response_message_id"].(float64); ok {
					tracker.ResponseMessageID = fmt.Sprintf("%.0f", rid)
				}
			}
		}

		if content := parseDeepSeekSseData(data, &lastFragmentType); content != "" {
			handler(StreamEvent{Event: "content", Data: content})
		}
	}
}

func parseDeepSeekSseData(dataStr string, lastFragmentType *string) string {
	var data map[string]interface{}
	if err := json.Unmarshal([]byte(dataStr), &data); err != nil {
		return ""
	}

	// Fragment setup
	if v, ok := data["v"].(map[string]interface{}); ok {
		if resp, ok := v["response"].(map[string]interface{}); ok {
			if frags, ok := resp["fragments"].([]interface{}); ok {
				for _, f := range frags {
					if frag, ok := f.(map[string]interface{}); ok {
						fragType, _ := frag["type"].(string)
						content, _ := frag["content"].(string)
						if content != "" {
							*lastFragmentType = fragType
							return content
						}
					}
				}
			}
		}
	}

	// Fragment APPEND
	if p, _ := data["p"].(string); p == "response/fragments" && data["o"] == "APPEND" {
		if arr, ok := data["v"].([]interface{}); ok {
			for _, item := range arr {
				if frag, ok := item.(map[string]interface{}); ok {
					fragType, _ := frag["type"].(string)
					content, _ := frag["content"].(string)
					if content != "" {
						*lastFragmentType = fragType
						return content
					}
				}
			}
		}
	}

	// Content/thinking APPEND
	if p, _ := data["p"].(string); strings.HasSuffix(p, "/content") {
		if v, ok := data["v"].(string); ok && v != "" {
			return v
		}
	}

	// Simple v-string
	if v, ok := data["v"].(string); ok && v != "" {
		return v
	}

	// OpenAI-style
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
