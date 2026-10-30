// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package memoryindex

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	sqlitevec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var vecOnce sync.Once

func fixture(t *testing.T) (*Store, Scope) {
	t.Helper()
	vecOnce.Do(sqlitevec.Auto)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "memory.db")+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
	require.NoError(t, db.Exec(`CREATE TABLE knowledge_bases(id TEXT PRIMARY KEY,tenant_id INTEGER NOT NULL,deleted_at DATETIME)`).Error)
	require.NoError(t, db.Exec(`INSERT INTO knowledge_bases(id,tenant_id) VALUES('kb',1)`).Error)
	s, err := NewStore(db)
	require.NoError(t, err)
	return s, Scope{Tenant: 1, KB: "kb", Namespace: "project-one"}
}

func TestLedgerCommitsExceedNodeBatchAndRetainAtomicRollback(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	mutations := make([]Mutation, maxBatch+1)
	for i := range mutations {
		mutations[i] = Mutation{Collection: "entry", ID: fmt.Sprintf("entry-%d", i), Value: json.RawMessage(`{"source":"captured"}`)}
	}
	request := CommitRequest{Namespace: scope.Namespace, ExpectedRevision: 0, IdempotencyKey: "large-ledger", Mutations: mutations}
	result, err := s.Commit(ctx, scope, request)
	require.NoError(t, err)
	require.Equal(t, int64(1), result)
	read, err := s.Read(ctx, scope)
	require.NoError(t, err)
	require.Len(t, read.Records, maxBatch+1)
	request.ExpectedRevision = 1
	request.IdempotencyKey = "invalid-large-ledger"
	request.Mutations[0].Value = json.RawMessage(`{"source":"changed"}`)
	request.Mutations[len(mutations)-1].Collection = "invalid"
	_, err = s.Commit(ctx, scope, request)
	require.Error(t, err)
	read, err = s.Read(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, int64(1), read.Revision)
}

func TestKnowledgeBaseDeletionPurgesMemoryAndRejectsStaleWriters(t *testing.T) {
	for _, hard := range []bool{false, true} {
		t.Run(fmt.Sprintf("hard=%t", hard), func(t *testing.T) {
			s, scope := fixture(t)
			ctx := context.Background()
			require.NoError(t, s.db.Exec(`INSERT INTO knowledge_bases(id,tenant_id) VALUES('other',1)`).Error)
			other := scope
			other.KB = "other"
			for _, target := range []Scope{scope, other} {
				require.NoError(t, s.BindSpace(ctx, target, "space", "model", 2))
				_, err := s.Commit(ctx, target, CommitRequest{Namespace: target.Namespace, ExpectedRevision: 0, IdempotencyKey: "saved", Mutations: []Mutation{{Collection: "entry", ID: "saved", Value: json.RawMessage(`{"private":"data"}`)}}, IndexOperations: []IndexOperation{{Operation: "nodes/upsert", Namespace: target.Namespace, SpaceID: "space", Nodes: []Node{{ID: "node", Content: "privateword", Vector: []float32{1, 0}, Payload: json.RawMessage(`{}`), Active: true}}}}})
				require.NoError(t, err)
			}
			statement := `UPDATE knowledge_bases SET deleted_at=CURRENT_TIMESTAMP WHERE id='kb'`
			if hard {
				statement = `DELETE FROM knowledge_bases WHERE id='kb'`
			}
			require.NoError(t, s.db.Exec(statement).Error)
			state, err := s.Read(ctx, scope)
			require.NoError(t, err)
			require.Empty(t, state.Records)
			require.Zero(t, state.Revision)
			for _, table := range []string{"hy_memory_namespaces", "hy_memory_records", "hy_memory_receipts", "hy_memory_spaces", "hy_memory_nodes"} {
				var count int64
				require.NoError(t, s.db.Raw("SELECT COUNT(*) FROM "+table+" WHERE tenant_id=1 AND kb_id='kb'").Scan(&count).Error)
				require.Zero(t, count, table)
			}
			for _, table := range []string{"hy_memory_fts", "hy_memory_vec_2"} {
				var count int64
				require.NoError(t, s.db.Raw("SELECT COUNT(*) FROM "+table).Scan(&count).Error)
				require.EqualValues(t, 1, count, table)
			}
			_, err = s.Commit(ctx, scope, CommitRequest{Namespace: scope.Namespace, IdempotencyKey: "late"})
			require.Error(t, err)
			require.Error(t, s.BindSpace(ctx, scope, "late", "model", 2))
			retained, err := s.Search(ctx, other, SearchRequest{Query: "privateword"})
			require.NoError(t, err)
			require.Len(t, retained, 1)
		})
	}
}

