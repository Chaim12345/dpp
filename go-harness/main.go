package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

const systemPrompt = `You are an expert coding assistant running in a local repository. You help users by reading files, executing commands, editing code, and writing new files.

**Current directory:** %s

**Tools:**
- read: Read file contents. Args: path (required), offset, limit
- write: Write content to a file. Args: path (required), content (required)
- edit: Edit a file by replacing old text with new. Args: path (required), old (required), new (required)
- bash: Run a bash command. Args: command (required), cwd
- grep: Search file contents using ripgrep. Args: pattern (required), path, flags
- glob: Find files by pattern. Args: pattern (required)
- ls: List directory contents. Args: path

---

**Operating contract:**
1. Continue working until the user's task is actually complete.
2. Use tools for facts. Do not guess file contents, command output, or project structure.
3. After each tool result, decide the next action or provide the final answer.
4. If tool output shows an error, diagnose and continue with a corrected action.
5. Do not stop after the first tool result unless the task is complete.
6. Verify results before claiming success.

**Tool-call protocol:**
- Output exactly one JSON object when you need tools. No markdown fences.
- Do not simulate tool results. The host executes tools and returns results.
- Prefer sequential calls when later actions depend on earlier results.

**Tool-call JSON examples:**
{"tool_calls":[{"name":"bash","arguments":{"command":"ls -la"}}]}
{"tool_calls":[{"name":"read","arguments":{"path":"package.json"}}]}
{"tool_calls":[{"name":"write","arguments":{"path":"test.txt","content":"hello"}}]}
{"tool_calls":[{"name":"edit","arguments":{"path":"file.txt","old":"old","new":"new"}}]}

**Final response:**
When the task is complete, answer with a concise summary.`

func main() {
	cwd, _ := os.Getwd()
	prompt := fmt.Sprintf(systemPrompt, cwd)

	serverMode := false
	serverPort := "8080"
	for _, arg := range os.Args[1:] {
		switch arg {
		case "--server", "server":
			serverMode = true
		default:
			if strings.HasPrefix(arg, "--port=") {
				serverPort = strings.TrimPrefix(arg, "--port=")
			}
		}
	}

	auth := LoadAuth()
	if auth == "" {
		fmt.Println("Warning: no auth token found in ~/.deepseek/")
		fmt.Println("Continuing without authentication (requests may fail).")
		fmt.Println()
	}

	client := NewWebClient(auth)

	if serverMode {
		apiKey := os.Getenv("DEEPSEEK_PROXY_API_KEY")
		if apiKey != "" {
			fmt.Println("API key authentication enabled")
		} else {
			fmt.Println("No API key set (DEEPSEEK_PROXY_API_KEY), proxy will accept all requests")
		}
		fmt.Println("Starting OpenAI-compatible proxy server...")
		if err := StartOpenAIServer(client, nil, serverPort, apiKey); err != nil {
			fmt.Printf("Server error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	sessionID, err := client.CreateChatSession()
	if err != nil {
		fmt.Printf("Failed to create session: %v\n", err)
		fmt.Println("Check your auth token or network connection.")
		os.Exit(1)
	}

	fmt.Println("DeepSeek Web API Harness (Go)")
	fmt.Println("Type 'quit' to exit.")
	fmt.Printf("Session created: %s\n\n", sessionID)

	var parentMsgID string
	history := []ConversationTurn{}

	// Set up signal handling
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigChan
		fmt.Println("\nGoodbye.")
		cancel()
		os.Exit(0)
	}()

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 64*1024)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		fmt.Print("You> ")
		if !scanner.Scan() {
			fmt.Println("\nGoodbye.")
			return
		}
		input := strings.TrimSpace(scanner.Text())
		if input == "" {
			continue
		}
		if input == "quit" || input == "exit" {
			fmt.Println("Goodbye.")
			return
		}

		history = append(history, ConversationTurn{Role: "user", Content: input})

		// Build prompt with full conversation history
		fullPrompt := prompt
		for _, turn := range history {
			switch turn.Role {
			case "user":
				fullPrompt += "\n\n[User]\n" + turn.Content
			case "assistant":
				fullPrompt += "\n\n[Assistant]\n" + turn.Content
			case "tool":
				fullPrompt += "\n\n" + turn.Content
			}
		}

		var responseText strings.Builder
		fmt.Print("AI> ")

		err := client.ChatCompletionStream(
			CompletionOpts{
				SessionID:   sessionID,
				ParentMsgID: &parentMsgID,
				Prompt:      fullPrompt,
			},
			func(event StreamEvent) {
				if event.Event == "debug" {
					fmt.Fprintf(os.Stderr, "[DEBUG] %s\n", event.Data)
					return
				}
				if event.Event == "content" {
					chunk := event.Data
					responseText.Write([]byte(chunk))
					fmt.Print(chunk)
				}
			},
		)
		if err != nil {
			fmt.Printf("\nError: %v\n", err)
			continue
		}
		fmt.Println()

		// Extract tool calls from the full response
		calls := extractToolCalls(responseText.String())
		if len(calls) > 0 {
			history = append(history, ConversationTurn{Role: "assistant", Content: responseText.String()})
			executeToolLoop(ctx, client, &sessionID, &parentMsgID, calls, &history, prompt, input)
		} else {
			history = append(history, ConversationTurn{Role: "assistant", Content: responseText.String()})
		}
		fmt.Println()
	}
}

