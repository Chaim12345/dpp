package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func ExecuteTool(name string, args map[string]interface{}) ToolResult {
	switch name {
	case "read":
		return toolRead(args)
	case "write":
		return toolWrite(args)
	case "edit":
		return toolEdit(args)
	case "bash":
		return toolBash(args)
	case "grep":
		return toolGrep(args)
	case "glob":
		return toolGlob(args)
	case "ls":
		return toolLs(args)
	default:
		return ToolResult{Content: fmt.Sprintf("Unknown tool: %s", name), IsError: true}
	}
}

func getString(m map[string]interface{}, key string, def string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return def
}

func getInt(m map[string]interface{}, key string, def int) int {
	if v, ok := m[key]; ok {
		switch n := v.(type) {
		case float64:
			return int(n)
		case int:
			return n
		}
	}
	return def
}

func toolRead(args map[string]interface{}) ToolResult {
	path := getString(args, "path", "")
	if path == "" {
		if paths, ok := args["paths"].([]interface{}); ok && len(paths) > 0 {
			var b strings.Builder
			for _, p := range paths {
				if ps, ok := p.(string); ok {
					data, err := os.ReadFile(ps)
					if err != nil {
						b.WriteString(fmt.Sprintf("--- %s: %v ---\n", ps, err))
					} else {
						b.WriteString(fmt.Sprintf("--- %s ---\n%s\n", ps, string(data)))
					}
				}
			}
			return ToolResult{Content: b.String(), IsError: false}
		}
		return ToolResult{Content: "missing 'path' argument", IsError: true}
	}

	f, err := os.Open(path)
	if err != nil {
		return ToolResult{Content: fmt.Sprintf("error: %v", err), IsError: true}
	}
	defer f.Close()

	offset := getInt(args, "offset", 0)
	limit := getInt(args, "limit", 0)

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	lineNum := 0
	startLine := offset
	var b strings.Builder
	count := 0

	for scanner.Scan() {
		lineNum++
		if lineNum < startLine+1 {
			continue
		}
		if limit > 0 && count >= limit {
			break
		}
		b.WriteString(fmt.Sprintf("%d: %s\n", lineNum, scanner.Text()))
		count++
	}
	if err := scanner.Err(); err != nil {
		return ToolResult{Content: fmt.Sprintf("read error: %v", err), IsError: true}
	}
	return ToolResult{Content: b.String(), IsError: false}
}

func toolWrite(args map[string]interface{}) ToolResult {
	path := getString(args, "path", "")
	content := getString(args, "content", "")
	if path == "" {
		return ToolResult{Content: "missing 'path' argument", IsError: true}
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return ToolResult{Content: fmt.Sprintf("mkdir error: %v", err), IsError: true}
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return ToolResult{Content: fmt.Sprintf("write error: %v", err), IsError: true}
	}
	return ToolResult{Content: fmt.Sprintf("wrote %d bytes to %s", len(content), path), IsError: false}
}

func toolEdit(args map[string]interface{}) ToolResult {
	path := getString(args, "path", "")
	old := getString(args, "old", "")
	new := getString(args, "new", "")
	// Support old_string/new_string too
	if old == "" {
		old = getString(args, "old_string", "")
	}
	if new == "" {
		new = getString(args, "new_string", "")
	}
	if path == "" || old == "" {
		return ToolResult{Content: "missing 'path' or 'old' argument", IsError: true}
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return ToolResult{Content: fmt.Sprintf("read error: %v", err), IsError: true}
	}
	content := string(data)
	idx := strings.Index(content, old)
	if idx == -1 {
		return ToolResult{Content: "old string not found in file", IsError: true}
	}
	updated := content[:idx] + new + content[idx+len(old):]
	if err := os.WriteFile(path, []byte(updated), 0644); err != nil {
		return ToolResult{Content: fmt.Sprintf("write error: %v", err), IsError: true}
	}
	return ToolResult{Content: "edit applied", IsError: false}
}