func TestFailedKnowledgeBaseCleanupRollsBackDelete(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	require.NoError(t, s.BindSpace(ctx, scope, "space", "model", 2))
	_, err := s.Upsert(ctx, scope, "space", []Node{{ID: "node", Content: "retainedword", Vector: []float32{1, 0}, Payload: json.RawMessage(`{}`), Active: true}})
	require.NoError(t, err)
	require.NoError(t, s.db.Exec(`CREATE TRIGGER fail_memory_cleanup BEFORE DELETE ON hy_memory_nodes BEGIN SELECT RAISE(ABORT,'cleanup failed'); END`).Error)
	require.Error(t, s.db.Exec(`UPDATE knowledge_bases SET deleted_at=CURRENT_TIMESTAMP WHERE id='kb'`).Error)
	var active int64
	require.NoError(t, s.db.Raw(`SELECT COUNT(*) FROM knowledge_bases WHERE id='kb' AND deleted_at IS NULL`).Scan(&active).Error)
	require.EqualValues(t, 1, active)
	matches, err := s.Search(ctx, scope, SearchRequest{Query: "retainedword"})
	require.NoError(t, err)
	require.Len(t, matches, 1)
}

func TestInitializationPurgesPreviouslyOrphanedMemory(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	require.NoError(t, s.BindSpace(ctx, scope, "space", "model", 2))
	_, err := s.Upsert(ctx, scope, "space", []Node{{ID: "node", Content: "orphanword", Vector: []float32{1, 0}, Payload: json.RawMessage(`{}`), Active: true}})
	require.NoError(t, err)
	require.NoError(t, s.db.Exec(`DROP TRIGGER hy_memory_kb_soft_cleanup`).Error)
	require.NoError(t, s.db.Exec(`UPDATE knowledge_bases SET deleted_at=CURRENT_TIMESTAMP WHERE id='kb'`).Error)
	_, err = NewStore(s.db)
	require.NoError(t, err)
	for _, table := range []string{"hy_memory_nodes", "hy_memory_fts", "hy_memory_vec_2", "hy_memory_spaces"} {
		var count int64
		require.NoError(t, s.db.Raw("SELECT COUNT(*) FROM "+table).Scan(&count).Error)
		require.Zero(t, count, table)
	}
}
func TestStateCASIdempotencyAndIsolation(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	request := CommitRequest{Namespace: scope.Namespace, ExpectedRevision: 0, IdempotencyKey: "job-one", Mutations: []Mutation{{Collection: "entry", ID: "entry-one", Value: json.RawMessage(`{"body":"retained"}`)}}}
	rev, err := s.Commit(ctx, scope, request)
	require.NoError(t, err)
	require.EqualValues(t, 1, rev)
	rev, err = s.Commit(ctx, scope, request)
	require.NoError(t, err)
	require.EqualValues(t, 1, rev)
	request.IdempotencyKey = "job-two"
	request.Mutations[0].Value = json.RawMessage(`{"body":"lost"}`)
	_, err = s.Commit(ctx, scope, request)
	require.ErrorIs(t, err, ErrConflict)
	state, err := s.Read(ctx, scope)
	require.NoError(t, err)
	require.JSONEq(t, `{"body":"retained"}`, string(state.Records[0].Value))
	other := scope
	other.Namespace = "project-two"
	state, err = s.Read(ctx, other)
	require.NoError(t, err)
	require.Empty(t, state.Records)
	other = scope
	other.Tenant = 2
	state, err = s.Read(ctx, other)
	require.NoError(t, err)
	require.Empty(t, state.Records)
	request.IdempotencyKey = "job-one"
	request.ExpectedRevision = 1
	_, err = s.Commit(ctx, scope, request)
	require.ErrorIs(t, err, ErrIdempotency)
}
func TestNodesScopeBeforeTopKAndPayloadRoundTrip(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	require.NoError(t, s.BindSpace(ctx, scope, "space-one", "model-one", 2))
	nodes := []Node{{ID: "blocker", Content: "PPT title", Vector: []float32{1, 0}, Payload: json.RawMessage(`{"workspace_id":"other","arbitrary":{"keep":true}}`), Active: true}, {ID: "target", Content: "PPT title lesson", Vector: []float32{0.8, 0.6}, Payload: json.RawMessage(`{"workspace_id":"project","layer":"fact","nested":[1,2]}`), Active: true}, {ID: "inactive", Content: "PPT title", Vector: []float32{1, 0}, Payload: json.RawMessage(`{"workspace_id":"project"}`)}}
	_, err := s.Upsert(ctx, scope, "space-one", nodes)
	require.NoError(t, err)
	result, err := s.Search(ctx, scope, SearchRequest{SpaceID: "space-one", Vector: []float32{1, 0}, Filters: Filters{"workspace_id": json.RawMessage(`["project"]`)}, Limit: 1})
	require.NoError(t, err)
	require.Len(t, result, 1)
	require.Equal(t, "target", result[0].ID)
	read, err := s.Get(ctx, scope, "space-one", []string{"target"}, true)
	require.NoError(t, err)
	require.Equal(t, []float32{0.8, 0.6}, read[0].Vector)
	require.JSONEq(t, `{"workspace_id":"project","layer":"fact","nested":[1,2]}`, string(read[0].Payload))
	updated, err := s.Patch(ctx, scope, "space-one", []string{"target"}, json.RawMessage(`{"status":"confirmed","new":{"v":1}}`))
	require.NoError(t, err)
	require.EqualValues(t, 1, updated)
	lexical, err := s.Search(ctx, scope, SearchRequest{Query: "lesson", Filters: Filters{"workspace_id": json.RawMessage(`"project"`)}, Limit: 1})
	require.NoError(t, err)
	require.Len(t, lexical, 1)
	require.Equal(t, "target", lexical[0].ID)
	other := scope
	other.Namespace = "other"
	lexical, err = s.Search(ctx, other, SearchRequest{Query: "lesson", Limit: 1})
	require.NoError(t, err)
	require.Empty(t, lexical)
	deleted, err := s.Delete(ctx, scope, "", nil, Filters{"node_ids": json.RawMessage(`["target"]`)})
	require.NoError(t, err)
	require.EqualValues(t, 1, deleted)
	lexical, err = s.Search(ctx, scope, SearchRequest{Query: "lesson", Limit: 1})
	require.NoError(t, err)
	require.Empty(t, lexical)
}
func TestFailedVectorWriteRollsBackMetadataAndFTS(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	require.NoError(t, s.BindSpace(ctx, scope, "space-one", "model-one", 2))
	original := Node{ID: "node", Content: "originalword", Vector: []float32{1, 0}, Payload: json.RawMessage(`{"layer":"fact"}`), Active: true}
	_, err := s.Upsert(ctx, scope, "space-one", []Node{original})
	require.NoError(t, err)
	// Removing the vector table causes the final index write to fail after metadata/FTS changed.
	require.NoError(t, s.db.Exec("DROP TABLE hy_memory_vec_2").Error)
	replacement := original
	replacement.Content = "replacementword"
	replacement.Payload = json.RawMessage(`{"layer":"experience"}`)
	_, err = s.Upsert(ctx, scope, "space-one", []Node{replacement})
	require.Error(t, err)
	rows, total, err := s.List(ctx, scope, ListRequest{SpaceID: "space-one", Limit: 10})
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	require.Equal(t, "originalword", rows[0].Content)
	matches, err := s.Search(ctx, scope, SearchRequest{Query: "originalword", Limit: 10})
	require.NoError(t, err)
	require.Len(t, matches, 1)
}
func TestNodeValidationRejectsDimensionAndInvalidScope(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	require.NoError(t, s.BindSpace(ctx, scope, "space-one", "model-one", 2))
	_, err := s.Upsert(ctx, scope, "space-one", []Node{{ID: "node", Content: "text", Vector: []float32{1}, Payload: json.RawMessage(`{}`), Active: true}})
	require.ErrorIs(t, err, ErrInvalid)
	invalidScope := scope
	invalidScope.Namespace = ""
	_, err = s.Delete(ctx, invalidScope, "", nil, nil)
	require.ErrorIs(t, err, ErrInvalid)
	_, _, err = s.List(ctx, scope, ListRequest{Filters: Filters{"raw_sql": json.RawMessage(`"x"`)}})
	require.ErrorIs(t, err, ErrInvalid)
}

