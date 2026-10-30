// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package memoryindex

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/Tencent/WeKnora/internal/middleware"
	"github.com/Tencent/WeKnora/internal/models/embedding"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type modelFixture struct{ model *types.Model }

func TestCapabilitiesReturnsReadOnlyEmbeddingConfigurationIdentity(t *testing.T) {
	store, _ := fixture(t)
	model := &types.Model{ID: "model", Name: "fixture", Source: types.ModelSourceRemote, Parameters: types.ModelParameters{BaseURL: "https://example.test/v1", APIKey: "private-test-key"}}
	h := &Handler{store: store, models: modelFixture{model: model}}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(middleware.KBAccessContextKey, &middleware.KBAccess{KnowledgeBase: &types.KnowledgeBase{ID: "kb", TenantID: 1, EmbeddingModelID: "model"}, EffectiveTenantID: 1, Permission: types.OrgRoleAdmin})
		c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), types.TenantIDContextKey, uint64(1)))
	})
	router.POST("/knowledge-bases/:id/memory-index/capabilities", h.Capabilities)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest("POST", "/knowledge-bases/kb/memory-index/capabilities", bytes.NewBufferString(`{}`)))
	require.Equal(t, 200, response.Code)
	_, identity, err := modelSpace(model, 0)
	require.NoError(t, err)
	require.Contains(t, response.Body.String(), identity)
	require.NotContains(t, response.Body.String(), "private-test-key")
	require.NotContains(t, response.Body.String(), "example.test")
}

func (m modelFixture) GetModelByID(context.Context, string) (*types.Model, error) {
	return m.model, nil
}
func (m modelFixture) GetEmbeddingModel(context.Context, string) (embedding.Embedder, error) {
	return embeddingFixture{}, nil
}

type embeddingFixture struct{}

func (embeddingFixture) Embed(context.Context, string) ([]float32, error) {
	return []float32{1, 0}, nil
}
func (embeddingFixture) BatchEmbed(_ context.Context, texts []string) ([][]float32, error) {
	result := [][]float32{}
	for range texts {
		result = append(result, []float32{1, 0})
	}
	return result, nil
}

type roleEmbeddingFixture struct{ embeddingFixture }

func (roleEmbeddingFixture) BatchEmbed(ctx context.Context, texts []string) ([][]float32, error) {
	value := float32(0)
	if types.IsEmbedQuery(ctx) {
		value = 1
	}
	return [][]float32{{1, value}}, nil
}

type roleModelFixture struct{ modelFixture }

func (roleModelFixture) GetEmbeddingModel(context.Context, string) (embedding.Embedder, error) {
	return roleEmbeddingFixture{}, nil
}

