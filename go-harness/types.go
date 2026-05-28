package main

// HarnessState holds persistent session state across turns.
type HarnessState struct {
	ChatSessionID    string
	ParentMessageID  string
	MemorySummary    string
	AuthToken        string
	CookieHeader     string
}

// ToolCall represents a detected tool invocation.
type ToolCall struct {
	Name      string
	Arguments map[string]interface{}
}

// ToolResult is what ExecuteTool returns.
type ToolResult struct {
	Content string
	IsError bool
}
