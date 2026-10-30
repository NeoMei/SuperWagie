// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package memoryindex

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"context"
	"github.com/Tencent/WeKnora/internal/middleware"
	"github.com/Tencent/WeKnora/internal/models/api"
	"github.com/Tencent/WeKnora/internal/models/embedding"
	modelruntime "github.com/Tencent/WeKnora/internal/models/runtime"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/Tencent/WeKnora/internal/types/interfaces"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type modelService interface {
	GetModelByID(context.Context, string) (*types.Model, error)
	GetEmbeddingModel(context.Context, string) (embedding.Embedder, error)
}
type Handler struct {
	store       *Store
	models      modelService
	unavailable error
}

func NewHandler(db *gorm.DB, models interfaces.ModelService) *Handler {
	store, err := NewStore(db)
	return &Handler{store: store, models: models, unavailable: err}
}
func failure(c *gin.Context, err error) {
	status, code, message := http.StatusServiceUnavailable, "memory_index_unavailable", "Memory index is unavailable"
	switch {
	case errors.Is(err, ErrInvalid):
		status, code, message = 400, "invalid_memory_index_request", "Invalid memory-index request"
	case errors.Is(err, ErrConflict):
		status, code, message = 409, "memory_revision_conflict", "Memory state revision changed"
	case errors.Is(err, ErrIdempotency):
		status, code, message = 409, "memory_idempotency_conflict", "Idempotency key belongs to another request"
	}
	c.JSON(status, gin.H{"success": false, "error": gin.H{"code": code, "message": message}})
}
func success(c *gin.Context, data interface{}) {
	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}
