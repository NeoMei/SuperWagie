// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package memoryindex

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"os"
	"path/filepath"
	"sync"

	modelruntime "github.com/Tencent/WeKnora/internal/models/runtime"
	sqlitevec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var transportVecOnce sync.Once

// ExecuteTransportRequest is the process boundary. Preview/snapshot/verify open
// SQLite read-only; apply opens an existing file and never initializes schema.
// The host attests process shutdown and restored backup before calling apply.
func ExecuteTransportRequest(ctx context.Context, r TransportRequest) (TransportResponse, error) {
	rejected := func() (TransportResponse, error) { return TransportResponse{}, errTransport }
	if !filepath.IsAbs(r.Database) || !filepath.IsAbs(r.ConfigDir) {
		return rejected()
	}
	database, e := filepath.EvalSymlinks(r.Database)
	if e != nil {
		return rejected()
	}
	info, e := os.Stat(database)
	if e != nil || !info.Mode().IsRegular() {
		return rejected()
	}
	// Read exactly the catalog bytes used for resolution. The request pins the
	// deployment overlay; the executable/build receipt pins built-in catalogs.
	data, base, e := modelruntime.ReadDeploymentOverlay(r.ConfigDir)
	if e != nil {
		return rejected()
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	if r.CatalogDigest != "" && r.CatalogDigest != digest {
		return rejected()
	}
	r.CatalogDigest = digest
	if data != nil {
		if modelruntime.Reload(data, base) != nil {
			return rejected()
		}
	}
	transportVecOnce.Do(sqlitevec.Auto)
	uri := url.URL{Scheme: "file", Path: database}
	q := url.Values{"mode": {"ro"}, "_query_only": {"1"}, "_foreign_keys": {"1"}, "_busy_timeout": {"0"}}
	if r.Mode != "apply" {
		// mode=ro alone can create WAL/SHM sidecars. The offline snapshot contract
		// requires a checkpointed database, allowing immutable reads with zero writes.
		wal, walErr := os.Stat(database + "-wal")
		if walErr != nil && !os.IsNotExist(walErr) || walErr == nil && wal.Size() != 0 {
			return rejected()
		}
		q.Set("immutable", "1")
	}
	if r.Mode == "apply" {
		q.Set("mode", "rw")
		q.Del("_query_only")
	}
	uri.RawQuery = q.Encode()
	db, e := gorm.Open(sqlite.Open(uri.String()), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent), DisableAutomaticPing: true})
	if e != nil {
		return rejected()
	}
	connection, e := db.DB()
	if e != nil {
		return rejected()
	}
	defer connection.Close()
	connection.SetMaxOpenConns(1)
	result, e := RunTransportMigration(ctx, db, r)
	if e != nil {
		return rejected()
	}
	return result, nil
}