func TestVectorMagnitudeCannotProduceNonFiniteCosineScores(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	require.NoError(t, s.BindSpace(ctx, scope, "space", "model", 2))
	valid := Node{ID: "node", Content: "retainedword", Vector: []float32{0.8, 0.6}, Payload: json.RawMessage(`{}`), Active: true}
	_, err := s.Upsert(ctx, scope, "space", []Node{valid})
	require.NoError(t, err)
	for _, vector := range [][]float32{{1e38, 0}, {1e-40, 0}} {
		invalid := valid
		invalid.Vector = vector
		_, err := s.Upsert(ctx, scope, "space", []Node{invalid})
		require.ErrorIs(t, err, ErrInvalid)
		_, err = s.Search(ctx, scope, SearchRequest{SpaceID: "space", Vector: vector})
		require.ErrorIs(t, err, ErrInvalid)
	}
	nodes, err := s.Get(ctx, scope, "space", []string{"node"}, true)
	require.NoError(t, err)
	require.Equal(t, valid.Vector, nodes[0].Vector)
	matches, err := s.Search(ctx, scope, SearchRequest{SpaceID: "space", Vector: []float32{1, 0}})
	require.NoError(t, err)
	require.Len(t, matches, 1)
	require.NotNil(t, matches[0].Score)
	_, err = json.Marshal(matches)
	require.NoError(t, err)
}

