//go:build unit

package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

func TestProviderRuntimeGatewayEndToEnd(t *testing.T) {
	bun := os.Getenv("SUB2API_TEST_BUN")
	if bun == "" {
		t.Skip("set SUB2API_TEST_BUN to run the actual Bun provider host integration")
	}
	fixture, err := filepath.Abs(filepath.Join("..", "..", "..", "provider-runtime", "test", "gateway-fixture.mjs"))
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	command := exec.CommandContext(ctx, bun, fixture)
	key := strings.Repeat("fixture-", 8)
	command.Env = append(os.Environ(), "FIXTURE_RUNTIME_TOKEN="+key)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	stdout, err := command.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, command.Start())
	t.Cleanup(func() {
		cancel()
		_ = command.Wait()
		if stderr.Len() > 0 {
			t.Log(stderr.String())
		}
	})
	var ready struct {
		URL string `json:"url"`
	}
	require.NoError(t, json.NewDecoder(bufio.NewReader(stdout)).Decode(&ready))
	require.NotEmpty(t, ready.URL)
	gin.SetMode(gin.TestMode)
	for _, downstream := range []string{"responses", "anthropic"} {
		for _, stream := range []bool{false, true} {
			name := downstream + "/json"
			if stream {
				name = downstream + "/stream"
			}
			t.Run(name, func(t *testing.T) {
				cfg := rawChatCompletionsTestConfig()
				// Runtime bindings use their separately configured trusted origin;
				// placeholder accounts need no exception in the ordinary allowlist.
				cfg.Security.URLAllowlist.Enabled = true
				cfg.Security.URLAllowlist.UpstreamHosts = []string{"api.openai.com"}
				cfg.ProviderRuntime = config.ProviderRuntimeConfig{Enabled: true, BaseURL: ready.URL, Token: key}
				svc := &OpenAIGatewayService{cfg: cfg}
				account := runtimeTestAccount()
				account.Credentials["base_url"] = "https://provider-runtime.invalid"
				account.Credentials["model_mapping"] = map[string]any{"glm-5.3": "glm-5.3"}
				var first, second map[string]any
				endpoint := "/v1/responses"
				if downstream == "responses" {
					tools := []any{map[string]any{"type": "function", "name": "files.read", "description": "Read a fixture", "parameters": map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}}}}}
					first = map[string]any{"model": "glm-5.3", "stream": stream, "input": "Read the fixture", "tools": tools}
					second = map[string]any{"model": "glm-5.3", "stream": stream, "tools": tools, "input": []any{
						map[string]any{"role": "user", "content": "Read the fixture"},
						map[string]any{"type": "function_call", "call_id": "fixture-call", "name": "files.read", "arguments": `{"path":"fixture.txt"}`},
						map[string]any{"type": "function_call_output", "call_id": "fixture-call", "output": "fixture contents"},
					}}
				} else {
					endpoint = "/v1/messages"
					tools := []any{map[string]any{"name": "files.read", "description": "Read a fixture", "input_schema": map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}}}}}
					first = map[string]any{"model": "glm-5.3", "stream": stream, "max_tokens": 128, "messages": []any{map[string]any{"role": "user", "content": "Read the fixture"}}, "tools": tools}
					second = map[string]any{"model": "glm-5.3", "stream": stream, "max_tokens": 128, "tools": tools, "messages": []any{
						map[string]any{"role": "user", "content": "Read the fixture"},
						map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "fixture-call", "name": "files.read", "input": map[string]any{"path": "fixture.txt"}}}},
						map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "fixture-call", "content": "fixture contents"}}},
					}}
				}
				forward := func(body map[string]any) (string, *OpenAIForwardResult) {
					encoded, err := json.Marshal(body)
					require.NoError(t, err)
					recorder := httptest.NewRecorder()
					c, _ := gin.CreateTestContext(recorder)
					c.Request = httptest.NewRequest(http.MethodPost, endpoint, bytes.NewReader(encoded))
					c.Request.Header.Set("Content-Type", "application/json")
					var result *OpenAIForwardResult
					if downstream == "responses" {
						result, err = svc.Forward(context.Background(), c, account, encoded)
					} else {
						result, err = svc.ForwardAsAnthropic(context.Background(), c, account, encoded, "", "")
					}
					require.NoError(t, err)
					require.Equal(t, http.StatusOK, recorder.Code)
					require.NotNil(t, result)
					require.Equal(t, 12, result.Usage.InputTokens)
					require.Equal(t, 6, result.Usage.OutputTokens)
					return recorder.Body.String(), result
				}
				toolReply, _ := forward(first)
				require.Contains(t, toolReply, "files.read")
				require.Contains(t, toolReply, "fixture-call")
				answer, _ := forward(second)
				require.Contains(t, answer, "fixture completed")
				if stream {
					if downstream == "responses" {
						require.Contains(t, answer, "response.completed")
					} else {
						require.Contains(t, answer, "message_stop")
					}
				} else if downstream == "responses" {
					require.Equal(t, "response", gjson.Get(answer, "object").String())
				} else {
					require.Equal(t, "message", gjson.Get(answer, "type").String())
				}
			})
		}
	}
}
