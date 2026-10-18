package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

// Use the same bound provider transport as gateway inference. Placeholder
// account credentials are never an upstream address or an authorization token.
func (s *AccountTestService) testProviderRuntimeAccountConnection(c *gin.Context, account *Account, modelID, prompt, mode string) error {
	if normalizeAccountTestMode(mode) == AccountTestModeCompact {
		return s.sendErrorAndEnd(c, "Subscription provider accounts do not support the OpenAI compaction probe")
	}
	if strings.TrimSpace(modelID) == "" {
		models := make([]string, 0)
		for id := range account.GetModelMapping() {
			if !strings.Contains(id, "*") {
				models = append(models, id)
			}
		}
		sort.Strings(models)
		if len(models) == 0 {
			return s.sendErrorAndEnd(c, "Select an imported provider model before testing")
		}
		modelID = models[0]
	}
	modelID = account.GetMappedModel(modelID)
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		prompt = "Reply with a short greeting."
	}
	protocol := account.providerRuntimeProtocol()
	endpoint := "/v1/chat/completions"
	payload := createOpenAIChatCompletionsTestPayload(modelID, prompt)
	payload["max_tokens"] = 512
	switch protocol {
	case APIProtocolResponses:
		endpoint = "/v1/responses"
		payload = map[string]any{"model": modelID, "input": prompt, "stream": true, "max_output_tokens": 512}
	case APIProtocolAnthropic:
		endpoint = "/v1/messages"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return s.sendErrorAndEnd(c, "Failed to build provider test request")
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, providerRuntimeReservedOrigin+endpoint, bytes.NewReader(body))
	if err != nil {
		return s.sendErrorAndEnd(c, "Failed to build provider test request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	s.sendEvent(c, TestEvent{Type: "test_start", Model: modelID})
	resp, handled, err := ProviderRuntimeRoundTrip(req, account, s.cfg)
	if err != nil {
		return s.sendErrorAndEnd(c, fmt.Sprintf("Provider test request failed: %s", err))
	}
	if !handled || resp == nil {
		return s.sendErrorAndEnd(c, "Provider account is not bound to a request transport")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		return s.sendErrorAndEnd(c, fmt.Sprintf("Provider returned %d: %s", resp.StatusCode, body))
	}
	if !strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
		return s.sendErrorAndEnd(c, "Provider test expected a streaming response")
	}
	switch protocol {
	case APIProtocolResponses:
		return s.processOpenAIStream(c, resp.Body)
	case APIProtocolAnthropic:
		if err := s.processCNProviderAdaptiveAnthropicStream(c, resp.Body); err != nil {
			return err
		}
		s.sendEvent(c, TestEvent{Type: "test_complete", Success: true})
		return nil
	default:
		return s.processOpenAIChatCompletionsStream(c, resp.Body)
	}
}
