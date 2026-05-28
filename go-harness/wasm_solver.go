package main

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

//go:embed sha3_wasm_bg.wasm
var wasmBytes []byte

// WasmSolver wraps the WASM PoW solver.
type WasmSolver struct {
	runtime wazero.Runtime
	module  api.Module
}

// NewWasmSolver creates and initializes a WASM solver.
func NewWasmSolver() (*WasmSolver, error) {
	ctx := context.Background()
	r := wazero.NewRuntime(ctx)

	// Instantiate the WASM module
	mod, err := r.Instantiate(ctx, wasmBytes)
	if err != nil {
		return nil, fmt.Errorf("instantiate WASM: %w", err)
	}

	return &WasmSolver{
		runtime: r,
		module:  mod,
	}, nil
}

// Close cleans up the WASM runtime.
func (s *WasmSolver) Close() error {
	ctx := context.Background()
	return s.runtime.Close(ctx)
}

// Solve computes the PoW nonce using the WASM solver.
// Returns the base64-encoded JSON response.
func (s *WasmSolver) Solve(challenge, salt string, expireAt int64, difficulty int, signature, targetPath string) (string, error) {
	ctx := context.Background()

	// Get required functions
	addToStackPtr := s.module.ExportedFunction("__wbindgen_add_to_stack_pointer")
	export0 := s.module.ExportedFunction("__wbindgen_export_0")
	solveFn := s.module.ExportedFunction("wasm_solve")

	if addToStackPtr == nil || export0 == nil || solveFn == nil {
		return "", fmt.Errorf("WASM missing required exports")
	}

	// Allocate stack space for return values (-16 = allocate 16 bytes)
	// Use math.MaxUint32 - 15 for -16 (two's complement)
	retptrResults, err := addToStackPtr.Call(ctx, uint64(math.MaxUint32-15))
	if err != nil {
		return "", fmt.Errorf("add_to_stack_pointer: %w", err)
	}
	retptr := uint32(retptrResults[0])

	defer func() {
		// Restore stack pointer (+16)
		addToStackPtr.Call(ctx, 16)
	}()

	// Prepare strings
	prefix := fmt.Sprintf("%s_%d_", salt, expireAt)
	challengeBytes := []byte(challenge)
	prefixBytes := []byte(prefix)

	// Allocate memory for challenge string
	challengePtrResults, err := export0.Call(ctx, uint64(len(challengeBytes)), 1)
	if err != nil {
		return "", fmt.Errorf("alloc challenge: %w", err)
	}
	challengePtr := uint32(challengePtrResults[0])

	// Allocate memory for prefix string
	prefixPtrResults, err := export0.Call(ctx, uint64(len(prefixBytes)), 1)
	if err != nil {
		return "", fmt.Errorf("alloc prefix: %w", err)
	}
	prefixPtr := uint32(prefixPtrResults[0])

	// Write challenge bytes to WASM memory
	mem := s.module.Memory()
	if !mem.Write(challengePtr, challengeBytes) {
		return "", fmt.Errorf("write challenge to WASM memory failed")
	}
	if !mem.Write(prefixPtr, prefixBytes) {
		return "", fmt.Errorf("write prefix to WASM memory failed")
	}

	// Call wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)
	// difficulty is f64 in WASM, so we need to pass it as float64 bits
	_, err = solveFn.Call(ctx,
		uint64(retptr),
		uint64(challengePtr),
		uint64(len(challengeBytes)),
		uint64(prefixPtr),
		uint64(len(prefixBytes)),
		math.Float64bits(float64(difficulty)),
	)
	if err != nil {
		return "", fmt.Errorf("wasm_solve: %w", err)
	}

	// Read result: status (i32) at retptr, answer (f64) at retptr+8
	statusBytes, ok := mem.Read(retptr, 4)
	if !ok {
		return "", fmt.Errorf("read status from WASM memory failed")
	}
	status := int32(statusBytes[0]) | int32(statusBytes[1])<<8 | int32(statusBytes[2])<<16 | int32(statusBytes[3])<<24

	if status == 0 {
		return "", fmt.Errorf("PoW solver returned no solution")
	}

	answerBytes, ok := mem.Read(retptr+8, 8)
	if !ok {
		return "", fmt.Errorf("read answer from WASM memory failed")
	}
	// Interpret as float64 (little-endian)
	bits := uint64(answerBytes[0]) | uint64(answerBytes[1])<<8 | uint64(answerBytes[2])<<16 | uint64(answerBytes[3])<<24 |
		uint64(answerBytes[4])<<32 | uint64(answerBytes[5])<<40 | uint64(answerBytes[6])<<48 | uint64(answerBytes[7])<<56
	answerFloat := math.Float64frombits(bits)
	answer := int(math.Round(answerFloat))

	// Build result JSON
	result := map[string]interface{}{
		"algorithm": "DeepSeekHashV1",
		"challenge": challenge,
		"salt":      salt,
		"answer":    answer,
		"signature": signature,
	}
	if targetPath != "" {
		result["target_path"] = targetPath
	}

	data, err := json.Marshal(result)
	if err != nil {
		return "", fmt.Errorf("marshal result: %w", err)
	}

	return base64.StdEncoding.EncodeToString(data), nil
}
