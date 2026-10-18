package service

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
)

const ProviderRuntimeAccountCredential = "provider_runtime_account"
const providerRuntimeReservedOrigin = "https://provider-runtime.invalid"

func (a *Account) IsProviderRuntimeAccount() bool {
	if a == nil || a.Credentials == nil {
		return false
	}
	_, bound := a.Credentials[ProviderRuntimeAccountCredential]
	return bound
}

func (a *Account) providerRuntimeProtocol() string {
	switch a.GetCredential("provider_runtime_protocol") {
	case APIProtocolAnthropic:
		return APIProtocolAnthropic
	case APIProtocolResponses:
		return APIProtocolResponses
	default:
		return APIProtocolChatCompletions
	}
}

var providerRuntimeAccountID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)

var providerRuntimeHTTPClient = &http.Client{
	Transport: func() *http.Transport {
		base, ok := http.DefaultTransport.(*http.Transport)
		if !ok {
			base = &http.Transport{}
		}
		t := base.Clone()
		t.Proxy = nil // The local host must not traverse an upstream account's proxy.
		t.ResponseHeaderTimeout = 90 * time.Second
		return t
	}(),
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
}

// ProviderRuntimeRoundTrip intercepts only explicitly bound API-key accounts.
// A broken/disabled runtime binding fails closed, rather than sending a dummy
// key or a subscription request to the account's ordinary upstream URL.
func ProviderRuntimeRoundTrip(req *http.Request, account *Account, cfg *config.Config) (*http.Response, bool, error) {
	if account == nil || account.Credentials == nil {
		return nil, false, nil
	}
	value, bound := account.Credentials[ProviderRuntimeAccountCredential]
	if !bound {
		return nil, false, nil
	}
	id, ok := value.(string)
	if !ok || !providerRuntimeAccountID.MatchString(id) || account.Platform != PlatformOpenAI || account.Type != AccountTypeAPIKey {
		return nil, true, errors.New("invalid provider runtime account binding")
	}
	if cfg == nil || !cfg.ProviderRuntime.Enabled {
		return nil, true, errors.New("provider runtime is disabled")
	}
	if err := cfg.ProviderRuntime.Validate(); err != nil {
		return nil, true, err
	}
	var endpoint string
	switch req.URL.Path {
	case "/v1/chat/completions", "/v1/responses", "/v1/messages":
		endpoint = strings.TrimPrefix(req.URL.Path, "/v1")
	default:
		return nil, true, errors.New("provider runtime supports text inference endpoints only")
	}
	u, _ := url.Parse(strings.TrimRight(cfg.ProviderRuntime.BaseURL, "/") + "/v1/accounts/" + id + endpoint)
	forward := req.Clone(req.Context())
	forward.URL, forward.Host = u, ""
	forward.RequestURI = ""
	forward.Header = runtimeHeaders(req.Header, cfg.ProviderRuntime.Token)
	resp, err := providerRuntimeHTTPClient.Do(forward)
	if err != nil {
		// Do not include URL credentials, deployment tokens or request headers.
		return nil, true, fmt.Errorf("provider runtime request failed: %w", err)
	}
	for name := range resp.Header {
		if strings.HasPrefix(strings.ToLower(name), "x-sub2api-") || strings.EqualFold(name, "set-cookie") {
			resp.Header.Del(name)
		}
	}
	return resp, true, nil
}

func runtimeHeaders(original http.Header, token string) http.Header {
	h := make(http.Header)
	for _, name := range []string{"Content-Type", "Accept", "X-Session-Id", "Session-Id", "X-Request-Id"} {
		if value := original.Get(name); value != "" {
			h.Set(name, value)
		}
	}
	h.Set("Authorization", "Bearer "+token)
	return h
}

// ProviderRuntimeAdminRequest is used only behind the existing admin middleware.
// Account IDs are opaque handles; subscription credentials remain in the host's
// encrypted store and are never returned through this management API.
func ProviderRuntimeAdminRequest(req *http.Request, cfg *config.Config) (*http.Response, error) {
	if cfg == nil || !cfg.ProviderRuntime.Enabled {
		return nil, errors.New("provider runtime is disabled")
	}
	if err := cfg.ProviderRuntime.Validate(); err != nil {
		return nil, err
	}
	u, _ := url.Parse(strings.TrimRight(cfg.ProviderRuntime.BaseURL, "/") + "/admin" + req.URL.Path)
	forward := req.Clone(req.Context())
	forward.URL, forward.Host = u, ""
	forward.RequestURI = ""
	forward.Header = runtimeHeaders(req.Header, cfg.ProviderRuntime.Token)
	return providerRuntimeHTTPClient.Do(forward)
}
