package main

import (
	"encoding/json"
	"strings"
)

func extractXmlToolCalls(text string) []ToolCall {
	wrappers := []string{"<tool_calls>", "<function_calls>", "<_calls>"}
	for _, wrapper := range wrappers {
		endWrapper := "</" + wrapper[1:]
		si := strings.Index(text, wrapper)
		if si == -1 {
			continue
		}
		ei := strings.Index(text[si:], endWrapper)
		if ei == -1 {
			continue
		}
		ei += si
		inner := text[si+len(wrapper) : ei]
		trimmed := strings.TrimSpace(inner)
		if strings.HasPrefix(trimmed, "[") || strings.HasPrefix(trimmed, "{") {
			jsonStr := extractJsonValue(trimmed, 0)
			if jsonStr != "" {
				var parsed interface{}
				if json.Unmarshal([]byte(jsonStr), &parsed) == nil {
					if calls := parseJsonArrayToolCalls(parsed); len(calls) > 0 {
						return calls
					}
				}
			}
			var parsed interface{}
			if json.Unmarshal([]byte(trimmed), &parsed) == nil {
				if calls := parseJsonArrayToolCalls(parsed); len(calls) > 0 {
					return calls
				}
			}
		}
	}
	return nil
}

func parseJsonArrayToolCalls(parsed interface{}) []ToolCall {
	switch v := parsed.(type) {
	case []interface{}:
		var calls []ToolCall
		for _, item := range v {
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
			if !knownTools[name] {
				continue
			}
			calls = append(calls, ToolCall{Name: name, Arguments: normalizeToolArgs(m)})
		}
		return calls
	}
	return nil
}

func extractCodeBlockToolCalls(text string) []ToolCall {
	idx := 0
	for {
		start := strings.Index(text[idx:], "```")
		if start == -1 {
			break
		}
		start += idx + 3
		end := strings.Index(text[start:], "```")
		if end == -1 {
			break
		}
		inner := strings.TrimSpace(text[start : start+end])
		if !strings.HasPrefix(inner, "{") {
			idx = start + end + 3
			continue
		}
		var parsed map[string]interface{}
		if json.Unmarshal([]byte(inner), &parsed) != nil {
			idx = start + end + 3
			continue
		}
		if name, ok := parsed["tool"].(string); ok && knownTools[name] {
			args := make(map[string]interface{})
			for k, v := range parsed {
				if k != "tool" {
					args[k] = v
				}
			}
			return []ToolCall{{Name: name, Arguments: args}}
		}
		idx = start + end + 3
	}
	return nil
}

func extractReactToolCalls(text string) []ToolCall {
	lines := strings.Split(text, "\n")
	var calls []ToolCall
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "Action:") && i+1 < len(lines) {
			nextLine := strings.TrimSpace(lines[i+1])
			if strings.HasPrefix(nextLine, "Action Input:") {
				name := strings.TrimSpace(strings.TrimPrefix(trimmed, "Action:"))
				input := strings.TrimSpace(strings.TrimPrefix(nextLine, "Action Input:"))
				if !knownTools[name] {
					continue
				}
				var args map[string]interface{}
				if json.Unmarshal([]byte(input), &args) == nil {
					calls = append(calls, ToolCall{Name: name, Arguments: args})
				} else {
					calls = append(calls, ToolCall{Name: name, Arguments: map[string]interface{}{"input": input}})
				}
			}
		}
	}
	return calls
}

func extractFunctionCallToolCalls(text string) []ToolCall {
	idx := 0
	for {
		start := strings.Index(text[idx:], "<function_call")
		if start == -1 {
			break
		}
		start += idx
		endTag := "</function_call>"
		end := strings.Index(text[start:], endTag)
		if end == -1 {
			break
		}
		inner := text[start : start+end]
		nameStart := strings.Index(inner, "name=\"")
		if nameStart == -1 {
			idx = start + end + len(endTag)
			continue
		}
		nameStart += 6
		nameEnd := strings.Index(inner[nameStart:], "\"")
		if nameEnd == -1 {
			idx = start + end + len(endTag)
			continue
		}
		name := inner[nameStart : nameStart+nameEnd]
		if !knownTools[name] {
			idx = start + end + len(endTag)
			continue
		}
		args := make(map[string]interface{})
		calls := []ToolCall{{Name: name, Arguments: args}}
		idx = start + end + len(endTag)
		return calls
	}
	return nil
}

func stripToolCalls(text string) string {
	result := text
	for _, wrapper := range []string{"<tool_calls>", "<function_calls>", "<_calls>"} {
		endWrapper := "</" + wrapper[1:]
		for {
			si := strings.Index(result, wrapper)
			if si == -1 {
				break
			}
			ei := strings.Index(result[si:], endWrapper)
			if ei == -1 {
				result = result[:si]
				break
			}
			ei += si
			result = result[:si] + result[ei+len(endWrapper):]
		}
	}
	lines := strings.Split(result, "\n")
	var cleaned []string
	skipNext := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "Action:") {
			skipNext = true
			continue
		}
		if skipNext && strings.HasPrefix(trimmed, "Action Input:") {
			skipNext = false
			continue
		}
		skipNext = false
		cleaned = append(cleaned, line)
	}
	return strings.TrimSpace(strings.Join(cleaned, "\n"))
}
