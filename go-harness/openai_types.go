package main

import "encoding/json"

type OpenAIToolCall struct {
	ID       string                `json:"id"`
	Type     string                `json:"type"`
	Function OpenAIToolCallFunction `json:"function"`
}

type OpenAIToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type OpenAIChatMessage struct {
	Role       string             `json:"role"`
	Content    interface{}        `json:"content"`
	Name       string             `json:"name,omitempty"`
	ToolCalls  []OpenAIToolCall   `json:"tool_calls,omitempty"`
	ToolCallID string             `json:"tool_call_id,omitempty"`
}

type OpenAIChatRequest struct {
	Model       string              `json:"model"`
	Messages    []OpenAIChatMessage `json:"messages"`
	Stream      bool                `json:"stream"`
	Temperature *float64            `json:"temperature,omitempty"`
	MaxTokens   *int                `json:"max_tokens,omitempty"`
	TopP        *float64            `json:"top_p,omitempty"`
	Stop        interface{}         `json:"stop,omitempty"`
	User        string              `json:"user,omitempty"`
	Tools       json.RawMessage     `json:"tools,omitempty"`
	ToolChoice  interface{}         `json:"tool_choice,omitempty"`
}

type OpenAIChatChoice struct {
	Index        int                `json:"index"`
	Message      *OpenAIChatMessage `json:"message,omitempty"`
	Delta        *OpenAIChatMessage `json:"delta,omitempty"`
	FinishReason *string            `json:"finish_reason"`
}

type OpenAIChatUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type OpenAIChatCompletion struct {
	ID      string             `json:"id"`
	Object  string             `json:"object"`
	Created int64              `json:"created"`
	Model   string             `json:"model"`
	Choices []OpenAIChatChoice `json:"choices"`
	Usage   *OpenAIChatUsage   `json:"usage,omitempty"`
}

type OpenAIErrorDetail struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code"`
}

type OpenAIError struct {
	Error OpenAIErrorDetail `json:"error"`
}

type OpenAIModel struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
}

type OpenAIModelList struct {
	Object string        `json:"object"`
	Data   []OpenAIModel `json:"data"`
}
