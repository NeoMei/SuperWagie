// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package memoryindex

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode"

	sqlitevec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	"gorm.io/gorm"
)

var (
	ErrInvalid     = errors.New("invalid memory-index request")
	ErrConflict    = errors.New("memory state revision conflict")
	ErrIdempotency = errors.New("idempotency key already used for another request")
	ErrUnsupported = errors.New("memory index requires SQLite with FTS5 and sqlite-vec")
)

const maxBatch = 256
const maxJSON = 1024 * 1024
const maxCommitItems = 16384
const maxRecordJSON = 16 * 1024 * 1024

var identifier = regexp.MustCompile(`^[A-Za-z0-9_.:@/+-]{1,512}$`)
var collections = map[string]bool{"meta": true, "source": true, "entry": true, "job": true, "relation": true, "receipt": true, "usage": true}
var filterKeys = map[string]bool{"user_id": true, "agent_id": true, "session_id": true, "workspace_id": true, "branch": true, "source": true, "layer": true, "status": true, "node_ids": true}

type Scope struct {
	Tenant        uint64
	KB, Namespace string
}
type Mutation struct {
	Collection string          `json:"collection"`
	ID         string          `json:"id"`
	Value      json.RawMessage `json:"value,omitempty"`
	Delete     bool            `json:"delete,omitempty"`
}
type Record struct {
	Collection string          `json:"collection"`
	ID         string          `json:"id"`
	Value      json.RawMessage `json:"value"`
}
type State struct {
	Revision int64    `json:"revision"`
	Records  []Record `json:"records"`
}
type CommitRequest struct {
	Namespace        string           `json:"namespace"`
	ExpectedRevision int64            `json:"expected_revision"`
	IdempotencyKey   string           `json:"idempotency_key"`
	Mutations        []Mutation       `json:"mutations"`
	IndexOperations  []IndexOperation `json:"index_operations,omitempty"`
}
type IndexOperation struct {
	Operation string          `json:"operation"`
	Namespace string          `json:"namespace"`
	SpaceID   string          `json:"space_id,omitempty"`
	Nodes     []Node          `json:"nodes,omitempty"`
	IDs       []string        `json:"ids"`
	Filters   Filters         `json:"filters,omitempty"`
	Patch     json.RawMessage `json:"patch,omitempty"`
}
type Node struct {
	ID      string          `json:"id"`
	Content string          `json:"content"`
	Vector  []float32       `json:"vector,omitempty"`
	Payload json.RawMessage `json:"payload"`
	Active  bool            `json:"active"`
	Score   *float64        `json:"score,omitempty"`
	SpaceID string          `json:"space_id,omitempty"`
}
type Filters map[string]json.RawMessage
type ListRequest struct {
	Namespace      string  `json:"namespace"`
	SpaceID        string  `json:"space_id,omitempty"`
	Filters        Filters `json:"filters,omitempty"`
	Limit          int     `json:"limit,omitempty"`
	Offset         int     `json:"offset,omitempty"`
	IncludeVectors bool    `json:"include_vectors,omitempty"`
}
type SearchRequest struct {
	Namespace      string    `json:"namespace"`
	SpaceID        string    `json:"space_id,omitempty"`
	Vector         []float32 `json:"vector,omitempty"`
	Query          string    `json:"query,omitempty"`
	Filters        Filters   `json:"filters,omitempty"`
	Limit          int       `json:"limit,omitempty"`
	MinScore       *float64  `json:"min_score,omitempty"`
	IncludeVectors bool      `json:"include_vectors,omitempty"`
}
type Store struct {
	db     *gorm.DB
	writer sync.Mutex
}