func (h *Handler) scope(c *gin.Context, namespace string) (Scope, bool) {
	grant, ok := middleware.KBAccessFromContext(c)
	tenant, hasTenant := types.TenantIDFromContext(c.Request.Context())
	if !ok || grant.KnowledgeBase == nil || grant.KnowledgeBase.ID != c.Param("id") || !hasTenant || tenant == 0 || tenant != grant.EffectiveTenantID || tenant != grant.KnowledgeBase.TenantID {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": gin.H{"code": "memory_index_forbidden", "message": "Knowledge-base access is required"}})
		return Scope{}, false
	}
	if h.store == nil || h.unavailable != nil {
		failure(c, ErrUnsupported)
		return Scope{}, false
	}
	scope := Scope{tenant, c.Param("id"), namespace}
	if namespace != "" {
		if err := validScope(scope); err != nil {
			failure(c, err)
			return Scope{}, false
		}
	}
	return scope, true
}
func body(c *gin.Context, target interface{}) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64*1024*1024)
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		failure(c, ErrInvalid)
		return false
	}
	var extra interface{}
	if decoder.Decode(&extra) != io.EOF {
		failure(c, ErrInvalid)
		return false
	}
	return true
}
func (h *Handler) Capabilities(c *gin.Context) {
	if _, ok := h.scope(c, ""); !ok {
		return
	}
	result := gin.H{"engine": "sqlite-vec", "version": 1, "features": []string{"cas-state", "idempotency", "atomic-index-commit", "nodes", "vectors", "fts5", "scope-before-top-k", "model-spaces"}, "max_batch": maxBatch, "max_json_bytes": maxJSON}
	result["max_commit_items"] = maxCommitItems
	result["max_record_json_bytes"] = maxRecordJSON
	grant, _ := middleware.KBAccessFromContext(c)
	if h.models != nil && grant.KnowledgeBase.EmbeddingModelID != "" {
		if model, err := h.models.GetModelByID(c.Request.Context(), grant.KnowledgeBase.EmbeddingModelID); err == nil && model != nil {
			if _, identity, err := modelSpace(model, 0); err == nil {
				result["embedding_configuration_id"] = identity
			}
		}
	}
	success(c, result)
}
func (h *Handler) ReadState(c *gin.Context) {
	var request struct {
		Namespace string `json:"namespace"`
	}
	if !body(c, &request) {
		return
	}
	scope, ok := h.scope(c, request.Namespace)
	if !ok {
		return
	}
	result, err := h.store.Read(c.Request.Context(), scope)
	if err != nil {
		failure(c, err)
		return
	}
	success(c, result)
}
func (h *Handler) CommitState(c *gin.Context) {
	var request CommitRequest
	if !body(c, &request) {
		return
	}
	scope, ok := h.scope(c, request.Namespace)
	if !ok {
		return
	}
	revision, err := h.store.Commit(c.Request.Context(), scope, request)
	if err != nil {
		failure(c, err)
		return
	}
	success(c, gin.H{"revision": revision})
}
func (h *Handler) UpsertNodes(c *gin.Context) {
	var request struct {
		Namespace string `json:"namespace"`
		SpaceID   string `json:"space_id"`
		Nodes     []Node `json:"nodes"`
	}
	if !body(c, &request) {
		return
	}
	scope, ok := h.scope(c, request.Namespace)
	if !ok {
		return
	}
	ids, err := h.store.Upsert(c.Request.Context(), scope, request.SpaceID, request.Nodes)
	if err != nil {
		failure(c, err)
		return
	}
	success(c, gin.H{"ids": ids})
}
func (h *Handler) GetNodes(c *gin.Context) {
	var request struct {
		Namespace      string   `json:"namespace"`
		SpaceID        string   `json:"space_id"`
		IDs            []string `json:"ids"`
		IncludeVectors bool     `json:"include_vectors"`
	}
	if !body(c, &request) {
		return
	}
	scope, ok := h.scope(c, request.Namespace)
	if !ok {
		return
	}
	nodes, err := h.store.Get(c.Request.Context(), scope, request.SpaceID, request.IDs, request.IncludeVectors)
	if err != nil {
		failure(c, err)
		return
	}
	success(c, gin.H{"nodes": nodes})
}
func (h *Handler) ListNodes(c *gin.Context) {
	var request ListRequest
	if !body(c, &request) {
		return
	}
	scope, ok := h.scope(c, request.Namespace)
	if !ok {
		return
	}
	nodes, total, err := h.store.List(c.Request.Context(), scope, request)
	if err != nil {
		failure(c, err)
		return
	}
	success(c, gin.H{"nodes": nodes, "total": total})
}
func (h *Handler) SearchNodes(c *gin.Context) {
	var request SearchRequest
	if !body(c, &request) {
		return
	}
	scope, ok := h.scope(c, request.Namespace)
	if !ok {
		return
	}
	nodes, err := h.store.Search(c.Request.Context(), scope, request)
	if err != nil {
		failure(c, err)
		return
	}
	success(c, gin.H{"nodes": nodes})
}
func (h *Handler) DeleteNodes(c *gin.Context) {
	var request struct {
		Namespace string   `json:"namespace"`
		SpaceID   string   `json:"space_id"`
		IDs       []string `json:"ids"`
		Filters   Filters  `json:"filters"`
	}
	if !body(c, &request) {
		return
	}
	scope, ok := h.scope(c, request.Namespace)
	if !ok {
		return
	}
	deleted, err := h.store.Delete(c.Request.Context(), scope, request.SpaceID, request.IDs, request.Filters)
	if err != nil {
		failure(c, err)
		return
	}
	success(c, gin.H{"deleted": deleted})
}
func (h *Handler) PatchNodes(c *gin.Context) {
	var request struct {
		Namespace string          `json:"namespace"`
		SpaceID   string          `json:"space_id"`
		IDs       []string        `json:"ids"`
		Patch     json.RawMessage `json:"patch"`
	}
	if !body(c, &request) {
		return
	}
	scope, ok := h.scope(c, request.Namespace)
	if !ok {
		return
	}
	updated, err := h.store.Patch(c.Request.Context(), scope, request.SpaceID, request.IDs, request.Patch)
	if err != nil {
		failure(c, err)
		return
	}
	success(c, gin.H{"updated": updated})
}
func modelSpace(model *types.Model, dim int) (string, string, error) {
	var semantic json.RawMessage
	baseURL := model.Parameters.BaseURL
	if model.Source == types.ModelSourceRemote {
		resolved, err := modelruntime.Resolve(modelruntime.Ref{Provider: model.Parameters.Provider, Model: model.Name, BaseURL: baseURL, ModelType: types.ModelTypeEmbedding, Extra: model.Parameters.ExtraConfig, Override: model.Parameters.Spec, TruncatePromptTokens: model.Parameters.EmbeddingParameters.TruncatePromptTokens})
		if err != nil {
			return "", "", err
		}
		baseURL = resolved.BaseURL
		semantic, err = json.Marshal(struct {
			RemoteModel string
			API         api.EmbeddingAPI
			Settings    api.EmbeddingsSettings
		}{resolved.RemoteModel, resolved.EmbeddingAPI, resolved.Embeddings})
		if err != nil {
			return "", "", err
		}
	}
	routing := map[string]string{}
	for _, key := range []string{"api", "remote_model_name", "api_version"} {
		if value := model.Parameters.ExtraConfig[key]; value != "" {
			routing[key] = value
		}
	}

	endpoint := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if parsed, err := url.Parse(endpoint); err == nil {
		parsed.Scheme = strings.ToLower(parsed.Scheme)
		parsed.Host = strings.ToLower(parsed.Host)
		parsed.User = nil
		parsed.RawQuery = ""
		parsed.Fragment = ""
		endpoint = parsed.String()
	}
	// Only transport and semantic configuration enters the fingerprint. Rotating credentials preserves a space.
	identity, err := json.Marshal(struct {
		Version, ID, Name, Source, Endpoint, Provider, Interface string
		Dimensions, Truncate                                     int
		Override                                                 bool
		Routing                                                  map[string]string
		Semantic                                                 json.RawMessage
	}{
		Version: "hy-text-v1", ID: model.ID, Name: model.Name, Source: string(model.Source),
		Endpoint: endpoint, Provider: model.Parameters.Provider, Interface: model.Parameters.InterfaceType,
		Dimensions: dim, Truncate: model.Parameters.EmbeddingParameters.TruncatePromptTokens,
		Override: model.Parameters.EmbeddingParameters.SupportsDimensionOverride, Routing: routing, Semantic: semantic,
	})
	if err != nil {
		return "", "", err
	}

	digest := sha256.Sum256(identity)
	fingerprint := hex.EncodeToString(digest[:])
	return "hy_" + fingerprint, fingerprint, nil
}
func (h *Handler) Embed(c *gin.Context) {
	var request struct {
		Texts     []string `json:"texts"`
		ModelID   string   `json:"model_id,omitempty"`
		InputRole string   `json:"input_role,omitempty"`
	}
	if !body(c, &request) {
		return
	}
	scope, ok := h.scope(c, "")
	if !ok {
		return
	}
	if len(request.Texts) == 0 || len(request.Texts) > maxBatch || (request.InputRole != "" && request.InputRole != "document" && request.InputRole != "query") {
		failure(c, ErrInvalid)
		return
	}
	for _, text := range request.Texts {
		if strings.TrimSpace(text) == "" || len(text) > maxJSON {
			failure(c, ErrInvalid)
			return
		}
	}
	grant, _ := middleware.KBAccessFromContext(c)
	modelID := grant.KnowledgeBase.EmbeddingModelID
	if modelID == "" || (request.ModelID != "" && request.ModelID != modelID) {
		failure(c, ErrInvalid)
		return
	}
	ctx := c.Request.Context()
	if request.InputRole == "query" {
		ctx = types.WithEmbedQuery(ctx)
	}
	model, err := h.models.GetModelByID(ctx, modelID)
	if err != nil || model == nil {
		failure(c, ErrUnsupported)
		return
	}
	_, configurationBefore, err := modelSpace(model, 0)
	if err != nil {
		failure(c, ErrUnsupported)
		return
	}
	embedder, err := h.models.GetEmbeddingModel(ctx, modelID)
	if err != nil {
		failure(c, ErrUnsupported)
		return
	}
	vectors, err := embedder.BatchEmbed(ctx, request.Texts)
	if err != nil || len(vectors) != len(request.Texts) || len(vectors) == 0 {
		failure(c, ErrUnsupported)
		return
	}
	dim := len(vectors[0])
	if dim < 1 || dim > 65536 {
		failure(c, ErrUnsupported)
		return
	}
	for _, vector := range vectors {
		if !validVector(vector, dim) {
			failure(c, ErrUnsupported)
			return
		}
	}
	latest, err := h.models.GetModelByID(ctx, modelID)
	if err != nil || latest == nil {
		failure(c, ErrUnsupported)
		return
	}
	_, configurationAfter, err := modelSpace(latest, 0)
	if err != nil || configurationAfter != configurationBefore {
		failure(c, ErrUnsupported)
		return
	}
	space, identity, err := modelSpace(model, dim)
	if err != nil {
		failure(c, ErrUnsupported)
		return
	}
	if err := h.store.BindSpace(ctx, scope, space, identity, dim); err != nil {
		failure(c, err)
		return
	}
	success(c, gin.H{"vectors": vectors, "space_id": space, "dimensions": dim})
}