func TestConcurrentStoresResolveCASAsConflictAndSurviveReopen(t *testing.T) {
	s, scope := fixture(t)
	other, err := NewStore(s.db)
	require.NoError(t, err)
	ctx := context.Background()
	for round := 0; round < 10; round++ {
		state, err := s.Read(ctx, scope)
		require.NoError(t, err)
		start := make(chan struct{})
		results := make(chan error, 2)
		for index, store := range []*Store{s, other} {
			go func(index int, store *Store) {
				<-start
				_, err := store.Commit(ctx, scope, CommitRequest{Namespace: scope.Namespace, ExpectedRevision: state.Revision, IdempotencyKey: fmt.Sprintf("round-%d-%d", round, index), Mutations: []Mutation{{Collection: "meta", ID: "last", Value: json.RawMessage(`{"retained":true}`)}}})
				results <- err
			}(index, store)
		}
		close(start)
		first, second := <-results, <-results
		if first == nil {
			require.ErrorIs(t, second, ErrConflict)
		} else {
			require.ErrorIs(t, first, ErrConflict)
			require.NoError(t, second)
		}
	}
	reopened, err := NewStore(s.db)
	require.NoError(t, err)
	state, err := reopened.Read(ctx, scope)
	require.NoError(t, err)
	require.EqualValues(t, 10, state.Revision)
	require.JSONEq(t, `{"retained":true}`, string(state.Records[0].Value))
}

