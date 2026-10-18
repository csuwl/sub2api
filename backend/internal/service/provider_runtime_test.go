//go:build unit

package service

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/openai_compat"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func runtimeTestAccount() *Account {
	a := forceChatResponsesFallbackAccount()
	a.Credentials[ProviderRuntimeAccountCredential] = "fixture-account"
	a.Credentials["provider_runtime_protocol"] = APIProtocolChatCompletions
	return a
}

func TestProviderRuntimeRoundTrip(t *testing.T) {
	key := strings.Repeat("k", 32)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/accounts/fixture-account/chat/completions", r.URL.Path)
		require.Equal(t, "Bearer "+key, r.Header.Get("Authorization"))
		require.Empty(t, r.Header.Get("Cookie"))
		require.Empty(t, r.Header.Get("X-Api-Key"))
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.JSONEq(t, `{"model":"fixture"}`, string(body))
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "must-not-reach-client")
		w.Header().Set("X-Sub2api-Secret", "must-not-reach-client")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":{"type":"insufficient_quota","code":14018}}`)
	}))
	defer server.Close()
	cfg := &config.Config{ProviderRuntime: config.ProviderRuntimeConfig{Enabled: true, BaseURL: server.URL, Token: key}}
	req := httptest.NewRequest(http.MethodPost, "https://ordinary-upstream.invalid/v1/chat/completions", strings.NewReader(`{"model":"fixture"}`))
	req.Header.Set("Cookie", "original-cookie")
	req.Header.Set("X-Api-Key", "original-key")
	response, handled, err := ProviderRuntimeRoundTrip(req, runtimeTestAccount(), cfg)
	require.True(t, handled)
	require.NoError(t, err)
	defer func() { _ = response.Body.Close() }()
	require.Equal(t, http.StatusForbidden, response.StatusCode)
	require.Empty(t, response.Header.Get("Set-Cookie"))
	require.Empty(t, response.Header.Get("X-Sub2api-Secret"))
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Contains(t, string(body), "14018")
	require.Equal(t, "ordinary-upstream.invalid", req.URL.Host)
}

func TestProviderRuntimeBindingFailsClosed(t *testing.T) {
	for _, name := range []string{"disabled", "invalid-id", "wrong-platform", "wrong-type", "unsupported-endpoint"} {
		t.Run(name, func(t *testing.T) {
			account := runtimeTestAccount()
			cfg := &config.Config{ProviderRuntime: config.ProviderRuntimeConfig{Enabled: true, BaseURL: "http://127.0.0.1:1", Token: strings.Repeat("k", 32)}}
			endpoint := "/v1/chat/completions"
			switch name {
			case "disabled":
				cfg.ProviderRuntime.Enabled = false
			case "invalid-id":
				account.Credentials[ProviderRuntimeAccountCredential] = "../other"
			case "wrong-platform":
				account.Platform = PlatformAnthropic
			case "wrong-type":
				account.Type = AccountTypeOAuth
			case "unsupported-endpoint":
				endpoint = "/v1/images/generations"
			}
			request := httptest.NewRequest(http.MethodPost, "https://ordinary.invalid"+endpoint, nil)
			response, handled, err := ProviderRuntimeRoundTrip(request, account, cfg)
			require.True(t, handled)
			require.Error(t, err)
			require.Nil(t, response)
		})
	}
	response, handled, err := ProviderRuntimeRoundTrip(httptest.NewRequest(http.MethodPost, "https://ordinary.invalid/v1/chat/completions", nil), rawChatCompletionsTestAccount(), nil)
	require.False(t, handled)
	require.NoError(t, err)
	require.Nil(t, response)
}

func TestProviderRuntimeCancellation(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done(); close(cancelled) }))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := httptest.NewRequest(http.MethodPost, "https://ordinary.invalid/v1/chat/completions", nil).WithContext(ctx)
	cfg := &config.Config{ProviderRuntime: config.ProviderRuntimeConfig{Enabled: true, BaseURL: server.URL, Token: strings.Repeat("k", 32)}}
	done := make(chan error, 1)
	go func() { _, _, err := ProviderRuntimeRoundTrip(request, runtimeTestAccount(), cfg); done <- err }()
	<-started
	cancel()
	require.ErrorIs(t, <-done, context.Canceled)
	<-cancelled
}

func TestProviderRuntimeProtocolIgnoresResponsesProbe(t *testing.T) {
	for _, protocol := range []string{APIProtocolChatCompletions, APIProtocolResponses, APIProtocolAnthropic} {
		account := runtimeTestAccount()
		account.Credentials["provider_runtime_protocol"] = protocol
		require.Equal(t, protocol, resolveUpstreamProtocol(account, APIProtocolResponses, "", nil))
		require.Equal(t, protocol, account.GetAPIProtocol())
	}
}

func TestProviderRuntimeNoRedirect(t *testing.T) {
	called := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	cfg := &config.Config{ProviderRuntime: config.ProviderRuntimeConfig{Enabled: true, BaseURL: server.URL, Token: strings.Repeat("k", 32)}}
	req := httptest.NewRequest(http.MethodPost, "https://ordinary.invalid/v1/chat/completions", bytes.NewReader(nil))
	res, handled, err := ProviderRuntimeRoundTrip(req, runtimeTestAccount(), cfg)
	require.True(t, handled)
	require.NoError(t, err)
	defer func() { _ = res.Body.Close() }()
	require.Equal(t, http.StatusTemporaryRedirect, res.StatusCode)
	require.False(t, called)
}

func TestProviderRuntimeProbeUsesDeclaredProtocolWithoutNetwork(t *testing.T) {
	for _, protocol := range []string{APIProtocolResponses, APIProtocolChatCompletions, APIProtocolAnthropic} {
		account := runtimeTestAccount()
		account.Credentials["provider_runtime_protocol"] = protocol
		updates := make(chan map[string]any, 1)
		repo := &snapshotUpdateAccountRepo{stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: []Account{*account}}, updateExtraCalls: updates}
		svc := &AccountTestService{accountRepo: repo}
		svc.ProbeOpenAIAPIKeyResponsesSupport(context.Background(), account.ID)
		require.Equal(t, protocol == APIProtocolResponses, (<-updates)[openai_compat.ExtraKeyResponsesSupported])
	}
}

func TestProviderRuntimePreservesConversationIdentity(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	headers := make(http.Header)
	applyOpenCodeSessionHeader(c, runtimeTestAccount(), "https://provider-runtime.invalid/v1/chat/completions", headers, []byte(`{"prompt_cache_key":"fixture-session"}`))
	require.Equal(t, "fixture-session", headers.Get("X-Session-Id"))
	applyOpenCodeSessionHeader(c, rawChatCompletionsTestAccount(), "https://ordinary.example/v1/chat/completions", make(http.Header), nil)
}
