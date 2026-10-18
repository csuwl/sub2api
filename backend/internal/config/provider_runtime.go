package config

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// ProviderRuntimeConfig connects to a separately operated OpenCode provider host.
// The transport token belongs to this deployment, never to a downstream user.
type ProviderRuntimeConfig struct {
	Enabled           bool   `mapstructure:"enabled"`
	BaseURL           string `mapstructure:"base_url"`
	Token             string `mapstructure:"token"`
	AllowInsecureHTTP bool   `mapstructure:"allow_insecure_http"`
}

func (c ProviderRuntimeConfig) Validate() error {
	if !c.Enabled {
		return nil
	}
	if len(c.Token) < 32 || strings.ContainsAny(c.Token, "\r\n") {
		return fmt.Errorf("provider_runtime.token must contain at least 32 characters and no line breaks")
	}
	u, err := url.Parse(c.BaseURL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return fmt.Errorf("provider_runtime.base_url must be an HTTP(S) origin without credentials, path, query or fragment")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return fmt.Errorf("provider_runtime.base_url must use HTTP or HTTPS")
	}
	ip := net.ParseIP(u.Hostname())
	loopback := strings.EqualFold(u.Hostname(), "localhost") || (ip != nil && ip.IsLoopback())
	if u.Scheme == "http" && !loopback && !c.AllowInsecureHTTP {
		return fmt.Errorf("provider_runtime.base_url requires HTTPS outside loopback; allow_insecure_http is only for a trusted private network")
	}
	return nil
}
