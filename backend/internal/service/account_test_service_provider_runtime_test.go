//go:build unit

package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

func TestProviderRuntimeAdminAccountTest(t *testing.T) {
	for _, tc := range []struct{ protocol, endpoint, stream string }{
		{APIProtocolChatCompletions, "chat/completions", "data: {\"choices\":[{\"delta\":{\"content\":\"REAL_TRANSPORT_OK\"}}]}\n\ndata: [DONE]\n\n"},
		{APIProtocolResponses, "responses", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"REAL_TRANSPORT_OK\"}\n\ndata: {\"type\":\"response.completed\"}\n\n"},
		{APIProtocolAnthropic, "messages", "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"REAL_TRANSPORT_OK\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n"},
	} {
		t.Run(tc.protocol, func(t *testing.T) {
			called := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				require.Equal(t, "/v1/accounts/fixture-account/"+tc.endpoint, r.URL.Path)
				require.Equal(t, "Bearer "+strings.Repeat("k", 32), r.Header.Get("Authorization"))
				var body map[string]any
				require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
				require.Equal(t, "native-model", body["model"])
				require.Equal(t, true, body["stream"])
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte(tc.stream))
			}))
			defer server.Close()
			account := runtimeTestAccount()
			account.ID = 101
			account.Credentials["base_url"] = providerRuntimeReservedOrigin
			account.Credentials["model_mapping"] = map[string]any{"my-model": "native-model"}
			account.Credentials["provider_runtime_protocol"] = tc.protocol
			repo := &mockAccountRepoForGemini{accountsByID: map[int64]*Account{101: account}}
			svc := &AccountTestService{accountRepo: repo, cfg: &config.Config{ProviderRuntime: config.ProviderRuntimeConfig{Enabled: true, BaseURL: server.URL, Token: strings.Repeat("k", 32)}}}
			ctx, rec := newTestContext()
			// Empty model selects an imported model instead of an unrelated GPT default.
			require.NoError(t, svc.TestAccountConnection(ctx, 101, "", "Test the actual provider", ""))
			require.True(t, called)
			require.Contains(t, rec.Body.String(), "REAL_TRANSPORT_OK")
			require.Contains(t, rec.Body.String(), `"success":true`)
			require.NotContains(t, rec.Body.String(), `"type":"error"`)
		})
	}
}

func TestProviderRuntimeAdminAccountTestFailsClosed(t *testing.T) {
	for _, failure := range []string{"unauthorized", "quota", "truncated", "disabled", "compact"} {
		t.Run(failure, func(t *testing.T) {
			called := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				if failure == "truncated" {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"))
					return
				}
				code := http.StatusUnauthorized
				if failure == "quota" {
					code = http.StatusTooManyRequests
				}
				w.WriteHeader(code)
				_, _ = w.Write([]byte(`{"error":{"message":"provider rejected the request"}}`))
			}))
			defer server.Close()
			cfg := &config.Config{ProviderRuntime: config.ProviderRuntimeConfig{Enabled: failure != "disabled", BaseURL: server.URL, Token: strings.Repeat("k", 32)}}
			svc := &AccountTestService{cfg: cfg}
			ctx, rec := newTestContext()
			mode := ""
			if failure == "compact" {
				mode = AccountTestModeCompact
			}
			require.Error(t, svc.testProviderRuntimeAccountConnection(ctx, runtimeTestAccount(), "model", "", mode))
			require.Contains(t, rec.Body.String(), `"type":"error"`)
			require.NotContains(t, rec.Body.String(), `"success":true`)
			require.Equal(t, failure != "disabled" && failure != "compact", called)
		})
	}
}
