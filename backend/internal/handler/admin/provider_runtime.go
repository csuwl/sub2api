package admin

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

var runtimeAdminPath = regexp.MustCompile(`^/(providers|accounts|accounts/[a-zA-Z0-9_-]{1,80}(/(authorize|poll|models|usage))?)$`)

// ProviderRuntime proxies an allowlisted management surface behind admin auth.
// Neither the deployment transport token nor provider credentials reach the UI.
func (h *AccountHandler) ProviderRuntime(c *gin.Context) {
	path := c.Param("path")
	if path == "/status" && c.Request.Method == http.MethodGet {
		response.Success(c, gin.H{"enabled": h.cfg != nil && h.cfg.ProviderRuntime.Enabled})
		return
	}
	if !runtimeAdminPath.MatchString(path) || (c.Request.Method != http.MethodGet && c.Request.Method != http.MethodPost && c.Request.Method != http.MethodDelete) {
		response.Error(c, http.StatusNotFound, "Unknown provider runtime operation")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	forward := c.Request.Clone(ctx)
	forward.URL = &url.URL{Path: path}
	forward.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024*1024)
	res, err := service.ProviderRuntimeAdminRequest(forward, h.cfg)
	if err != nil {
		response.Error(c, http.StatusBadGateway, "Provider runtime is unavailable; check its deployment and configuration")
		return
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 4*1024*1024+1))
	if err != nil || len(body) > 4*1024*1024 || !json.Valid(body) {
		response.Error(c, http.StatusBadGateway, "Invalid provider runtime response")
		return
	}
	if res.StatusCode >= 400 {
		var failure struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(body, &failure)
		if failure.Error.Message == "" {
			failure.Error.Message = "Provider runtime operation failed"
		}
		response.Error(c, res.StatusCode, failure.Error.Message)
		return
	}
	response.Success(c, json.RawMessage(body))
}