func NewStore(db *gorm.DB) (*Store, error) {
	if db.Dialector.Name() != "sqlite" {
		return nil, ErrUnsupported
	}
	s := &Store{db: db}
	err := db.Transaction(func(tx *gorm.DB) error {
		for _, sql := range []string{
			`CREATE TABLE IF NOT EXISTS hy_memory_namespaces(tenant_id INTEGER NOT NULL,kb_id TEXT NOT NULL,namespace TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,kb_id,namespace))`,
			`CREATE TABLE IF NOT EXISTS hy_memory_records(tenant_id INTEGER NOT NULL,kb_id TEXT NOT NULL,namespace TEXT NOT NULL,collection TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(tenant_id,kb_id,namespace,collection,id))`,
			`CREATE TABLE IF NOT EXISTS hy_memory_receipts(tenant_id INTEGER NOT NULL,kb_id TEXT NOT NULL,namespace TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(tenant_id,kb_id,namespace,idempotency_key))`,
			`CREATE TABLE IF NOT EXISTS hy_memory_spaces(tenant_id INTEGER NOT NULL,kb_id TEXT NOT NULL,space_id TEXT NOT NULL,model_identity TEXT NOT NULL,dimensions INTEGER NOT NULL,PRIMARY KEY(tenant_id,kb_id,space_id))`,
			`CREATE TABLE IF NOT EXISTS hy_memory_nodes(rowid INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id INTEGER NOT NULL,kb_id TEXT NOT NULL,namespace TEXT NOT NULL,space_id TEXT NOT NULL,id TEXT NOT NULL,content TEXT NOT NULL,payload TEXT NOT NULL,active INTEGER NOT NULL,dimensions INTEGER NOT NULL,UNIQUE(tenant_id,kb_id,namespace,space_id,id))`,
			`CREATE VIRTUAL TABLE IF NOT EXISTS hy_memory_fts USING fts5(content,tokenize='unicode61')`,
			`CREATE INDEX IF NOT EXISTS hy_memory_node_scope ON hy_memory_nodes(tenant_id,kb_id,namespace,space_id,active)`,
			`CREATE TRIGGER IF NOT EXISTS hy_memory_node_fts_cleanup AFTER DELETE ON hy_memory_nodes BEGIN DELETE FROM hy_memory_fts WHERE rowid=OLD.rowid; END`,
		} {
			if err := tx.Exec(sql).Error; err != nil {
				return fmt.Errorf("%w: initialize memory tables: %v", ErrUnsupported, err)
			}
		}
		var retained []int
		if err := tx.Raw("SELECT DISTINCT dimensions FROM hy_memory_spaces").Scan(&retained).Error; err != nil {
			return err
		}
		for _, dim := range retained {
			if err := vectorDeleteTrigger(tx, dim); err != nil {
				return err
			}
		}
		var cleanup strings.Builder
		for _, table := range []string{"hy_memory_nodes", "hy_memory_records", "hy_memory_receipts", "hy_memory_spaces", "hy_memory_namespaces"} {
			fmt.Fprintf(&cleanup, "DELETE FROM %s WHERE tenant_id=OLD.tenant_id AND kb_id=OLD.id;", table)
		}
		for _, event := range []struct{ name, clause string }{
			{"soft", "AFTER UPDATE OF deleted_at ON knowledge_bases WHEN NEW.deleted_at IS NOT NULL"},
			{"hard", "AFTER DELETE ON knowledge_bases"},
		} {
			if err := tx.Exec("CREATE TRIGGER IF NOT EXISTS hy_memory_kb_" + event.name + "_cleanup " + event.clause + " BEGIN " + cleanup.String() + " END").Error; err != nil {
				return err
			}
		}
		// Remove rows from a previously deleted KB when upgrading an existing store.
		for _, table := range []string{"hy_memory_nodes", "hy_memory_records", "hy_memory_receipts", "hy_memory_spaces", "hy_memory_namespaces"} {
			if err := tx.Exec("DELETE FROM " + table + " WHERE NOT EXISTS(SELECT 1 FROM knowledge_bases k WHERE k.tenant_id=" + table + ".tenant_id AND k.id=" + table + ".kb_id AND k.deleted_at IS NULL)").Error; err != nil {
				return err
			}
		}
		return nil
	})
	return s, err
}

