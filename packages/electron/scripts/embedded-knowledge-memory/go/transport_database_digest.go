// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package memoryindex

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"gorm.io/gorm"
)

func transportQuoteIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// Full-file rollback needs authority over every persisted table, including other
// consumers and virtual-table shadow storage. Virtual tables are derived views
// of that shadow storage and must not be scanned twice. Only this operation's
// receipt is excluded, so its transaction can bind the post-state without a
// self-referential digest. Existing receipt rows remain part of the hash.
func transportFullDatabaseDigest(tx *gorm.DB, request TransportRequest) (string, error) {
	h := sha256.New()
	transportFrame(h, []byte("hy-transport-full-database-v1"))
	for _, pragma := range []string{"user_version", "application_id", "schema_version", "encoding", "page_size", "auto_vacuum"} {
		if err := transportSQLHash(tx, h, "PRAGMA "+pragma); err != nil {
			return "", err
		}
	}
	if err := transportSQLHash(tx, h, `SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY type COLLATE BINARY,name COLLATE BINARY`); err != nil {
		return "", err
	}
	var tables []struct {
		Name string
		WR   int
	}
	if err := tx.Raw(`SELECT name,wr FROM pragma_table_list WHERE schema='main' AND type IN ('table','shadow') AND name<>'sqlite_schema' ORDER BY name COLLATE BINARY`).Scan(&tables).Error; err != nil {
		return "", err
	}
	for _, table := range tables {
		var columns []struct {
			Name   string
			PK     int
			Hidden int
		}
		if err := tx.Raw(`SELECT name,pk,hidden FROM pragma_table_xinfo(?) ORDER BY cid`, table.Name).Scan(&columns).Error; err != nil {
			return "", err
		}
		var fields, order []string
		names := map[string]bool{}
		for _, column := range columns {
			names[strings.ToLower(column.Name)] = true
		}
		if table.WR == 0 {
			var alias string
			for _, candidate := range []string{"_rowid_", "rowid", "oid"} {
				if !names[candidate] {
					alias = candidate
					break
				}
			}
			if alias == "" {
				return "", errTransport
			}
			fields = append(fields, "+"+transportQuoteIdentifier(alias))
			order = append(order, transportQuoteIdentifier(alias))
		} else {
			keys := append([]struct {
				Name   string
				PK     int
				Hidden int
			}{}, columns...)
			sort.Slice(keys, func(i, j int) bool { return keys[i].PK < keys[j].PK })
			for _, column := range keys {
				if column.PK > 0 {
					order = append(order, transportQuoteIdentifier(column.Name)+" COLLATE BINARY")
				}
			}
			if len(order) == 0 {
				return "", errTransport
			}
		}
		for _, column := range columns {
			if column.Hidden == 2 {
				continue
			} // A virtual generated column is not persisted.
			name := transportQuoteIdentifier(column.Name)
			// Unary plus removes declared-type metadata, preventing the SQLite driver
			// from normalizing DATETIME text to time.Time before hashing its raw value.
			fields = append(fields, "typeof("+name+")", "+"+name)
		}
		query := "SELECT " + strings.Join(fields, ",") + " FROM " + transportQuoteIdentifier(table.Name)
		var args []interface{}
		if table.Name == "hy_memory_receipts" {
			query += " WHERE NOT(tenant_id IS ? AND kb_id IS ? AND namespace IS ? AND idempotency_key IS ?)"
			args = []interface{}{request.TenantID, request.KBID, transportLedgerNamespace, request.OperationID}
		}
		query += " ORDER BY " + strings.Join(order, ",")
		if err := transportSQLHash(tx, h, query, args...); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
