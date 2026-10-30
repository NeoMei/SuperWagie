// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package router

import (
	"github.com/Tencent/WeKnora/internal/memoryindex"
	"github.com/gin-gonic/gin"
)

// RegisterMemoryIndexRoutes inherits KB content authorization. API-key principals
// require retrieve for reads and ingest for writes, including their KB allow-list.
func RegisterMemoryIndexRoutes(r *gin.RouterGroup, h *memoryindex.Handler, g *rbacGuards) {
	if h == nil {
		return
	}
	write := g.apiKeyGroup(r.Group("/knowledge-bases/:id/memory-index"), apiKeyIngest(apiKeyFullAccess()))
	read := write.With(apiKeyRetrieve(apiKeyFullAccess()))
	read.GET("/capabilities", g.Viewer(), g.KBAccessRead("id"), h.Capabilities)
	read.POST("/capabilities", g.Viewer(), g.KBAccessRead("id"), h.Capabilities)
	read.POST("/state/read", g.Viewer(), g.KBAccessRead("id"), h.ReadState)
	read.POST("/nodes/get", g.Viewer(), g.KBAccessRead("id"), h.GetNodes)
	read.POST("/nodes/list", g.Viewer(), g.KBAccessRead("id"), h.ListNodes)
	read.POST("/nodes/search", g.Viewer(), g.KBAccessRead("id"), h.SearchNodes)
	read.POST("/embed", g.Viewer(), g.KBAccessRead("id"), h.Embed)
	write.POST("/state/commit", g.OwnedKBOrAdmin(), g.KBAccessWrite("id"), h.CommitState)
	write.POST("/nodes/upsert", g.OwnedKBOrAdmin(), g.KBAccessWrite("id"), h.UpsertNodes)
	write.POST("/nodes/delete", g.OwnedKBOrAdmin(), g.KBAccessWrite("id"), h.DeleteNodes)
	write.POST("/nodes/payload", g.OwnedKBOrAdmin(), g.KBAccessWrite("id"), h.PatchNodes)
}
