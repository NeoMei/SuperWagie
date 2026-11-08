// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package memoryindex

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func transportFixture(t *testing.T) (*Store, TransportRequest) {
	t.Helper()
	t.Setenv("SYSTEM_AES_KEY", "01234567890123456789012345678901")
	s, _ := fixture(t)
	for _, sql := range []string{
		`ALTER TABLE knowledge_bases ADD COLUMN creator_id TEXT`,
		`ALTER TABLE knowledge_bases ADD COLUMN embedding_model_id TEXT`,
		`UPDATE knowledge_bases SET creator_id='owner',embedding_model_id='model'`,
		`CREATE TABLE model_catalog_configs(id INTEGER PRIMARY KEY,version INTEGER,overlay TEXT,history TEXT)`,
		`INSERT INTO model_catalog_configs VALUES(1,0,'{"providers":{}}','[]')`,
		`CREATE TABLE users(id TEXT,tenant_id INTEGER,is_active BOOLEAN,deleted_at DATETIME)`,
		`INSERT INTO users VALUES('owner',1,1,NULL)`,
		`CREATE TABLE models(id TEXT PRIMARY KEY,tenant_id INTEGER,name TEXT,type TEXT,source TEXT,parameters TEXT,is_builtin BOOLEAN,managed_by TEXT,deleted_at DATETIME)`,
		`CREATE TABLE knowledges(id TEXT,tenant_id INTEGER,knowledge_base_id TEXT,embedding_model_id TEXT,deleted_at DATETIME)`,
		`INSERT INTO knowledges VALUES('doc',1,'kb','model',NULL)`,
		`CREATE TABLE chunks(id TEXT,knowledge_id TEXT,content TEXT)`,
		`INSERT INTO chunks VALUES('chunk','doc','unchanged document')`,
		`CREATE TABLE chunk_images(id TEXT)`, `CREATE TABLE chunk_revisions(id TEXT)`,
		`CREATE TABLE lite_embeddings(id INTEGER PRIMARY KEY,knowledge_id TEXT)`,
		`INSERT INTO lite_embeddings VALUES(1,'doc')`,
		`CREATE VIRTUAL TABLE vec_embeddings_1024 USING vec0(embedding float[1024] distance_metric=cosine)`,
	} {
		require.NoError(t, s.db.Exec(sql).Error)
	}
	params := types.ModelParameters{BaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", APIKey: "old-secret"}
	params.EmbeddingParameters.Dimension = 1024
	value, err := params.Value()
	require.NoError(t, err)
	require.NoError(t, s.db.Exec(`INSERT INTO models VALUES('model',1,'text-embedding-v4','Embedding','remote',?,0,'',NULL)`, value.([]byte)).Error)
	model := &types.Model{ID: "model", TenantID: 1, Name: "text-embedding-v4", Type: types.ModelTypeEmbedding, Source: types.ModelSourceRemote, Parameters: params}
	space, identity, err := modelSpace(model, 1024)
	require.NoError(t, err)
	_, configuration, err := modelSpace(model, 0)
	require.NoError(t, err)
	scope := Scope{Tenant: 1, KB: "kb", Namespace: "superwagie:memory"}
	require.NoError(t, s.BindSpace(context.Background(), scope, space, identity, 1024))
	vector := make([]float32, 1024)
	vector[0] = 1
	blob := make([]byte, 4096)
	blob[2] = 128
	blob[3] = 63
	require.NoError(t, s.db.Exec(`INSERT INTO vec_embeddings_1024(rowid,embedding) VALUES(1,?)`, blob).Error)
	project := "project"
	row := fmt.Sprintf(`{"projectId":%q,"collection":"model-space","id":"current","unknown":{"keep":true},"value":{"configurationId":%q,"spaceId":%q}}`, project, configuration, space)
	_, err = s.Commit(context.Background(), scope, CommitRequest{Namespace: scope.Namespace, IdempotencyKey: "seed", Mutations: []Mutation{{Collection: "meta", ID: "control", Value: json.RawMessage(`{"version":1}`)}, {Collection: "entry", ID: transportEngineID(project, "model-space", "current"), Value: json.RawMessage(row)}}})
	require.NoError(t, err)
	nodeScope := scope
	nodeScope.Namespace = transportNamespace(project) + ":core"
	_, err = s.Upsert(context.Background(), nodeScope, space, []Node{{ID: "node", Content: "private content", Payload: json.RawMessage(`{"retained": true}`), Vector: vector, Active: false}})
	require.NoError(t, err)
	params.BaseURL = "https://gateway.example/v1"
	params.Provider = "openai"
	params.APIKey = "new-secret"
	params.Spec = &types.ModelSpecOverride{Compat: map[string]any{"max_batch_size": float64(10)}}
	return s, TransportRequest{Mode: "preview", TenantID: 1, KBID: "kb", OwnerID: "owner", ModelID: "model", TargetParameters: &params}
}

func preparedTransport(t *testing.T, s *Store, r TransportRequest) TransportRequest {
	t.Helper()
	r.Mode = "preview"
	r.LedgerMutations = nil
	preview, err := RunTransportMigration(context.Background(), s.db, r)
	require.NoError(t, err)
	r.Mode = "snapshot"
	snapshot, err := RunTransportMigration(context.Background(), s.db, r)
	require.NoError(t, err)
	require.NotNil(t, snapshot.Snapshot)
	r.Mode = "apply"
	r.Expected = &preview.Preview
	r.OperationID = "migration-one"
	r.CompatibilityReceipt = strings.Repeat("a", 64)
	r.BackupReceipt = TransportBackup{SHA256: strings.Repeat("b", 64), Restored: true, BaselineDigest: preview.Preview.Digest}
	r.StoppedReceipt = TransportStopped{Stopped: true, EvidenceDigest: strings.Repeat("c", 64)}
	var authorities []TransportRecordKey
	for _, row := range snapshot.Snapshot.RawLedger.Records {
		authorities = append(authorities, TransportRecordKey{row.Collection, row.ID})
	}
	r.SelectedNodes = nil
	for _, n := range snapshot.Snapshot.ScopedNodes {
		r.SelectedNodes = append(r.SelectedNodes, TransportSelection{Namespace: n.Namespace, SourceSpaceID: n.SpaceID, NodeID: n.ID, ExpectedNodeDigest: n.Digest, TargetSpaceID: preview.Preview.Target.SpaceID, AuthorityRecordIDs: authorities})
	}

	for _, row := range snapshot.Snapshot.RawLedger.Records {
		if row.Collection != "entry" {
			continue
		}
		value := strings.ReplaceAll(strings.ReplaceAll(row.ValueRaw, preview.Preview.Current.ConfigurationID, preview.Preview.Target.ConfigurationID), preview.Preview.Current.SpaceID, preview.Preview.Target.SpaceID)
		r.LedgerMutations = append(r.LedgerMutations, TransportMutation{Collection: row.Collection, ID: row.ID, ValueRaw: value})
	}
	return r
}

func TestTransportPreviewPrivateSnapshotAndAtomicApply(t *testing.T) {
	s, r := transportFixture(t)
	before, err := RunTransportMigration(context.Background(), s.db, r)
	require.NoError(t, err)
	encoded, err := json.Marshal(before)
	require.NoError(t, err)
	for _, private := range []string{"old-secret", "new-secret", "private content", "gateway.example", "dashscope"} {
		require.NotContains(t, string(encoded), private)
	}
	require.NotEqual(t, before.Preview.Target.ConfigurationID, strings.TrimPrefix(before.Preview.Target.SpaceID, "hy_"))
	r = preparedTransport(t, s, r)
	after, err := RunTransportMigration(context.Background(), s.db, r)
	require.NoError(t, err)
	require.Equal(t, "applied", after.Status)
	require.Equal(t, before.Preview.KnowledgeDigest, after.Preview.KnowledgeDigest)
	require.Equal(t, before.Preview.SourceNodesDigest, after.Preview.SourceNodesDigest)
	var copied int
	require.NoError(t, s.db.Raw(`SELECT COUNT(*) FROM hy_memory_nodes`).Scan(&copied).Error)
	require.Equal(t, 2, copied)
	var active int
	require.NoError(t, s.db.Raw(`SELECT active FROM hy_memory_nodes WHERE space_id=?`, after.Preview.Target.SpaceID).Scan(&active).Error)
	require.Zero(t, active)
	var raw string
	require.NoError(t, s.db.Raw(`SELECT parameters FROM models WHERE id='model'`).Scan(&raw).Error)
	require.NotContains(t, raw, "new-secret")
	require.Contains(t, raw, "enc:v1:")
	var decoded types.ModelParameters
	require.NoError(t, decoded.Scan([]byte(raw)))
	require.Equal(t, "new-secret", decoded.APIKey)
	replay, err := RunTransportMigration(context.Background(), s.db, r)
	require.NoError(t, err)
	require.Equal(t, "already-applied", replay.Status)
	r.Mode = "verify"
	verified, err := RunTransportMigration(context.Background(), s.db, r)
	require.NoError(t, err)
	require.Equal(t, "verified", verified.Status)
	r.CompatibilityReceipt = strings.Repeat("d", 64)
	_, err = RunTransportMigration(context.Background(), s.db, r)
	require.Error(t, err)
	var database string
	require.NoError(t, s.db.Raw(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&database).Error)
	connection, err := s.db.DB()
	require.NoError(t, err)
	require.NoError(t, connection.Close())
	reopened, err := gorm.Open(sqlite.Open(database), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	reopenedConnection, err := reopened.DB()
	require.NoError(t, err)
	defer reopenedConnection.Close()
	var native types.Model
	require.NoError(t, reopened.Where("id=?", "model").Take(&native).Error)
	require.Equal(t, "new-secret", native.Parameters.APIKey)
	require.Equal(t, "openai", native.Parameters.Provider)
	require.Equal(t, &types.ModelSpecOverride{Compat: map[string]any{"max_batch_size": float64(10)}}, native.Parameters.Spec)
	require.Equal(t, "https://gateway.example/v1", native.Parameters.BaseURL)
	var storage string
	require.NoError(t, reopened.Raw(`SELECT typeof(parameters) FROM models WHERE id='model'`).Scan(&storage).Error)
	require.Equal(t, "blob", storage)
}

func TestTransportRejectsStaleAndUnauthorizedChangesWithoutWrites(t *testing.T) {
	cases := map[string]func(*Store, *TransportRequest){
		"owner":             func(_ *Store, r *TransportRequest) { r.OwnerID = "other" },
		"tenant":            func(_ *Store, r *TransportRequest) { r.TenantID = 2 },
		"semantic":          func(_ *Store, r *TransportRequest) { r.TargetParameters.EmbeddingParameters.Dimension = 512 },
		"unbound namespace": func(_ *Store, r *TransportRequest) { r.SelectedNodes[0].Namespace = "superwagie:memory:arbitrary:core" },
		"payload changed": func(s *Store, _ *TransportRequest) {
			require.NoError(t, s.db.Exec(`UPDATE hy_memory_nodes SET payload='{}'`).Error)
		},
		"ledger changed": func(s *Store, _ *TransportRequest) {
			require.NoError(t, s.db.Exec(`UPDATE hy_memory_records SET value='{}' WHERE id='control'`).Error)
		},
		"model changed": func(s *Store, _ *TransportRequest) {
			require.NoError(t, s.db.Exec(`UPDATE models SET managed_by='yaml'`).Error)
		},
		"shared model": func(s *Store, _ *TransportRequest) {
			require.NoError(t, s.db.Exec(`INSERT INTO knowledge_bases VALUES('other',1,NULL,'owner','model')`).Error)
		},
		"bad patch": func(_ *Store, r *TransportRequest) {
			r.LedgerMutations[0].ValueRaw = strings.Replace(r.LedgerMutations[0].ValueRaw, `"keep":true`, `"keep":false`, 1)
		},
		"missing backup": func(_ *Store, r *TransportRequest) { r.BackupReceipt.Restored = false },
		"missing stop":   func(_ *Store, r *TransportRequest) { r.StoppedReceipt.Stopped = false },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			s, r := transportFixture(t)
			r = preparedTransport(t, s, r)
			change(s, &r)
			_, err := RunTransportMigration(context.Background(), s.db, r)
			require.Error(t, err)
			var count int
			require.NoError(t, s.db.Raw(`SELECT count(*) FROM hy_memory_nodes`).Scan(&count).Error)
			require.Equal(t, 1, count)
		})
	}
}