func toolBash(args map[string]interface{}) ToolResult {
	command := getString(args, "command", "")
	cwd := getString(args, "cwd", "")
	if command == "" {
		return ToolResult{Content: "missing 'command' argument", IsError: true}
	}

	timeout := 30 * time.Second
	if t, ok := args["timeout"].(float64); ok && t > 0 {
		timeout = time.Duration(t) * time.Second
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-c", command)
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Env = os.Environ()

	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	var out strings.Builder
	if stdout.Len() > 0 {
		out.WriteString(stdout.String())
	}
	if stderr.Len() > 0 {
		if out.Len() > 0 {
			out.WriteString("\n")
		}
		out.WriteString(stderr.String())
	}
	if ctx.Err() == context.DeadlineExceeded {
		return ToolResult{Content: fmt.Sprintf("command timed out after %v", timeout), IsError: true}
	}
	if err != nil {
		return ToolResult{Content: fmt.Sprintf("%s\nexit error: %v", out.String(), err), IsError: true}
	}
	return ToolResult{Content: out.String(), IsError: false}
}

func toolGrep(args map[string]interface{}) ToolResult {
	pattern := getString(args, "pattern", "")
	path := getString(args, "path", ".")
	flags := getString(args, "flags", "")
	if pattern == "" {
		return ToolResult{Content: "missing 'pattern' argument", IsError: true}
	}

	parts := []string{"rg", "-n", "--no-heading"}
	if flags != "" {
		for _, f := range strings.Fields(flags) {
			parts = append(parts, f)
		}
	}
	parts = append(parts, pattern, path)

	cmd := exec.Command(parts[0], parts[1:]...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()

	var out strings.Builder
	if stdout.Len() > 0 {
		out.WriteString(stdout.String())
	}
	if stderr.Len() > 0 {
		out.WriteString(stderr.String())
	}
	if err != nil {
		if stdout.Len() == 0 {
			return ToolResult{Content: fmt.Sprintf("grep error: %v\n%s", err, out.String()), IsError: true}
		}
	}
	return ToolResult{Content: out.String(), IsError: false}
}

func toolGlob(args map[string]interface{}) ToolResult {
	pattern := getString(args, "pattern", "")
	if pattern == "" {
		return ToolResult{Content: "missing 'pattern' argument", IsError: true}
	}

	if strings.Contains(pattern, "**") {
		dir := filepath.Dir(pattern)
		if dir == "." {
			dir = "."
		}
		suffix := strings.TrimPrefix(pattern, "**/")
		if suffix == pattern {
			suffix = strings.TrimPrefix(pattern, "**")
		}
		var files []string
		err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				return nil
			}
			matched, _ := filepath.Match(filepath.Base(suffix), d.Name())
			if matched {
				files = append(files, path)
			}
			return nil
		})
		if err != nil {
			return ToolResult{Content: fmt.Sprintf("walk error: %v", err), IsError: true}
		}
		var b strings.Builder
		for _, f := range files {
			b.WriteString(f + "\n")
		}
		return ToolResult{Content: b.String(), IsError: false}
	}

	matches, err := filepath.Glob(pattern)
	if err != nil {
		return ToolResult{Content: fmt.Sprintf("glob error: %v", err), IsError: true}
	}
	var b strings.Builder
	for _, m := range matches {
		b.WriteString(m + "\n")
	}
	return ToolResult{Content: b.String(), IsError: false}
}

func toolLs(args map[string]interface{}) ToolResult {
	path := getString(args, "path", ".")
	entries, err := os.ReadDir(path)
	if err != nil {
		return ToolResult{Content: fmt.Sprintf("ls error: %v", err), IsError: true}
	}
	var b strings.Builder
	for _, e := range entries {
		if e.IsDir() {
			b.WriteString(e.Name() + "/\n")
		} else {
			b.WriteString(e.Name() + "\n")
		}
	}
	return ToolResult{Content: b.String(), IsError: false}
}
