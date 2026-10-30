// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package router

import (
	"bytes"
	"context"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/Tencent/WeKnora/internal/config"
	"github.com/Tencent/WeKnora/internal/memoryindex"
	"github.com/Tencent/WeKnora/internal/middleware"
	"github.com/Tencent/WeKnora/internal/types"
	sqlitevec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type memoryKBFixture struct{ kb *types.KnowledgeBase }

func (m memoryKBFixture) GetKnowledgeBaseByID(context.Context, string) (*types.KnowledgeBase, error) {
	return m.kb, nil
}
func TestMemoryIndexRouteAuthorizationAndWikiIndependence(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sqlitevec.Auto()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "memory.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
	require.NoError(t, db.Exec(`CREATE TABLE knowledge_bases(id TEXT PRIMARY KEY,tenant_id INTEGER NOT NULL,deleted_at DATETIME)`).Error)
	require.NoError(t, db.Exec(`INSERT INTO knowledge_bases(id,tenant_id) VALUES('kb',1)`).Error)
	h := memoryindex.NewHandler(db, nil)
	store, err := memoryindex.NewStore(db)
	require.NoError(t, err)
	require.NoError(t, store.BindSpace(context.Background(), memoryindex.Scope{Tenant: 1, KB: "kb"}, "space", "model", 2))
	enforce := true
	kb := &types.KnowledgeBase{ID: "kb", TenantID: 1, CreatorID: "creator", IndexingStrategy: types.IndexingStrategy{WikiEnabled: true}}
	for _, tt := range []struct {
		name, operation, body string
		role                  types.TenantRole
		callerTenant          uint64
		scope                 *types.TenantAPIKeyScope
		want                  int
	}{
		{name: "capabilities use scoped read policy", operation: "capabilities", body: `{}`, role: types.TenantRoleViewer, callerTenant: 1, scope: &types.TenantAPIKeyScope{KnowledgeBaseIDs: types.StringArray{"kb"}, Capabilities: types.StringArray{"retrieve"}}, want: 200},
		{name: "retrieve key reads", operation: "state/read", body: `{"namespace":"p"}`, role: types.TenantRoleViewer, callerTenant: 1, scope: &types.TenantAPIKeyScope{KnowledgeBaseIDs: types.StringArray{"kb"}, Capabilities: types.StringArray{"retrieve"}}, want: 200},
		{name: "retrieve key cannot mutate", operation: "state/commit", body: `{"namespace":"p","expected_revision":0,"idempotency_key":"a","mutations":[]}`, role: types.TenantRoleViewer, callerTenant: 1, scope: &types.TenantAPIKeyScope{KnowledgeBaseIDs: types.StringArray{"kb"}, Capabilities: types.StringArray{"retrieve"}}, want: 403},
		{name: "ingest key writes wiki KB", operation: "nodes/upsert", body: `{"namespace":"p","space_id":"space","nodes":[{"id":"memory","content":"memoryword","vector":[1,0],"payload":{"workspace_id":"p"},"active":true}]}`, role: types.TenantRoleViewer, callerTenant: 1, scope: &types.TenantAPIKeyScope{KnowledgeBaseIDs: types.StringArray{"kb"}, Capabilities: types.StringArray{"ingest"}}, want: 200},
		{name: "KB allowlist cannot be widened by namespace", operation: "state/read", body: `{"namespace":"kb"}`, role: types.TenantRoleAdmin, callerTenant: 1, scope: &types.TenantAPIKeyScope{KnowledgeBaseIDs: types.StringArray{"different-kb"}, Capabilities: types.StringArray{"retrieve"}}, want: 403},
		{name: "viewer cannot mutate", operation: "state/commit", body: `{"namespace":"p","expected_revision":0,"idempotency_key":"a","mutations":[]}`, role: types.TenantRoleViewer, callerTenant: 1, want: 403},
		{name: "noncreator contributor cannot mutate", operation: "state/commit", body: `{"namespace":"p","expected_revision":0,"idempotency_key":"a","mutations":[]}`, role: types.TenantRoleContributor, callerTenant: 1, want: 403},
		{name: "other tenant cannot read", operation: "state/read", body: `{"namespace":"p"}`, role: types.TenantRoleAdmin, callerTenant: 2, want: 403},
	} {
		t.Run(tt.name, func(t *testing.T) {
			g := &rbacGuards{cfg: &config.Config{Tenant: &config.TenantConfig{EnableRBAC: &enforce}}, kbService: memoryKBFixture{kb}, kbCreator: func(*gin.Context) (string, error) { return "creator", nil }, apiKeyAuthorizer: middleware.NewAPIKeyRouteAuthorizer()}
			router := gin.New()
			router.Use(middleware.ErrorHandler())
			v1 := router.Group("/api/v1")
			v1.Use(func(c *gin.Context) {
				ctx := context.WithValue(c.Request.Context(), types.TenantIDContextKey, tt.callerTenant)
				ctx = types.WithCaller(ctx, types.Caller{TenantID: tt.callerTenant, UserID: "another-user", Role: tt.role})
				if tt.scope != nil {
					ctx = types.WithTenantAPIKeyScope(ctx, *tt.scope)
				}
				c.Request = c.Request.WithContext(ctx)
			})
			v1.Use(g.apiKeyAuthorizer.Middleware())
			RegisterMemoryIndexRoutes(v1, h, g)
			g.assertAPIKeyPoliciesMatchRoutes(router)
			response := httptest.NewRecorder()
			request := httptest.NewRequest("POST", "/api/v1/knowledge-bases/kb/memory-index/"+tt.operation, bytes.NewBufferString(tt.body))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(response, request)
			require.Equal(t, tt.want, response.Code, response.Body.String())
		})
	}
}