func TestTransportRollbackAfterVectorAndLedgerFailure(t *testing.T) {
	for _, trigger := range []string{
		`CREATE TRIGGER reject_copy AFTER INSERT ON hy_memory_nodes WHEN NEW.rowid>3 BEGIN SELECT RAISE(ABORT,'private SQL failure'); END`,
		`CREATE TRIGGER reject_receipt BEFORE INSERT ON hy_memory_receipts WHEN NEW.idempotency_key='migration-one' BEGIN SELECT RAISE(ABORT,'private SQL failure'); END`,
	} {
		t.Run(trigger[:30], func(t *testing.T) {
			s, r := transportFixture(t)
			p, err := RunTransportMigration(context.Background(), s.db, r)
			require.NoError(t, err)
			scope := transportScope(r)
			scope.Namespace = transportNamespace("project") + ":cards"
			vector := make([]float32, 1024)
			vector[1] = 1
			_, err = s.Upsert(context.Background(), scope, p.Preview.Current.SpaceID, []Node{{ID: "second", Content: "second", Payload: json.RawMessage(`{}`), Vector: vector, Active: true}})
			require.NoError(t, err)
			r = preparedTransport(t, s, r)
			require.NoError(t, s.db.Exec(trigger).Error)
			_, err = RunTransportMigration(context.Background(), s.db, r)
			require.Error(t, err)
			require.NotContains(t, err.Error(), "private SQL")
			r.Mode = "preview"
			p, err = RunTransportMigration(context.Background(), s.db, r)
			require.NoError(t, err)
			require.Equal(t, *r.Expected, p.Preview)
			for _, table := range []string{"hy_memory_nodes", "hy_memory_fts", "hy_memory_vec_1024"} {
				var count int
				require.NoError(t, s.db.Raw("SELECT count(*) FROM "+table).Scan(&count).Error)
				require.Equal(t, 2, count, table)
			}
			var spaces int
			require.NoError(t, s.db.Raw(`SELECT count(*) FROM hy_memory_spaces`).Scan(&spaces).Error)
			require.Equal(t, 1, spaces)
		})
	}
}