func TestEmptyIDsDoNotClearNamespaceAndExplicitClearLeavesOtherNamespaces(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	require.NoError(t, s.BindSpace(ctx, scope, "space-one", "model-one", 2))
	node := Node{ID: "node", Content: "clearword", Vector: []float32{1, 0}, Payload: json.RawMessage(`{}`), Active: true}
	_, err := s.Upsert(ctx, scope, "space-one", []Node{node})
	require.NoError(t, err)
	other := scope
	other.Namespace = "other"
	_, err = s.Upsert(ctx, other, "space-one", []Node{node})
	require.NoError(t, err)
	deleted, err := s.Delete(ctx, scope, "", []string{}, nil)
	require.NoError(t, err)
	require.Zero(t, deleted)
	_, total, err := s.List(ctx, scope, ListRequest{})
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	deleted, err = s.Delete(ctx, scope, "", nil, nil)
	require.NoError(t, err)
	require.EqualValues(t, 1, deleted)
	_, total, err = s.List(ctx, other, ListRequest{})
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
}
func TestLaterBatchFailureRetainsOriginalVectorMetadataAndFTS(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	require.NoError(t, s.BindSpace(ctx, scope, "space-one", "model-one", 2))
	original := Node{ID: "node", Content: "retainedword", Vector: []float32{1, 0}, Payload: json.RawMessage(`{"version":1}`), Active: true}
	_, err := s.Upsert(ctx, scope, "space-one", []Node{original})
	require.NoError(t, err)
	replacement := original
	replacement.Content = "lostword"
	replacement.Vector = []float32{0, 1}
	replacement.Payload = json.RawMessage(`{"version":2}`)
	invalid := Node{ID: "invalid", Content: "badword", Vector: []float32{1}, Payload: json.RawMessage(`{}`), Active: true}
	_, err = s.Upsert(ctx, scope, "space-one", []Node{replacement, invalid})
	require.ErrorIs(t, err, ErrInvalid)
	nodes, err := s.Get(ctx, scope, "space-one", []string{"node"}, true)
	require.NoError(t, err)
	require.Len(t, nodes, 1)
	require.Equal(t, []float32{1, 0}, nodes[0].Vector)
	require.Equal(t, "retainedword", nodes[0].Content)
	require.JSONEq(t, `{"version":1}`, string(nodes[0].Payload))
	matches, err := s.Search(ctx, scope, SearchRequest{Query: "retainedword", Limit: 5})
	require.NoError(t, err)
	require.Len(t, matches, 1)
	matches, err = s.Search(ctx, scope, SearchRequest{Query: "lostword", Limit: 5})
	require.NoError(t, err)
	require.Empty(t, matches)
}
func TestStateWriteFailureRollsBackRevisionRecordsAndReceipt(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	require.NoError(t, s.db.Exec(`CREATE TRIGGER fail_memory_record BEFORE INSERT ON hy_memory_records WHEN NEW.id='failing' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END`).Error)
	request := CommitRequest{Namespace: scope.Namespace, ExpectedRevision: 0, IdempotencyKey: "retry-key", Mutations: []Mutation{{Collection: "entry", ID: "first", Value: json.RawMessage(`{"ok":true}`)}, {Collection: "entry", ID: "failing", Value: json.RawMessage(`{"ok":false}`)}}}
	_, err := s.Commit(ctx, scope, request)
	require.Error(t, err)
	state, err := s.Read(ctx, scope)
	require.NoError(t, err)
	require.Zero(t, state.Revision)
	require.Empty(t, state.Records)
	require.NoError(t, s.db.Exec("DROP TRIGGER fail_memory_record").Error)
	revision, err := s.Commit(ctx, scope, request)
	require.NoError(t, err)
	require.EqualValues(t, 1, revision)
}

func TestCASCommitAtomicallyUpdatesStateVectorsAndFTS(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	require.NoError(t, s.BindSpace(ctx, scope, "space-one", "model-one", 2))
	original := Node{ID: "node", Content: "oldword", Vector: []float32{1, 0}, Payload: json.RawMessage(`{"revision":0}`), Active: true}
	_, err := s.Upsert(ctx, scope, "space-one", []Node{original})
	require.NoError(t, err)
	replacement := original
	replacement.Content = "newword"
	replacement.Vector = []float32{0, 1}
	request := CommitRequest{Namespace: scope.Namespace, ExpectedRevision: 0, IdempotencyKey: "atomic-one", Mutations: []Mutation{{Collection: "entry", ID: "node", Value: json.RawMessage(`{"revision":1}`)}}, IndexOperations: []IndexOperation{{Operation: "nodes/upsert", Namespace: scope.Namespace, SpaceID: "space-one", Nodes: []Node{replacement}}}}
	revision, err := s.Commit(ctx, scope, request)
	require.NoError(t, err)
	require.EqualValues(t, 1, revision)
	revision, err = s.Commit(ctx, scope, request)
	require.NoError(t, err)
	require.EqualValues(t, 1, revision)
	state, err := s.Read(ctx, scope)
	require.NoError(t, err)
	require.EqualValues(t, 1, state.Revision)
	nodes, err := s.Get(ctx, scope, "space-one", []string{"node"}, true)
	require.NoError(t, err)
	require.Equal(t, "newword", nodes[0].Content)
	require.Equal(t, []float32{0, 1}, nodes[0].Vector)
	request.ExpectedRevision = 0
	request.IdempotencyKey = "conflict"
	request.IndexOperations[0].Nodes[0].Content = "forbiddenword"
	_, err = s.Commit(ctx, scope, request)
	require.ErrorIs(t, err, ErrConflict)
	nodes, err = s.Get(ctx, scope, "space-one", []string{"node"}, true)
	require.NoError(t, err)
	require.Equal(t, "newword", nodes[0].Content)
	request.ExpectedRevision = 1
	request.IdempotencyKey = "rollback"
	request.IndexOperations = append(request.IndexOperations, IndexOperation{Operation: "nodes/upsert", Namespace: scope.Namespace, SpaceID: "missing-space", Nodes: []Node{replacement}})
	_, err = s.Commit(ctx, scope, request)
	require.ErrorIs(t, err, ErrInvalid)
	state, err = s.Read(ctx, scope)
	require.NoError(t, err)
	require.EqualValues(t, 1, state.Revision)
	nodes, err = s.Get(ctx, scope, "space-one", []string{"node"}, true)
	require.NoError(t, err)
	require.Equal(t, "newword", nodes[0].Content)
	matches, err := s.Search(ctx, scope, SearchRequest{Query: "forbiddenword"})
	require.NoError(t, err)
	require.Empty(t, matches)
	request.IndexOperations = request.IndexOperations[:1]
	request.IndexOperations[0].Namespace = "other-project"
	_, err = s.Commit(ctx, scope, request)
	require.ErrorIs(t, err, ErrInvalid)
}

