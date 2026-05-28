package main

import (
	"encoding/json"
	"strings"
)

type Detector struct {
	buffer string
}

func (d *Detector) Feed(chunk string) []ToolCall {
	d.buffer += chunk
	return extractToolCalls(d.buffer)
}

func (d *Detector) Flush() string {
	text := stripToolCalls(d.buffer)
	d.buffer = ""
	return text
}

func (d *Detector) Reset() { d.buffer = "" }

func extractJsonBlock(text string, startIdx int) string {
	depth, inStr := 0, false
	for i := startIdx; i < len(text); i++ {
		c := text[i]
		if inStr {
			if c == 92 { i++; continue }
			if c == 34 { inStr = false }
			continue
		}
		if c == 34 { inStr = true; continue }
		if c == 123 { depth++ }
		if c == 125 { depth--; if depth == 0 { return text[startIdx : i+1] } }
	}
	return ""
}

func normalizeToolArgs(m map[string]interface{}) map[string]interface{} {
	if args, ok := m["arguments"]; ok {
		switch a := args.(type) {
		case map[string]interface{}: return a
		case string:
			var p map[string]interface{}
			if json.Unmarshal([]byte(a), &p) == nil { return p }
		}
	}
	if fn, ok := m["function"].(map[string]interface{}); ok {
		if args, ok := fn["arguments"]; ok {
			switch a := args.(type) {
			case map[string]interface{}: return a
			case string:
				var p map[string]interface{}
				if json.Unmarshal([]byte(a), &p) == nil { return p }
			}
		}
	}
	return make(map[string]interface{})
}

var knownTools = map[string]bool{
	"read": true, "write": true, "edit": true, "bash": true,
	"grep": true, "glob": true, "ls": true,
}

func extractToolCalls(text string) []ToolCall {
	if len(text) == 0 || strings.Count(text, "<tool_calls>") > 50 { return nil }
	for _, fn := range []func(string) []ToolCall{
		extractJsonToolCalls, extractXmlToolCalls, extractCodeBlockToolCalls,
		extractSingleJsonToolCalls, extractReactToolCalls, extractFunctionCallToolCalls,
	} {
		if calls := fn(text); len(calls) > 0 { return calls }
	}
	return nil
}

func extractJsonToolCalls(text string) []ToolCall {
	startIdx := -1
	for _, p := range []string{`{"tool_calls"`, `{"_calls"`} {
		if idx := strings.Index(text, p); idx != -1 { startIdx = idx; break }
	}
	if startIdx == -1 { return nil }
	jsonStr := extractJsonBlock(text, startIdx)
	if jsonStr == "" { return nil }
	var parsed map[string]interface{}
	if json.Unmarshal([]byte(jsonStr), &parsed) != nil { return nil }
	var arr []interface{}
	if tc, ok := parsed["tool_calls"].([]interface{}); ok { arr = tc }
	if arr == nil { if tc, ok := parsed["_calls"].([]interface{}); ok { arr = tc } }
	if len(arr) == 0 { return nil }
	var calls []ToolCall
	for _, c := range arr {
		m, ok := c.(map[string]interface{})
		if !ok { continue }
		name := ""
		if n, ok := m["name"].(string); ok { name = n }
		if name == "" { if fn, ok := m["function"].(map[string]interface{}); ok { if n, ok := fn["name"].(string); ok { name = n } } }
		if !knownTools[name] { continue }
		calls = append(calls, ToolCall{Name: name, Arguments: normalizeToolArgs(m)})
	}
	return calls
}

func extractSingleJsonToolCalls(text string) []ToolCall {
	startIdx := strings.Index(text, `{"tool"`)
	if startIdx == -1 { return nil }
	jsonStr := extractJsonBlock(text, startIdx)
	if jsonStr == "" { return nil }
	var parsed map[string]interface{}
	if json.Unmarshal([]byte(jsonStr), &parsed) != nil { return nil }
	name, ok := parsed["tool"].(string)
	if !ok || !knownTools[name] { return nil }
	args := make(map[string]interface{})
	for k, v := range parsed { if k != "tool" { args[k] = v } }
	return []ToolCall{{Name: name, Arguments: args}}
}