func TestTransportCommandReadsWithoutSideEffectsOrProviderCalls(t *testing.T) {
	s, r := transportFixture(t)
	var database string
	require.NoError(t, s.db.Raw(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&database).Error)
	require.NoError(t, s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`).Error)
	r.Database = database
	r.ConfigDir = t.TempDir()
	// A non-listening HTTPS endpoint cannot be contacted by preview, apply or verify.
	r.TargetParameters.BaseURL = "https://127.0.0.1:1/v1"
	preview, err := ExecuteTransportRequest(context.Background(), r)
	require.NoError(t, err)
	require.True(t, transportHex(preview.Preview.CatalogDigest))
	r = preparedTransport(t, s, r)
	r.CatalogDigest = preview.Preview.CatalogDigest
	// Freeze with the same catalog fingerprint as the executable boundary.
	r.Mode = "preview"
	p, err := ExecuteTransportRequest(context.Background(), r)
	require.NoError(t, err)
	r.Expected = &p.Preview
	r.BackupReceipt.BaselineDigest = p.Preview.Digest
	r.Mode = "apply"
	applied, err := ExecuteTransportRequest(context.Background(), r)
	require.NoError(t, err)
	require.Equal(t, "applied", applied.Status)
	connection, err := s.db.DB()
	require.NoError(t, err)
	require.NoError(t, connection.Close())
	r.Mode = "verify"
	verified, err := ExecuteTransportRequest(context.Background(), r)
	require.NoError(t, err)
	require.Equal(t, "verified", verified.Status)
	r.CatalogDigest = strings.Repeat("0", 64)
	_, err = ExecuteTransportRequest(context.Background(), r)
	require.Error(t, err)
}

func TestTransportManualScopesPreserveUnknownFieldsAndInactiveVectors(t *testing.T) {
	s, r := transportFixture(t)
	p, err := RunTransportMigration(context.Background(), s.db, r)
	require.NoError(t, err)
	scope := transportScope(r)
	for _, project := range []string{"global", "project"} {
		marker := fmt.Sprintf(`{"projectId":%q,"collection":"manual-index","id":"manual-one","extra":"retained","value":{"version":1,"sourceHash":%q,"configurationId":%q,"spaceId":%q,"dimensions":1024,"state":"ready"}}`, project, strings.Repeat("e", 64), p.Preview.Current.ConfigurationID, p.Preview.Current.SpaceID)
		require.NoError(t, s.db.Exec(`INSERT INTO hy_memory_records VALUES(?,?,?,?,?,?)`, 1, "kb", scope.Namespace, "entry", transportEngineID(project, "manual-index", "manual-one"), marker).Error)
		n := scope
		n.Namespace = transportNamespace(project) + ":manual"
		vector := make([]float32, 1024)
		vector[1] = 1
		_, err = s.Upsert(context.Background(), n, p.Preview.Current.SpaceID, []Node{{ID: "manual-one", Content: "manual retained", Vector: vector, Payload: json.RawMessage(`{"source_hash":"retain"}`), Active: true}})
		require.NoError(t, err)
	}
	r = preparedTransport(t, s, r)
	r.Mode = "snapshot"
	snapshot, err := RunTransportMigration(context.Background(), s.db, r)
	require.NoError(t, err)
	r.Mode = "apply"
	r.SelectedNodes = nil
	var authorities []TransportRecordKey
	for _, row := range snapshot.Snapshot.RawLedger.Records {
		if row.Collection == "entry" {
			authorities = append(authorities, TransportRecordKey{row.Collection, row.ID})
		}
	}
	for _, node := range snapshot.Snapshot.ScopedNodes {
		r.SelectedNodes = append(r.SelectedNodes, TransportSelection{Namespace: node.Namespace, SourceSpaceID: node.SpaceID, NodeID: node.ID, ExpectedNodeDigest: node.Digest, TargetSpaceID: r.Expected.Target.SpaceID, AuthorityRecordIDs: authorities})
	}
	applied, err := RunTransportMigration(context.Background(), s.db, r)
	require.NoError(t, err)
	require.Equal(t, 3, applied.Copied)
	require.Equal(t, 1, applied.Preview.InactiveCount)
	vector := make([]float32, 1024)
	vector[1] = 1
	for _, project := range []string{"global", "project"} {
		scope.Namespace = transportNamespace(project) + ":manual"
		hits, err := s.Search(context.Background(), scope, SearchRequest{SpaceID: applied.Preview.Target.SpaceID, Vector: vector, IncludeVectors: true})
		require.NoError(t, err)
		require.Len(t, hits, 1)
		require.Equal(t, vector, hits[0].Vector)
	}
	scope.Namespace = transportNamespace("project") + ":core"
	hits, err := s.Search(context.Background(), scope, SearchRequest{SpaceID: applied.Preview.Target.SpaceID, Vector: vector})
	require.NoError(t, err)
	require.Empty(t, hits)
	var marker string
	require.NoError(t, s.db.Raw(`SELECT value FROM hy_memory_records WHERE id=?`, transportEngineID("project", "model-space", "current")).Scan(&marker).Error)
	require.Contains(t, marker, `"unknown":{"keep":true}`)
	require.NotContains(t, marker, "dimensions")
}

func TestTransportRejectsInvalidEncryptionJournalsTargetsAndPatchJSON(t *testing.T) {
	for _, kind := range []string{"missing AES", "wrong AES", "pending journal", "conflicting target", "trailing patch", "missing source vector", "mutated knowledge", "unrelated old vector", "custom headers", "catalog override", "catalog bytes changed"} {
		t.Run(kind, func(t *testing.T) {
			s, r := transportFixture(t)
			r = preparedTransport(t, s, r)
			switch kind {
			case "missing AES":
				t.Setenv("SYSTEM_AES_KEY", "")
			case "wrong AES":
				t.Setenv("SYSTEM_AES_KEY", "abcdefghijklmnopqrstuvwxyz123456")
			case "pending journal":
				require.NoError(t, s.db.Exec(`INSERT INTO hy_memory_records VALUES(1,'kb','superwagie:memory','entry','hy:pending','{"collection":"model-space-migration","value":{}}')`).Error)
			case "conflicting target":
				require.NoError(t, s.db.Exec(`INSERT INTO hy_memory_spaces VALUES(1,'kb',?,'wrong',1024)`, r.Expected.Target.SpaceID).Error)
			case "trailing patch":
				r.LedgerMutations[0].ValueRaw += " {}"
			case "missing source vector":
				require.NoError(t, s.db.Exec(`DELETE FROM hy_memory_vec_1024 WHERE rowid=1`).Error)
			case "mutated knowledge":
				require.NoError(t, s.db.Exec(`UPDATE chunks SET content='changed'`).Error)
			case "unrelated old vector":
				scope := transportScope(r)
				require.NoError(t, s.BindSpace(context.Background(), scope, "older-space", "older-identity", 1024))
				vector := make([]float32, 1024)
				vector[0] = 1
				_, err := s.Upsert(context.Background(), scope, "older-space", []Node{{ID: "retained", Content: "retained", Payload: json.RawMessage(`{}`), Vector: vector, Active: true}})
				require.NoError(t, err)
				r = preparedTransport(t, s, r)
				require.NoError(t, s.db.Exec(`UPDATE hy_memory_vec_1024 SET embedding=zeroblob(4096) WHERE rowid=2`).Error)
			case "catalog override":
				require.NoError(t, s.db.Exec(`UPDATE model_catalog_configs SET version=1,overlay='{"providers":{"openai":{}}}'`).Error)
			case "catalog bytes changed":
				require.NoError(t, s.db.Exec(`UPDATE model_catalog_configs SET overlay='{ "providers": {} }'`).Error)
			case "custom headers":
				r.TargetParameters.CustomHeaders = map[string]string{"X-Secret": "secret"}
			}
			_, err := RunTransportMigration(context.Background(), s.db, r)
			require.Error(t, err)
		})
	}
}

func TestTransportReadOnlySnapshotLeavesDatabaseAndOrphansByteIdentical(t *testing.T) {
	s, r := transportFixture(t)
	require.NoError(t, s.db.Exec(`INSERT INTO hy_memory_records VALUES(99,'orphan','other','entry','retained','{"keep":true}')`).Error)
	var database string
	require.NoError(t, s.db.Raw(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&database).Error)
	sqlDB, err := s.db.DB()
	require.NoError(t, err)
	require.NoError(t, sqlDB.Close())
	before, err := os.ReadFile(database)
	require.NoError(t, err)
	filesBefore, err := os.ReadDir(filepath.Dir(database))
	require.NoError(t, err)
	r.Database = database
	r.ConfigDir = t.TempDir()
	r.Mode = "snapshot"
	r.TargetParameters = nil
	snapshot, err := ExecuteTransportRequest(context.Background(), r)
	require.NoError(t, err)
	require.NotNil(t, snapshot.Snapshot)
	after, err := os.ReadFile(database)
	require.NoError(t, err)
	require.Equal(t, before, after)
	filesAfter, err := os.ReadDir(filepath.Dir(database))
	require.NoError(t, err)
	require.Equal(t, len(filesBefore), len(filesAfter))
}

func TestTransportVerificationRejectsMissingTargetKeywordIndex(t *testing.T) {
	s, r := transportFixture(t)
	r = preparedTransport(t, s, r)
	_, err := RunTransportMigration(context.Background(), s.db, r)
	require.NoError(t, err)
	require.NoError(t, s.db.Exec(`DELETE FROM hy_memory_fts WHERE rowid IN (SELECT rowid FROM hy_memory_nodes WHERE space_id=?)`, r.Expected.Target.SpaceID).Error)
	r.Mode = "verify"
	_, err = RunTransportMigration(context.Background(), s.db, r)
	require.Error(t, err)
}

func TestTransportPrivateSnapshotRefusesUnclassifiedCredentialContainers(t *testing.T) {
	for _, field := range []string{"custom_headers", "extra_config"} {
		t.Run(field, func(t *testing.T) {
			s, r := transportFixture(t)
			require.NoError(t, s.db.Exec(`UPDATE models SET parameters=json_set(parameters,?,json('{"api_key":"hidden-secret"}'))`, "$."+field).Error)
			r.Mode = "snapshot"
			r.TargetParameters = nil
			_, err := RunTransportMigration(context.Background(), s.db, r)
			require.Error(t, err)
		})
	}
}

func TestTransportLegacyTextParametersBecomeNativeReadableBlob(t *testing.T) {
	s, r := transportFixture(t)
	require.NoError(t, s.db.Exec(`UPDATE models SET parameters=CAST(parameters AS TEXT)`).Error)
	r = preparedTransport(t, s, r)
	_, err := RunTransportMigration(context.Background(), s.db, r)
	require.NoError(t, err)
	var native types.Model
	require.NoError(t, s.db.Where("id=?", "model").Take(&native).Error)
	require.Equal(t, "new-secret", native.Parameters.APIKey)
	require.Equal(t, "https://gateway.example/v1", native.Parameters.BaseURL)
}

func TestTransportTargetRejectsUnreviewedSpec(t *testing.T) {
	for _, spec := range []*types.ModelSpecOverride{
		nil,
		{Compat: map[string]any{"max_batch_size": float64(11)}},
		{Compat: map[string]any{"max_batch_size": float64(10), "input_type": "query"}},
		{API: "other", Compat: map[string]any{"max_batch_size": float64(10)}},
	} {
		s, r := transportFixture(t)
		r.TargetParameters.Spec = spec
		_, err := RunTransportMigration(context.Background(), s.db, r)
		require.Error(t, err)
	}
}