func TestAtomicCommitAcceptsDescendantsAndRollsBackOnVectorFailure(t *testing.T) {
	s, ledger := fixture(t)
	ctx := context.Background()
	require.NoError(t, s.BindSpace(ctx, ledger, "space-one", "model-one", 2))
	project := ledger
	project.Namespace = ledger.Namespace + ":project:cards"
	node := Node{ID: "node", Content: "atomicword", Vector: []float32{1, 0}, Payload: json.RawMessage(`{}`), Active: true}
	request := CommitRequest{Namespace: ledger.Namespace, ExpectedRevision: 0, IdempotencyKey: "descendant", Mutations: []Mutation{{Collection: "entry", ID: "node", Value: json.RawMessage(`{"revision":1}`)}}, IndexOperations: []IndexOperation{{Operation: "nodes/upsert", Namespace: project.Namespace, SpaceID: "space-one", Nodes: []Node{node}}}}
	revision, err := s.Commit(ctx, ledger, request)
	require.NoError(t, err)
	require.EqualValues(t, 1, revision)
	nodes, err := s.Get(ctx, project, "space-one", []string{"node"}, false)
	require.NoError(t, err)
	require.Len(t, nodes, 1)
	require.NoError(t, s.db.Exec("DROP TABLE hy_memory_vec_2").Error)
	request.IdempotencyKey = "failed-vector"
	request.ExpectedRevision = 1
	request.Mutations[0].Value = json.RawMessage(`{"revision":2}`)
	request.IndexOperations[0].Nodes[0].Content = "rejectedword"
	_, err = s.Commit(ctx, ledger, request)
	require.Error(t, err)
	state, err := s.Read(ctx, ledger)
	require.NoError(t, err)
	require.EqualValues(t, 1, state.Revision)
	require.JSONEq(t, `{"revision":1}`, string(state.Records[0].Value))
	matches, err := s.Search(ctx, project, SearchRequest{Query: "atomicword"})
	require.NoError(t, err)
	require.Len(t, matches, 1)
}
func TestStatePersistsAcrossDatabaseHandles(t *testing.T) {
	s, scope := fixture(t)
	ctx := context.Background()
	_, err := s.Commit(ctx, scope, CommitRequest{Namespace: scope.Namespace, ExpectedRevision: 0, IdempotencyKey: "persist", Mutations: []Mutation{{Collection: "source", ID: "source", Value: json.RawMessage(`{"messages":["m1"],"withdrawn":false}`)}}})
	require.NoError(t, err)
	var database struct{ Name, File string }
	require.NoError(t, s.db.Raw("PRAGMA database_list").Scan(&database).Error)
	db, err := gorm.Open(sqlite.Open(database.File), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	defer sqlDB.Close()
	reopened, err := NewStore(db)
	require.NoError(t, err)
	state, err := reopened.Read(ctx, scope)
	require.NoError(t, err)
	require.EqualValues(t, 1, state.Revision)
	require.JSONEq(t, `{"messages":["m1"],"withdrawn":false}`, string(state.Records[0].Value))
}
