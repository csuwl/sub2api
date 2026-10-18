package config

import (
	"strings"
	"testing"
)

func TestProviderRuntimeConfig(t *testing.T) {
	base := ProviderRuntimeConfig{Enabled: true, BaseURL: "http://127.0.0.1:3426", Token: strings.Repeat("k", 32)}
	for _, tc := range []struct {
		name, url, token          string
		insecure, disabled, valid bool
	}{
		{name: "loopback", url: base.BaseURL, token: base.Token, valid: true},
		{name: "ipv6", url: "http://[::1]:3426", token: base.Token, valid: true},
		{name: "https", url: "https://runtime.example", token: base.Token, valid: true},
		{name: "private-network-opt-in", url: "http://provider-runtime:3426", token: base.Token, insecure: true, valid: true},
		{name: "http-remote", url: "http://runtime.example", token: base.Token},
		{name: "credentials", url: "https://user:password@runtime.example", token: base.Token},
		{name: "path", url: "http://127.0.0.1:3426/admin", token: base.Token},
		{name: "query", url: "https://runtime.example?token=value", token: base.Token},
		{name: "short-token", url: base.BaseURL, token: "short"},
		{name: "line-break", url: base.BaseURL, token: base.Token + "\r\n"},
		{name: "disabled", disabled: true, valid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := ProviderRuntimeConfig{Enabled: !tc.disabled, BaseURL: tc.url, Token: tc.token, AllowInsecureHTTP: tc.insecure}
			if err := cfg.Validate(); (err == nil) != tc.valid {
				t.Fatalf("valid=%v, error=%v", tc.valid, err)
			}
		})
	}
}
