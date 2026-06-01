package deepseek

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

// WasmSolver wraps the WASM PoW solver bundled with the package.
type WasmSolver struct {
	runtime wazero.Runtime
	module  api.Module
}

// NewWasmSolver instantiates the embedded WASM module.
func NewWasmSolver() (*WasmSolver, error) {
	ctx := context.Background()
	r := wazero.NewRuntime(ctx)

	mod, err := r.Instantiate(ctx, wasmBytes)
	if err != nil {
		return nil, fmt.Errorf("instantiate WASM: %w", err)
	}
	return &WasmSolver{runtime: r, module: mod}, nil
}

// Close releases the WASM runtime.
func (s *WasmSolver) Close() error {
	ctx := context.Background()
	return s.runtime.Close(ctx)
}

// Solve computes the PoW nonce. Returns the base64-encoded JSON response.
func (s *WasmSolver) Solve(challenge, salt string, expireAt int64, difficulty int, signature, targetPath string) (string, error) {
	ctx := context.Background()

	addToStackPtr := s.module.ExportedFunction("__wbindgen_add_to_stack_pointer")
	export0 := s.module.ExportedFunction("__wbindgen_export_0")
	solveFn := s.module.ExportedFunction("wasm_solve")

	if addToStackPtr == nil || export0 == nil || solveFn == nil {
		return "", fmt.Errorf("WASM missing required exports")
	}

	retptrResults, err := addToStackPtr.Call(ctx, uint64(math.MaxUint32-15))
	if err != nil {
		return "", fmt.Errorf("add_to_stack_pointer: %w", err)
	}
	retptr := uint32(retptrResults[0])

	defer func() {
		addToStackPtr.Call(ctx, 16)
	}()

	prefix := fmt.Sprintf("%s_%d_", salt, expireAt)
	challengeBytes := []byte(challenge)
	prefixBytes := []byte(prefix)

	challengePtrResults, err := export0.Call(ctx, uint64(len(challengeBytes)), 1)
	if err != nil {
		return "", fmt.Errorf("alloc challenge: %w", err)
	}
	challengePtr := uint32(challengePtrResults[0])

	prefixPtrResults, err := export0.Call(ctx, uint64(len(prefixBytes)), 1)
	if err != nil {
		return "", fmt.Errorf("alloc prefix: %w", err)
	}
	prefixPtr := uint32(prefixPtrResults[0])

	mem := s.module.Memory()
	if !mem.Write(challengePtr, challengeBytes) {
		return "", fmt.Errorf("write challenge to WASM memory failed")
	}
	if !mem.Write(prefixPtr, prefixBytes) {
		return "", fmt.Errorf("write prefix to WASM memory failed")
	}

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
	bits := uint64(answerBytes[0]) | uint64(answerBytes[1])<<8 | uint64(answerBytes[2])<<16 | uint64(answerBytes[3])<<24 |
		uint64(answerBytes[4])<<32 | uint64(answerBytes[5])<<40 | uint64(answerBytes[6])<<48 | uint64(answerBytes[7])<<56
	answerFloat := math.Float64frombits(bits)
	answer := int(math.Round(answerFloat))

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