// SQLite acquires its writer reservation before any read establishes a snapshot.
// The busy timeout can then wait for another writer without a snapshot-upgrade race.
func (s *Store) writeTransaction(ctx context.Context, scope Scope, operation func(*gorm.DB) error) error {
	s.writer.Lock()
	defer s.writer.Unlock()
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("UPDATE hy_memory_namespaces SET revision=revision WHERE 0").Error; err != nil {
			return err
		}
		var active int64
		if err := tx.Raw("SELECT COUNT(*) FROM knowledge_bases WHERE tenant_id=? AND id=? AND deleted_at IS NULL", scope.Tenant, scope.KB).Scan(&active).Error; err != nil {
			return err
		}
		if active != 1 {
			return ErrInvalid
		}
		return operation(tx)
	})
}
func validScope(scope Scope) error {
	if scope.Tenant == 0 || !identifier.MatchString(scope.KB) || !identifier.MatchString(scope.Namespace) {
		return ErrInvalid
	}
	return nil
}
func whereScope(scope Scope) (string, []interface{}) {
	return "tenant_id=? AND kb_id=? AND namespace=?", []interface{}{scope.Tenant, scope.KB, scope.Namespace}
}
func (s *Store) Read(ctx context.Context, scope Scope) (State, error) {
	result := State{Records: []Record{}}
	if err := validScope(scope); err != nil {
		return result, err
	}
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		where, args := whereScope(scope)
		if err := tx.Raw("SELECT revision FROM hy_memory_namespaces WHERE "+where, args...).Scan(&result.Revision).Error; err != nil {
			return err
		}
		var rows []struct{ Collection, ID, Value string }
		if err := tx.Raw("SELECT collection,id,value FROM hy_memory_records WHERE "+where+" ORDER BY collection,id", args...).Scan(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			result.Records = append(result.Records, Record{row.Collection, row.ID, json.RawMessage(row.Value)})
		}
		return nil
	})
	return result, err
}
func (s *Store) Commit(ctx context.Context, scope Scope, request CommitRequest) (int64, error) {
	if err := validScope(scope); err != nil {
		return 0, err
	}
	if request.ExpectedRevision < 0 || request.ExpectedRevision == math.MaxInt64 || !identifier.MatchString(request.IdempotencyKey) || len(request.Mutations) > maxCommitItems || len(request.IndexOperations) > maxCommitItems {
		return 0, ErrInvalid
	}
	for _, operation := range request.IndexOperations {
		if !identifier.MatchString(operation.Namespace) || (operation.Namespace != scope.Namespace && !strings.HasPrefix(operation.Namespace, scope.Namespace+":")) {
			return 0, ErrInvalid
		}
		switch operation.Operation {
		case "nodes/upsert", "nodes/delete", "nodes/payload":
		default:
			return 0, ErrInvalid
		}
	}
	seen := map[string]bool{}
	for _, m := range request.Mutations {
		key := m.Collection + "\x00" + m.ID
		if !collections[m.Collection] || !identifier.MatchString(m.ID) || seen[key] || (!m.Delete && (!json.Valid(m.Value) || len(m.Value) > maxRecordJSON)) || (m.Delete && len(m.Value) > 0) {
			return 0, ErrInvalid
		}
		seen[key] = true
	}
	encoded, _ := json.Marshal(request)
	hash := sha256.Sum256(encoded)
	requestHash := hex.EncodeToString(hash[:])
	var revision int64
	err := s.writeTransaction(ctx, scope, func(tx *gorm.DB) error {
		where, args := whereScope(scope)
		var receipt struct {
			RequestHash string
			Revision    int64
		}
		result := tx.Raw("SELECT request_hash,revision FROM hy_memory_receipts WHERE "+where+" AND idempotency_key=?", append(args, request.IdempotencyKey)...).Scan(&receipt)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected > 0 {
			if receipt.RequestHash != requestHash {
				return ErrIdempotency
			}
			revision = receipt.Revision
			return nil
		}
		if err := tx.Exec("INSERT OR IGNORE INTO hy_memory_namespaces(tenant_id,kb_id,namespace) VALUES(?,?,?)", args...).Error; err != nil {
			return err
		}
		update := tx.Exec("UPDATE hy_memory_namespaces SET revision=revision+1 WHERE "+where+" AND revision=?", append(args, request.ExpectedRevision)...)
		if update.Error != nil {
			return update.Error
		}
		if update.RowsAffected != 1 {
			return ErrConflict
		}
		revision = request.ExpectedRevision + 1
		for _, m := range request.Mutations {
			values := append(append([]interface{}{}, args...), m.Collection, m.ID)
			if m.Delete {
				if err := tx.Exec("DELETE FROM hy_memory_records WHERE "+where+" AND collection=? AND id=?", values...).Error; err != nil {
					return err
				}
			} else {
				if err := tx.Exec(`INSERT INTO hy_memory_records(tenant_id,kb_id,namespace,collection,id,value) VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,kb_id,namespace,collection,id) DO UPDATE SET value=excluded.value`, append(values, string(m.Value))...).Error; err != nil {
					return err
				}
			}
		}
		// A transaction-bound store uses nested savepoints on this connection.
		// Any failed operation aborts the outer state, receipt and all indexes.
		child := &Store{db: tx}
		for _, operation := range request.IndexOperations {
			target := scope
			target.Namespace = operation.Namespace
			var err error
			switch operation.Operation {
			case "nodes/upsert":
				_, err = child.Upsert(ctx, target, operation.SpaceID, operation.Nodes)
			case "nodes/delete":
				_, err = child.Delete(ctx, target, operation.SpaceID, operation.IDs, operation.Filters)
			case "nodes/payload":
				_, err = child.Patch(ctx, target, operation.SpaceID, operation.IDs, operation.Patch)
			}
			if err != nil {
				return err
			}
		}
		return tx.Exec("INSERT INTO hy_memory_receipts(tenant_id,kb_id,namespace,idempotency_key,request_hash,revision) VALUES(?,?,?,?,?,?)", scope.Tenant, scope.KB, scope.Namespace, request.IdempotencyKey, requestHash, revision).Error
	})
	return revision, err
}
func vecTable(dim int) string { return fmt.Sprintf("hy_memory_vec_%d", dim) }
func vectorDeleteTrigger(tx *gorm.DB, dim int) error {
	if dim < 1 || dim > 65536 {
		return ErrInvalid
	}
	return tx.Exec(fmt.Sprintf("CREATE TRIGGER IF NOT EXISTS hy_memory_node_vec_%d_cleanup AFTER DELETE ON hy_memory_nodes WHEN OLD.dimensions=%d BEGIN DELETE FROM %s WHERE rowid=OLD.rowid; END", dim, dim, vecTable(dim))).Error
}
func (s *Store) BindSpace(ctx context.Context, scope Scope, space, model string, dim int) error {
	if scope.Tenant == 0 || !identifier.MatchString(scope.KB) || !identifier.MatchString(space) || model == "" || dim < 1 || dim > 65536 {
		return ErrInvalid
	}
	return s.writeTransaction(ctx, scope, func(tx *gorm.DB) error {
		var binding struct {
			ModelIdentity string
			Dimensions    int
		}
		result := tx.Raw("SELECT model_identity,dimensions FROM hy_memory_spaces WHERE tenant_id=? AND kb_id=? AND space_id=?", scope.Tenant, scope.KB, space).Scan(&binding)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected > 0 && (binding.ModelIdentity != model || binding.Dimensions != dim) {
			return ErrInvalid
		}
		if err := tx.Exec("CREATE VIRTUAL TABLE IF NOT EXISTS " + vecTable(dim) + fmt.Sprintf(" USING vec0(embedding float[%d] distance_metric=cosine)", dim)).Error; err != nil {
			return err
		}
		var createSQL string
		if err := tx.Raw("SELECT sql FROM sqlite_master WHERE name=?", vecTable(dim)).Scan(&createSQL).Error; err != nil {
			return err
		}
		if !strings.Contains(strings.ToLower(createSQL), "using vec0") {
			return ErrUnsupported
		}
		if err := vectorDeleteTrigger(tx, dim); err != nil {
			return err
		}
		return tx.Exec("INSERT OR IGNORE INTO hy_memory_spaces(tenant_id,kb_id,space_id,model_identity,dimensions) VALUES(?,?,?,?,?)", scope.Tenant, scope.KB, space, model, dim).Error
	})
}
func dimensions(tx *gorm.DB, scope Scope, space string) (int, error) {
	if !identifier.MatchString(space) {
		return 0, ErrInvalid
	}
	var dim int
	result := tx.Raw("SELECT dimensions FROM hy_memory_spaces WHERE tenant_id=? AND kb_id=? AND space_id=?", scope.Tenant, scope.KB, space).Scan(&dim)
	if result.Error != nil {
		return 0, result.Error
	}
	if dim == 0 {
		return 0, ErrInvalid
	}
	return dim, nil
}
func validVector(vector []float32, dim int) bool {
	if len(vector) != dim {
		return false
	}
	// sqlite-vec accumulates cosine magnitudes in float32. Validate at that
	// precision so finite components cannot overflow or underflow its norm.
	norm := float32(0)
	for _, v := range vector {
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			return false
		}
		norm += v * v
	}
	return norm > 0 && !math.IsInf(float64(norm), 0)
}
func terms(content string) []string {
	var output []string
	var word, han []rune
	flush := func() {
		if len(word) > 0 {
			output = append(output, string(word))
			word = nil
		}
		if len(han) == 1 {
			output = append(output, string(han))
		}
		for i := 0; i+1 < len(han); i++ {
			output = append(output, string(han[i:i+2]))
		}
		han = nil
	}
	for _, r := range content {
		if unicode.Is(unicode.Han, r) {
			if len(word) > 0 {
				flush()
			}
			han = append(han, r)
		} else if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' {
			if len(han) > 0 {
				flush()
			}
			word = append(word, unicode.ToLower(r))
		} else {
			flush()
		}
	}
	flush()
	return output
}
func (s *Store) Upsert(ctx context.Context, scope Scope, space string, nodes []Node) ([]string, error) {
	ids := []string{}
	if err := validScope(scope); err != nil {
		return nil, err
	}
	if len(nodes) == 0 || len(nodes) > maxBatch {
		return nil, ErrInvalid
	}
	err := s.writeTransaction(ctx, scope, func(tx *gorm.DB) error {
		dim, err := dimensions(tx, scope, space)
		if err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, node := range nodes {
			var payload map[string]json.RawMessage
			if !identifier.MatchString(node.ID) || len(node.Content) > maxJSON || len(node.Payload) > maxJSON || json.Unmarshal(node.Payload, &payload) != nil || payload == nil || !validVector(node.Vector, dim) || seen[node.ID] {
				return ErrInvalid
			}
			seen[node.ID] = true
			err := tx.Exec(`INSERT INTO hy_memory_nodes(tenant_id,kb_id,namespace,space_id,id,content,payload,active,dimensions) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,kb_id,namespace,space_id,id) DO UPDATE SET content=excluded.content,payload=excluded.payload,active=excluded.active`, scope.Tenant, scope.KB, scope.Namespace, space, node.ID, node.Content, string(node.Payload), node.Active, dim).Error
			if err != nil {
				return err
			}
			var rowid int64
			if err := tx.Raw("SELECT rowid FROM hy_memory_nodes WHERE tenant_id=? AND kb_id=? AND namespace=? AND space_id=? AND id=?", scope.Tenant, scope.KB, scope.Namespace, space, node.ID).Scan(&rowid).Error; err != nil {
				return err
			}
			if err := tx.Exec("DELETE FROM hy_memory_fts WHERE rowid=?", rowid).Error; err != nil {
				return err
			}
			if err := tx.Exec("INSERT INTO hy_memory_fts(rowid,content) VALUES(?,?)", rowid, strings.Join(terms(node.Content), " ")).Error; err != nil {
				return err
			}
			blob, err := sqlitevec.SerializeFloat32(node.Vector)
			if err != nil {
				return err
			}
			if err := tx.Exec("DELETE FROM "+vecTable(dim)+" WHERE rowid=?", rowid).Error; err != nil {
				return err
			}
			if err := tx.Exec("INSERT INTO "+vecTable(dim)+"(rowid,embedding) VALUES(?,?)", rowid, blob).Error; err != nil {
				return err
			}
			ids = append(ids, node.ID)
		}
		return nil
	})
	return ids, err
}

