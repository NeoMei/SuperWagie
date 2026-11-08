// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package memoryindex

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/Tencent/WeKnora/internal/middleware"
	"github.com/Tencent/WeKnora/internal/models/embedding"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/Tencent/WeKnora/internal/utils"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type transportProtocolModel struct{ model *types.Model }

func (m transportProtocolModel) GetModelByID(context.Context, string) (*types.Model, error) {
	return m.model, nil
}
func (m transportProtocolModel) GetEmbeddingModel(context.Context, string) (embedding.Embedder, error) {
	return embedding.NewEmbedder(embedding.ConfigFromModel(m.model, "", ""), nil, nil)
}

func TestTransportNativeProtocolPreservesTenItemCeiling(t *testing.T) {
	t.Setenv("SSRF_WHITELIST", "127.0.0.1")
	utils.ResetSSRFWhitelistForTest()
	t.Cleanup(utils.ResetSSRFWhitelistForTest)
	for _, count := range []int{11, 32, 100} {
		t.Run(strconv.Itoa(count), func(t *testing.T) {
			store, r := transportFixture(t)
			r = preparedTransport(t, store, r)
			_, err := RunTransportMigration(context.Background(), store.db, r)
			require.NoError(t, err)
			var model types.Model
			require.NoError(t, store.db.Where("id=?", "model").Take(&model).Error)
			var received []string
			var sizes []int
			failSecond := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				var body map[string]json.RawMessage
				require.NoError(t, json.NewDecoder(req.Body).Decode(&body))
				require.Equal(t, "/v1/embeddings", req.URL.Path)
				require.Equal(t, "Bearer new-secret", req.Header.Get("Authorization"))
				var name, encoding string
				require.NoError(t, json.Unmarshal(body["model"], &name))
				require.Equal(t, "text-embedding-v4", name)
				require.NoError(t, json.Unmarshal(body["encoding_format"], &encoding))
				require.Equal(t, "float", encoding)
				require.NotContains(t, body, "input_type")
				require.NotContains(t, body, "instruction")
				var inputs []string
				require.NoError(t, json.Unmarshal(body["input"], &inputs))
				sizes = append(sizes, len(inputs))
				received = append(received, inputs...)
				if failSecond && len(sizes) == 2 {
					w.WriteHeader(400)
					return
				}
				data := []map[string]any{}
				for i, text := range inputs {
					var position int
					_, err := fmt.Sscanf(text, "text-%d-中文", &position)
					require.NoError(t, err)
					vector := make([]float32, 1024)
					vector[0] = float32(position + 1)
					data = append(data, map[string]any{"index": i, "embedding": vector})
				}
				require.NoError(t, json.NewEncoder(w).Encode(map[string]any{"data": data}))
			}))
			defer server.Close()
			// Redirect only this test's HTTP transport to a local recording endpoint.
			model.Parameters.BaseURL = server.URL + "/v1"
			embedder, err := embedding.NewEmbedder(embedding.ConfigFromModel(&model, "", ""), nil, nil)
			require.NoError(t, err)
			texts := make([]string, count)
			for i := range texts {
				texts[i] = fmt.Sprintf("text-%d-中文", i)
			}
			vectors, err := embedder.BatchEmbed(context.Background(), texts)
			require.NoError(t, err)
			require.Equal(t, texts, received)
			require.Len(t, sizes, (count+9)/10)
			for i, size := range sizes {
				require.Equal(t, min(10, count-i*10), size)
			}
			require.Len(t, vectors, count)
			for i, v := range vectors {
				require.Len(t, v, 1024)
				require.Equal(t, float32(i+1), v[0])
			}
			// The real handler must not bind or publish any ledger change after a partial HTTP failure.
			received = nil
			sizes = nil
			failSecond = true
			var spacesBefore, revisionBefore int64
			require.NoError(t, store.db.Raw("SELECT count(*) FROM hy_memory_spaces").Scan(&spacesBefore).Error)
			require.NoError(t, store.db.Raw("SELECT revision FROM hy_memory_namespaces WHERE namespace='superwagie:memory'").Scan(&revisionBefore).Error)
			h := &Handler{store: store, models: transportProtocolModel{&model}}
			gin.SetMode(gin.TestMode)
			router := gin.New()
			router.Use(func(c *gin.Context) {
				c.Set(middleware.KBAccessContextKey, &middleware.KBAccess{KnowledgeBase: &types.KnowledgeBase{ID: "kb", TenantID: 1, EmbeddingModelID: "model"}, EffectiveTenantID: 1, Permission: types.OrgRoleAdmin})
				c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), types.TenantIDContextKey, uint64(1)))
			})
			router.POST("/knowledge-bases/:id/memory-index/embed", h.Embed)
			body, err := json.Marshal(map[string]any{"texts": texts, "input_role": "document"})
			require.NoError(t, err)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest("POST", "/knowledge-bases/kb/memory-index/embed", bytes.NewReader(body)))
			require.NotEqual(t, 200, response.Code)
			require.Equal(t, []int{10, min(10, count-10)}, sizes)
			var spacesAfter, revisionAfter int64
			require.NoError(t, store.db.Raw("SELECT count(*) FROM hy_memory_spaces").Scan(&spacesAfter).Error)
			require.NoError(t, store.db.Raw("SELECT revision FROM hy_memory_namespaces WHERE namespace='superwagie:memory'").Scan(&revisionAfter).Error)
			require.Equal(t, spacesBefore, spacesAfter)
			require.Equal(t, revisionBefore, revisionAfter)
		})
	}
}