// ConversationTurn tracks one turn in the conversation.
type ConversationTurn struct {
	Role    string // "user", "assistant", "tool"
	Content string
}

// executeToolLoop runs tool calls and feeds results back.
func executeToolLoop(ctx context.Context, client *WebClient, sessionID, parentMsgID *string, initialCalls []ToolCall, history *[]ConversationTurn, systemPrompt, basePrompt string) {
	callStack := initialCalls
	maxIterations := 5
	iteration := 0

	for len(callStack) > 0 && iteration < maxIterations {
		select {
		case <-ctx.Done():
			return
		default:
		}

		iteration++
		call := callStack[0]
		callStack = callStack[1:]

		fmt.Printf("[tool:%s] ", call.Name)
		argsJSON, _ := json.Marshal(call.Arguments)
		fmt.Printf("%s\n", argsJSON)

		result := ExecuteTool(call.Name, call.Arguments)
		if result.IsError {
			fmt.Printf("[error] %s\n", result.Content)
		} else {
			content := result.Content
			if len(content) > 2000 {
				content = content[:2000] + "\n... (truncated)"
			}
			fmt.Printf("[result] %s\n", content)
		}

		toolSummary := fmt.Sprintf("[Tool:%s]\n%s", call.Name, result.Content)
		*history = append(*history, ConversationTurn{Role: "tool", Content: toolSummary})

		// Rebuild prompt with full history
		fullPrompt := systemPrompt
		for _, turn := range *history {
			switch turn.Role {
			case "user":
				fullPrompt += "\n\n[User]\n" + turn.Content
			case "assistant":
				fullPrompt += "\n\n[Assistant]\n" + turn.Content
			case "tool":
				fullPrompt += "\n\n" + turn.Content
			}
		}
		fullPrompt += "\n\nNow continue with the next step or provide a final answer."

		var responseText strings.Builder
		fmt.Print("AI> ")

		err := client.ChatCompletionStream(
			CompletionOpts{
				SessionID:   *sessionID,
				ParentMsgID: parentMsgID,
				Prompt:      fullPrompt,
			},
			func(event StreamEvent) {
				if event.Event == "content" {
					chunk := event.Data
					responseText.Write([]byte(chunk))
					fmt.Print(chunk)
				}
			},
		)
		if err != nil {
			fmt.Printf("\nError: %v\n", err)
			return
		}
		fmt.Println()

		*history = append(*history, ConversationTurn{Role: "assistant", Content: responseText.String()})

		calls := extractToolCalls(responseText.String())
		if len(calls) > 0 {
			callStack = append(callStack, calls...)
		}
	}
}
