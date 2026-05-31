package main

import "testing"

func TestExtractOpenAIToolCallsXML(t *testing.T) {
	text := `I will call it.
<tool_call>
<name>get_weather</name>
<arguments>{"location":"Tokyo"}</arguments>
</tool_call>`

	calls, clean := extractOpenAIToolCalls(text)
	if len(calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(calls))
	}
	if calls[0].Function.Name != "get_weather" {
		t.Fatalf("wrong name: %s", calls[0].Function.Name)
	}
	if calls[0].Function.Arguments != `{"location":"Tokyo"}` {
		t.Fatalf("wrong args: %s", calls[0].Function.Arguments)
	}
	if clean != "I will call it." {
		t.Fatalf("unexpected clean text: %q", clean)
	}
}

func TestExtractOpenAIToolCallsJSON(t *testing.T) {
	text := `{"tool_calls":[{"name":"get_weather","arguments":{"location":"Tokyo"}}]}`

	calls, clean := extractOpenAIToolCalls(text)
	if len(calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(calls))
	}
	if calls[0].Function.Name != "get_weather" {
		t.Fatalf("wrong name: %s", calls[0].Function.Name)
	}
	if calls[0].Function.Arguments != `{"location":"Tokyo"}` {
		t.Fatalf("wrong args: %s", calls[0].Function.Arguments)
	}
	if clean != "" {
		t.Fatalf("expected empty clean text, got %q", clean)
	}
}

func TestExtractOpenAIToolCallsNestedDuplicateWrapper(t *testing.T) {
	text := `<tool_calls>[{"name":"get_weather","arguments":{"location":"Tokyo"}}]
<tool_calls>[{"name":"get_weather","arguments":{"location":"Tokyo"}}]</tool_calls>`

	calls, clean := extractOpenAIToolCalls(text)
	if len(calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(calls))
	}
	if calls[0].Function.Name != "get_weather" {
		t.Fatalf("wrong name: %s", calls[0].Function.Name)
	}
	if clean != "" {
		t.Fatalf("expected empty clean text, got %q", clean)
	}
}