func TestEmbeddingUsesQueryRoleOnlyWhenRequested(t *testing.T) {
	store, _ := fixture(t)
	model := &types.Model{ID: "model", Name: "fixture", Source: types.ModelSourceRemote, Parameters: types.ModelParameters{BaseURL: "https://example.test/v1"}}
	h := &Handler{store: store, models: roleModelFixture{modelFixture{model: model}}}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(middleware.KBAccessContextKey, &middleware.KBAccess{KnowledgeBase: &types.KnowledgeBase{ID: "kb", TenantID: 1, EmbeddingModelID: "model"}, EffectiveTenantID: 1, Permission: types.OrgRoleAdmin})
		c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), types.TenantIDContextKey, uint64(1)))
	})
	router.POST("/knowledge-bases/:id/memory-index/embed", h.Embed)
	for _, tt := range []struct {
		body   string
		status int
		vector string
	}{
		{`{"texts":["text"]}`, 200, `"vectors":[[1,0]]`},
		{`{"texts":["text"],"input_role":"document"}`, 200, `"vectors":[[1,0]]`},
		{`{"texts":["text"],"input_role":"query"}`, 200, `"vectors":[[1,1]]`},
		{`{"texts":["text"],"input_role":"invalid"}`, 400, ""},
	} {
		response := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/knowledge-bases/kb/memory-index/embed", bytes.NewBufferString(tt.body))
		router.ServeHTTP(response, req)
		require.Equal(t, tt.status, response.Code)
		if tt.vector != "" {
			require.Contains(t, response.Body.String(), tt.vector)
		}
	}
}
func (embeddingFixture) GetModelName() string { return "fixture" }
func (embeddingFixture) GetModelID() string   { return "model" }
func (embeddingFixture) GetDimensions() int   { return 2 }
func (e embeddingFixture) BatchEmbedWithPool(ctx context.Context, _ embedding.Embedder, texts []string) ([][]float32, error) {
	return e.BatchEmbed(ctx, texts)
}
func TestHandlersRequireResolvedKBGrantAndStrictBodies(t *testing.T) {
	store, _ := fixture(t)
	h := &Handler{store: store}
	gin.SetMode(gin.TestMode)
	run := func(grant bool, body string) *httptest.ResponseRecorder {
		router := gin.New()
		router.Use(func(c *gin.Context) {
			if grant {
				c.Set(middleware.KBAccessContextKey, &middleware.KBAccess{KnowledgeBase: &types.KnowledgeBase{ID: "kb", TenantID: 1}, EffectiveTenantID: 1, Permission: types.OrgRoleAdmin})
				c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), types.TenantIDContextKey, uint64(1)))
			}
		})
		router.POST("/knowledge-bases/:id/memory-index/state/read", h.ReadState)
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("POST", "/knowledge-bases/kb/memory-index/state/read", bytes.NewBufferString(body))
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(recorder, request)
		return recorder
	}
	require.Equal(t, 403, run(false, `{"namespace":"p"}`).Code)
	require.Equal(t, 400, run(true, `{"namespace":"p","tenant_id":2}`).Code)
	response := run(true, `{"namespace":"p"}`)
	require.Equal(t, 200, response.Code)
	require.JSONEq(t, `{"success":true,"data":{"revision":0,"records":[]}}`, response.Body.String())
}
func TestEmbeddingBindsImmutableConfigurationAndRejectsUnboundModel(t *testing.T) {
	store, _ := fixture(t)
	model := &types.Model{ID: "model", Name: "fixture", Source: types.ModelSourceRemote, Parameters: types.ModelParameters{BaseURL: "https://example.test/v1", APIKey: "never-in-response"}}
	h := &Handler{store: store, models: modelFixture{model: model}}
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(middleware.KBAccessContextKey, &middleware.KBAccess{KnowledgeBase: &types.KnowledgeBase{ID: "kb", TenantID: 1, EmbeddingModelID: "model"}, EffectiveTenantID: 1, Permission: types.OrgRoleAdmin})
		c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), types.TenantIDContextKey, uint64(1)))
	})
	router.POST("/knowledge-bases/:id/memory-index/embed", h.Embed)
	call := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/knowledge-bases/kb/memory-index/embed", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(r, req)
		return r
	}
	first := call(`{"texts":["text"]}`)
	require.Equal(t, 200, first.Code)
	require.NotContains(t, first.Body.String(), "never-in-response")
	var result struct {
		Data struct {
			SpaceID string `json:"space_id"`
		}
	}
	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &result))
	space := result.Data.SpaceID
	require.NotEmpty(t, space)
	model.Parameters.APIKey = "rotated"
	same := call(`{"texts":["text"]}`)
	require.NoError(t, json.Unmarshal(same.Body.Bytes(), &result))
	require.Equal(t, space, result.Data.SpaceID)
	model.Name = "changed-model"
	changed := call(`{"texts":["text"]}`)
	require.NoError(t, json.Unmarshal(changed.Body.Bytes(), &result))
	require.NotEqual(t, space, result.Data.SpaceID)
	remoteSpace := result.Data.SpaceID
	model.Parameters.ExtraConfig = map[string]string{"remote_model_name": "different-wire-model"}
	remote := call(`{"texts":["text"]}`)
	require.NoError(t, json.Unmarshal(remote.Body.Bytes(), &result))
	require.NotEqual(t, remoteSpace, result.Data.SpaceID)

	require.Equal(t, 400, call(`{"texts":["text"],"model_id":"unbound-model"}`).Code)
}

type changingModelFixture struct {
	before, after *types.Model
	reads         int
}

func (m *changingModelFixture) GetModelByID(context.Context, string) (*types.Model, error) {
	m.reads++
	if m.reads > 1 {
		return m.after, nil
	}
	return m.before, nil
}
func (m *changingModelFixture) GetEmbeddingModel(context.Context, string) (embedding.Embedder, error) {
	return embeddingFixture{}, nil
}
func TestEmbeddingRejectsModelConfigurationChangedDuringCall(t *testing.T) {
	store, _ := fixture(t)
	before := &types.Model{ID: "model", Name: "fixture", Source: types.ModelSourceRemote, Parameters: types.ModelParameters{BaseURL: "https://one.example/v1"}}
	after := *before
	after.Parameters.BaseURL = "https://two.example/v1"
	h := &Handler{store: store, models: &changingModelFixture{before: before, after: &after}}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(middleware.KBAccessContextKey, &middleware.KBAccess{KnowledgeBase: &types.KnowledgeBase{ID: "kb", TenantID: 1, EmbeddingModelID: "model"}, EffectiveTenantID: 1, Permission: types.OrgRoleAdmin})
		c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), types.TenantIDContextKey, uint64(1)))
	})
	router.POST("/knowledge-bases/:id/memory-index/embed", h.Embed)
	response := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/knowledge-bases/kb/memory-index/embed", bytes.NewBufferString(`{"texts":["text"]}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, req)
	require.Equal(t, 503, response.Code)
	var spaces int64
	require.NoError(t, store.db.Raw("SELECT COUNT(*) FROM hy_memory_spaces").Scan(&spaces).Error)
	require.Zero(t, spaces)
}
