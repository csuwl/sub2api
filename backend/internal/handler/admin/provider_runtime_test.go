//go:build unit

package admin

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestProviderRuntimeManagementProxy(t *testing.T) {
	key := strings.Repeat("k", 32)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/admin/accounts", r.URL.Path)
		require.Equal(t, "Bearer "+key, r.Header.Get("Authorization"))
		require.Empty(t, r.Header.Get("Cookie"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"id":"fixture-account","connected":true}]`))
	}))
	defer upstream.Close()
	h := &AccountHandler{cfg: &config.Config{ProviderRuntime: config.ProviderRuntimeConfig{Enabled: true, BaseURL: upstream.URL, Token: key}}}
	router := gin.New()
	router.Any("/provider-runtime/*path", h.ProviderRuntime)
	request := httptest.NewRequest(http.MethodGet, "/provider-runtime/accounts", nil)
	request.Header.Set("Authorization", "Bearer downstream-admin-token")
	request.Header.Set("Cookie", "private-browser-cookie")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Contains(t, recorder.Body.String(), "fixture-account")
	require.NotContains(t, recorder.Body.String(), key)
	blocked := httptest.NewRecorder()
	router.ServeHTTP(blocked, httptest.NewRequest(http.MethodPost, "/provider-runtime/arbitrary/path", nil))
	require.Equal(t, http.StatusNotFound, blocked.Code)
}

func TestProviderRuntimeManagementDisabledStatus(t *testing.T) {
	h := &AccountHandler{}
	router := gin.New()
	router.Any("/provider-runtime/*path", h.ProviderRuntime)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/provider-runtime/status", nil))
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Contains(t, recorder.Body.String(), `"enabled":false`)
}