type nodeRow struct {
	Rowid                         int64
	ID, Content, Payload, SpaceID string
	Active                        bool
	Dimensions                    int
	Score                         *float64
}

func nodeWhere(scope Scope, space string, filters Filters) (string, []interface{}, error) {
	if err := validScope(scope); err != nil {
		return "", nil, err
	}
	if space != "" && !identifier.MatchString(space) {
		return "", nil, ErrInvalid
	}
	where := "n.tenant_id=? AND n.kb_id=? AND n.namespace=?"
	args := []interface{}{scope.Tenant, scope.KB, scope.Namespace}
	if space != "" {
		where += " AND n.space_id=?"
		args = append(args, space)
	}
	if len(filters) > len(filterKeys) {
		return "", nil, ErrInvalid
	}
	keys := make([]string, 0, len(filters))
	for key := range filters {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		raw := filters[key]
		if !filterKeys[key] || len(raw) > maxJSON {
			return "", nil, ErrInvalid
		}
		var value interface{}
		if json.Unmarshal(raw, &value) != nil {
			return "", nil, ErrInvalid
		}
		values, ok := value.([]interface{})
		if !ok {
			values = []interface{}{value}
		}
		if len(values) > maxBatch {
			return "", nil, ErrInvalid
		}
		if len(values) == 0 {
			where += " AND 0"
			continue
		}
		placeholders := []string{}
		for _, v := range values {
			switch v.(type) {
			case string, float64, bool:
			default:
				return "", nil, ErrInvalid
			}
			placeholders = append(placeholders, "?")
			args = append(args, v)
		}
		column := "json_extract(n.payload,'$." + key + "')"
		if key == "node_ids" {
			column = "n.id"
		}
		where += " AND " + column + " IN (" + strings.Join(placeholders, ",") + ")"
	}
	return where, args, nil
}
func page(limit, offset int) (int, error) {
	if limit < 0 || limit > maxBatch || offset < 0 || offset > 10000000 {
		return 0, ErrInvalid
	}
	if limit == 0 {
		return 50, nil
	}
	return limit, nil
}
func readNodes(tx *gorm.DB, rows []nodeRow, vectors bool) ([]Node, error) {
	nodes := make([]Node, 0, len(rows))
	for _, row := range rows {
		node := Node{ID: row.ID, Content: row.Content, Payload: json.RawMessage(row.Payload), Active: row.Active, SpaceID: row.SpaceID, Score: row.Score}
		if vectors {
			var blob []byte
			result := tx.Raw("SELECT embedding FROM "+vecTable(row.Dimensions)+" WHERE rowid=?", row.Rowid).Row()
			if err := result.Scan(&blob); err != nil {
				return nil, err
			}
			if len(blob) != row.Dimensions*4 {
				return nil, errors.New("invalid retained memory vector")
			}
			node.Vector = make([]float32, row.Dimensions)
			for i := range node.Vector {
				node.Vector[i] = math.Float32frombits(binary.LittleEndian.Uint32(blob[i*4:]))
			}
		}
		nodes = append(nodes, node)
	}
	return nodes, nil
}
func (s *Store) List(ctx context.Context, scope Scope, request ListRequest) ([]Node, int64, error) {
	limit, err := page(request.Limit, request.Offset)
	if err != nil {
		return nil, 0, err
	}
	where, args, err := nodeWhere(scope, request.SpaceID, request.Filters)
	if err != nil {
		return nil, 0, err
	}
	var total int64
	var nodes []Node
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Raw("SELECT COUNT(*) FROM hy_memory_nodes n WHERE "+where, args...).Scan(&total).Error; err != nil {
			return err
		}
		var rows []nodeRow
		values := append(append([]interface{}{}, args...), limit, request.Offset)
		if err := tx.Raw("SELECT n.* FROM hy_memory_nodes n WHERE "+where+" ORDER BY n.id,n.space_id LIMIT ? OFFSET ?", values...).Scan(&rows).Error; err != nil {
			return err
		}
		var err error
		nodes, err = readNodes(tx, rows, request.IncludeVectors)
		return err
	})
	return nodes, total, err
}
func (s *Store) Get(ctx context.Context, scope Scope, space string, ids []string, vectors bool) ([]Node, error) {
	if !identifier.MatchString(space) || len(ids) > maxBatch {
		return nil, ErrInvalid
	}
	for _, id := range ids {
		if !identifier.MatchString(id) {
			return nil, ErrInvalid
		}
	}
	if len(ids) == 0 {
		return []Node{}, nil
	}
	raw, _ := json.Marshal(ids)
	nodes, _, err := s.List(ctx, scope, ListRequest{SpaceID: space, Filters: Filters{"node_ids": raw}, Limit: maxBatch, IncludeVectors: vectors})
	return nodes, err
}
func (s *Store) Search(ctx context.Context, scope Scope, request SearchRequest) ([]Node, error) {
	limit, err := page(request.Limit, 0)
	if err != nil {
		return nil, err
	}
	if len(request.Query) > 32768 || (request.MinScore != nil && (math.IsNaN(*request.MinScore) || math.IsInf(*request.MinScore, 0))) {
		return nil, ErrInvalid
	}
	where, args, err := nodeWhere(scope, request.SpaceID, request.Filters)
	if err != nil {
		return nil, err
	}
	where += " AND n.active=1"
	var nodes []Node
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var rows []nodeRow
		if len(request.Vector) > 0 {
			if request.Query != "" {
				return ErrInvalid
			}
			dim, err := dimensions(tx, scope, request.SpaceID)
			if err != nil {
				return err
			}
			if !validVector(request.Vector, dim) {
				return ErrInvalid
			}
			blob, err := sqlitevec.SerializeFloat32(request.Vector)
			if err != nil {
				return err
			}
			sql := "SELECT n.*,1-vec_distance_cosine(v.embedding,?) AS score FROM hy_memory_nodes n JOIN " + vecTable(dim) + " v ON v.rowid=n.rowid WHERE " + where
			values := append([]interface{}{blob}, args...)
			if request.MinScore != nil {
				sql += " AND 1-vec_distance_cosine(v.embedding,?)>=?"
				values = append(values, blob, *request.MinScore)
			}
			sql += " ORDER BY score DESC,n.id LIMIT ?"
			values = append(values, limit)
			if err := tx.Raw(sql, values...).Scan(&rows).Error; err != nil {
				return err
			}
		} else {
			words := terms(request.Query)
			if len(words) == 0 {
				return ErrInvalid
			}
			if len(words) > 256 {
				return ErrInvalid
			}
			for i, word := range words {
				words[i] = "\"" + strings.ReplaceAll(word, "\"", "\"\"") + "\""
			}
			query := strings.Join(words, " OR ")
			sql := "SELECT n.*,-bm25(hy_memory_fts) AS score FROM hy_memory_nodes n JOIN hy_memory_fts ON hy_memory_fts.rowid=n.rowid WHERE " + where + " AND hy_memory_fts MATCH ? ORDER BY score DESC,n.id LIMIT ?"
			values := append(append([]interface{}{}, args...), query, limit)
			if err := tx.Raw(sql, values...).Scan(&rows).Error; err != nil {
				return err
			}
		}
		var err error
		nodes, err = readNodes(tx, rows, request.IncludeVectors)
		return err
	})
	return nodes, err
}
func (s *Store) Delete(ctx context.Context, scope Scope, space string, ids []string, filters Filters) (int64, error) {
	if err := validScope(scope); err != nil {
		return 0, err
	}
	if ids != nil && len(ids) == 0 {
		return 0, nil
	}
	if len(ids) > maxBatch {
		return 0, ErrInvalid
	}
	effective := Filters{}
	for key, value := range filters {
		effective[key] = value
	}
	if len(ids) > 0 {
		for _, id := range ids {
			if !identifier.MatchString(id) {
				return 0, ErrInvalid
			}
		}
		if _, exists := effective["node_ids"]; exists {
			return 0, ErrInvalid
		}
		raw, _ := json.Marshal(ids)
		effective["node_ids"] = raw
	}
	where, args, err := nodeWhere(scope, space, effective)
	if err != nil {
		return 0, err
	}
	var deleted int64
	err = s.writeTransaction(ctx, scope, func(tx *gorm.DB) error {
		// Every selected row is removed in one transaction, so paging cannot skip rows after deletion.
		var rows []nodeRow
		if err := tx.Raw("SELECT n.rowid,n.dimensions FROM hy_memory_nodes n WHERE "+where, args...).Scan(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			if err := tx.Exec("DELETE FROM "+vecTable(row.Dimensions)+" WHERE rowid=?", row.Rowid).Error; err != nil {
				return err
			}
			if err := tx.Exec("DELETE FROM hy_memory_fts WHERE rowid=?", row.Rowid).Error; err != nil {
				return err
			}
			if err := tx.Exec("DELETE FROM hy_memory_nodes WHERE rowid=?", row.Rowid).Error; err != nil {
				return err
			}
		}
		deleted = int64(len(rows))
		return nil
	})
	return deleted, err
}
func (s *Store) Patch(ctx context.Context, scope Scope, space string, ids []string, patch json.RawMessage) (int64, error) {
	var fields map[string]json.RawMessage
	if !identifier.MatchString(space) || len(ids) == 0 || len(ids) > maxBatch || len(patch) > maxJSON || json.Unmarshal(patch, &fields) != nil || fields == nil {
		return 0, ErrInvalid
	}
	for _, id := range ids {
		if !identifier.MatchString(id) {
			return 0, ErrInvalid
		}
	}
	raw, _ := json.Marshal(ids)
	where, args, err := nodeWhere(scope, space, Filters{"node_ids": raw})
	if err != nil {
		return 0, err
	}
	var updated int64
	err = s.writeTransaction(ctx, scope, func(tx *gorm.DB) error {
		var rows []nodeRow
		if err := tx.Raw("SELECT n.* FROM hy_memory_nodes n WHERE "+where, args...).Scan(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			var payload map[string]json.RawMessage
			if err := json.Unmarshal([]byte(row.Payload), &payload); err != nil {
				return err
			}
			for key, value := range fields {
				payload[key] = value
			}
			encoded, err := json.Marshal(payload)
			if err != nil {
				return err
			}
			if len(encoded) > maxJSON {
				return ErrInvalid
			}
			if err := tx.Exec("UPDATE hy_memory_nodes SET payload=? WHERE rowid=?", string(encoded), row.Rowid).Error; err != nil {
				return err
			}
		}
		updated = int64(len(rows))
		return nil
	})
	return updated, err
}
