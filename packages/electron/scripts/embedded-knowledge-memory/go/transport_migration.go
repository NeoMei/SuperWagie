// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package memoryindex

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"math"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/Tencent/WeKnora/internal/utils"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// TransportRequest is a private stdin contract for the offline operator. No
// request, snapshot or SQL error may be copied into a public log or manifest.
// The host owns source-policy eligibility; the frozen raw ledger binds its
// decision to the exact writer-reserved snapshot used here.
type TransportRequest struct {
	Mode                 string                 `json:"mode"`
	Database             string                 `json:"database"`
	ConfigDir            string                 `json:"configDir"`
	TenantID             uint64                 `json:"tenantId"`
	KBID                 string                 `json:"kbId"`
	OwnerID              string                 `json:"ownerId"`
	ModelID              string                 `json:"modelId"`
	TargetParameters     *types.ModelParameters `json:"targetParameters,omitempty"`
	CatalogDigest        string                 `json:"catalogDigest"`
	Expected             *TransportPreview      `json:"expected,omitempty"`
	OperationID          string                 `json:"operationId,omitempty"`
	CompatibilityReceipt string                 `json:"compatibilityReceipt,omitempty"`
	BackupReceipt        TransportBackup        `json:"backupReceipt"`
	StoppedReceipt       TransportStopped       `json:"stoppedReceipt"`
	SelectedNodes        []TransportSelection   `json:"selectedNodes,omitempty"`
	LedgerMutations      []TransportMutation    `json:"ledgerMutations,omitempty"`
}
type TransportBackup struct {
	SHA256         string `json:"sha256"`
	Restored       bool   `json:"restored"`
	BaselineDigest string `json:"baselineDigest"`
}
type TransportStopped struct {
	Stopped        bool   `json:"stopped"`
	EvidenceDigest string `json:"evidenceDigest"`
}
type TransportIdentity struct {
	ConfigurationID string `json:"configurationId"`
	SpaceID         string `json:"spaceId"`
	ModelIdentity   string `json:"modelIdentity"`
	Dimensions      int    `json:"dimensions"`
}
type TransportRecordKey struct {
	Collection string `json:"collection"`
	ID         string `json:"id"`
}
type TransportSelection struct {
	Namespace          string               `json:"namespace"`
	SourceSpaceID      string               `json:"sourceSpaceId"`
	NodeID             string               `json:"nodeId"`
	ExpectedNodeDigest string               `json:"expectedNodeDigest"`
	AuthorityRecordIDs []TransportRecordKey `json:"authorityRecordIds"`
	TargetSpaceID      string               `json:"targetSpaceId"`
}
type TransportMutation struct {
	Collection string `json:"collection"`
	ID         string `json:"id"`
	ValueRaw   string `json:"valueRaw"`
}
type TransportRawRecord struct {
	Collection string `json:"collection"`
	ID         string `json:"id"`
	ValueRaw   string `json:"valueRaw"`
}
type TransportLedger struct {
	Namespace string               `json:"namespace"`
	Revision  int64                `json:"revision"`
	Records   []TransportRawRecord `json:"records"`
}
type TransportNode struct {
	Namespace       string `json:"namespace"`
	SpaceID         string `json:"spaceId"`
	ID              string `json:"id"`
	Content         string `json:"content"`
	PayloadRaw      string `json:"payloadRaw"`
	Active          bool   `json:"active"`
	Dimensions      int    `json:"dimensions"`
	VectorFloat32LE []byte `json:"vectorFloat32LE"`
	Digest          string `json:"digest"`
}
type TransportPreview struct {
	DatabaseIdentity            string            `json:"databaseIdentity"`
	Current                     TransportIdentity `json:"current"`
	Target                      TransportIdentity `json:"target"`
	LedgerRevision              int64             `json:"ledgerRevision"`
	LedgerDigest                string            `json:"ledgerDigest"`
	SourceNodesDigest           string            `json:"sourceNodesDigest"`
	ModelSpaceDigest            string            `json:"modelSpaceDigest"`
	KnowledgeDigest             string            `json:"knowledgeDigest"`
	RetainedDigest              string            `json:"retainedDigest"`
	CatalogDigest               string            `json:"catalogDigest"`
	TargetCredentialFingerprint string            `json:"targetCredentialFingerprint"`
	NodeCount                   int               `json:"nodeCount"`
	InactiveCount               int               `json:"inactiveCount"`
	RecordCount                 int               `json:"recordCount"`
	Digest                      string            `json:"digest"`
}
type TransportSnapshot struct {
	RawLedger   TransportLedger `json:"rawLedger"`
	ScopedNodes []TransportNode `json:"scopedNodes"`
	Model       struct {
		ID         string                `json:"id"`
		Name       string                `json:"name"`
		Type       types.ModelType       `json:"type"`
		Source     types.ModelSource     `json:"source"`
		Parameters types.ModelParameters `json:"parameters"`
	} `json:"model"`
}
type TransportResponse struct {
	Status   string             `json:"status"`
	Preview  TransportPreview   `json:"preview"`
	Snapshot *TransportSnapshot `json:"snapshot,omitempty"`
	Copied   int                `json:"copied,omitempty"`
	Revision int64              `json:"revision,omitempty"`
}

var errTransport = errors.New("transport_migration_rejected")

const transportLedgerNamespace = "superwagie:memory"

func transportFrame(h hash.Hash, b []byte) {
	var n [8]byte
	binary.BigEndian.PutUint64(n[:], uint64(len(b)))
	h.Write(n[:])
	h.Write(b)
}
func transportHash(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		transportFrame(h, []byte(p))
	}
	return hex.EncodeToString(h.Sum(nil))
}
func transportNamespace(project string) string {
	h := sha256.Sum256([]byte(project))
	return transportLedgerNamespace + ":" + hex.EncodeToString(h[:])
}
func transportEngineID(project, collection, id string) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode([]string{project, collection, id})
	h := sha256.Sum256(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
	return "hy:" + hex.EncodeToString(h[:])
}
func transportIdentity(model *types.Model) (TransportIdentity, error) {
	s, m, e := modelSpace(model, 1024)
	if e != nil {
		return TransportIdentity{}, e
	}
	_, c, e := modelSpace(model, 0)
	return TransportIdentity{c, s, m, 1024}, e
}
func transportDigest(v interface{}) string { b, _ := json.Marshal(v); return transportHash(string(b)) }
func transportScope(r TransportRequest) Scope {
	return Scope{r.TenantID, r.KBID, transportLedgerNamespace}
}
func transportHex(s string) bool {
	b, e := hex.DecodeString(s)
	return e == nil && len(b) == 32 && s == strings.ToLower(s)
}

// RunTransportMigration never creates a Store or a schema. All writes, including
// vector copies and the durable receipt, share one reserved SQLite transaction.
func RunTransportMigration(ctx context.Context, db *gorm.DB, request TransportRequest) (response TransportResponse, err error) {
	defer func() {
		if err != nil {
			err = errTransport
		}
	}()
	if db == nil || db.Dialector.Name() != "sqlite" || validScope(transportScope(request)) != nil || !identifier.MatchString(request.OwnerID) || !identifier.MatchString(request.ModelID) || len(utils.GetAESKey()) != 32 {
		return response, errTransport
	}
	if request.Mode != "preview" && request.Mode != "snapshot" && request.Mode != "apply" && request.Mode != "verify" {
		return response, errTransport
	}
	if request.Mode != "snapshot" && request.TargetParameters == nil {
		return response, errTransport
	}
	if len(request.SelectedNodes) > maxBatch || len(request.LedgerMutations) > maxBatch {
		return response, errTransport
	}
	// Explicitly silence caller loggers too: Gorm SQL errors can include secrets.
	db = db.Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Silent)}).WithContext(ctx)
	write := request.Mode == "apply"
	err = db.Transaction(func(tx *gorm.DB) error {
		if write {
			if e := tx.Exec("UPDATE hy_memory_namespaces SET revision=revision WHERE 0").Error; e != nil {
				return e
			}
		}
		if request.Mode == "apply" || request.Mode == "verify" {
			if request.Expected == nil || !identifier.MatchString(request.OperationID) || !transportHex(request.CompatibilityReceipt) || !request.BackupReceipt.Restored || !transportHex(request.BackupReceipt.SHA256) || request.BackupReceipt.BaselineDigest != request.Expected.Digest || !request.StoppedReceipt.Stopped || !transportHex(request.StoppedReceipt.EvidenceDigest) || len(request.SelectedNodes) == 0 || len(request.LedgerMutations) == 0 {
				return errTransport
			}
		}
		snapshot, preview, model, raw, e := transportRead(tx, request)
		if e != nil {
			return e
		}
		response = TransportResponse{Status: "preview", Preview: preview}
		if request.Mode == "snapshot" {
			response.Status = "private-snapshot"
			response.Snapshot = &snapshot
			return nil
		}
		if request.Mode == "preview" {
			return nil
		}
		requestHash := transportRequestHash(request)
		var receipt struct {
			RequestHash string
			Revision    int64
		}
		found := tx.Raw(`SELECT request_hash,revision FROM hy_memory_receipts WHERE tenant_id=? AND kb_id=? AND namespace=? AND idempotency_key=?`, request.TenantID, request.KBID, transportLedgerNamespace, request.OperationID).Scan(&receipt)
		if found.Error != nil {
			return found.Error
		}
		if found.RowsAffected > 0 {
			if receipt.RequestHash != requestHash+":"+preview.Digest || receipt.Revision != preview.LedgerRevision {
				return errTransport
			}
			if e := transportVerifyCopies(tx, request, snapshot, preview); e != nil {
				return e
			}
			response.Status = "already-applied"
			if request.Mode == "verify" {
				response.Status = "verified"
			}
			response.Copied = len(request.SelectedNodes)
			response.Revision = receipt.Revision
			return nil
		}
		if request.Mode == "verify" || !reflect.DeepEqual(preview, *request.Expected) {
			return errTransport
		}
		nodes, e := transportValidatePlan(request, snapshot, preview)
		if e != nil {
			return e
		}
		var targets int64
		if e := tx.Raw(`SELECT count(*) FROM hy_memory_nodes WHERE tenant_id=? AND kb_id=? AND space_id=?`, request.TenantID, request.KBID, preview.Target.SpaceID).Scan(&targets).Error; e != nil || targets != 0 {
			return errTransport
		}
		// Require a fresh target binding. An existing target is only valid with the
		// exact operator receipt above; it must never merge unrelated old attempts.
		if e := tx.Raw(`SELECT count(*) FROM hy_memory_spaces WHERE tenant_id=? AND kb_id=? AND space_id=?`, request.TenantID, request.KBID, preview.Target.SpaceID).Scan(&targets).Error; e != nil || targets != 0 {
			return errTransport
		}
		persisted, e := transportEncryptedParameters(raw, *request.TargetParameters)
		if e != nil {
			return e
		}
		update := tx.Exec(`UPDATE models SET parameters=? WHERE id=? AND tenant_id=? AND CAST(parameters AS BLOB)=? AND deleted_at IS NULL AND is_builtin=0 AND COALESCE(managed_by,'')=''`, []byte(persisted), model.ID, request.TenantID, []byte(raw))
		if update.Error != nil || update.RowsAffected != 1 {
			return errTransport
		}
		store := &Store{db: tx}
		if e := store.BindSpace(ctx, transportScope(request), preview.Target.SpaceID, preview.Target.ModelIdentity, 1024); e != nil {
			return e
		}
		for _, n := range nodes {
			vector := make([]float32, 1024)
			for i := range vector {
				vector[i] = math.Float32frombits(binary.LittleEndian.Uint32(n.VectorFloat32LE[i*4:]))
			}
			scope := transportScope(request)
			scope.Namespace = n.Namespace
			if _, e := store.Upsert(ctx, scope, preview.Target.SpaceID, []Node{{ID: n.ID, Content: n.Content, Payload: json.RawMessage(n.PayloadRaw), Active: n.Active, Vector: vector}}); e != nil {
				return e
			}
		}
		for _, m := range request.LedgerMutations {
			result := tx.Exec(`UPDATE hy_memory_records SET value=? WHERE tenant_id=? AND kb_id=? AND namespace=? AND collection=? AND id=?`, m.ValueRaw, request.TenantID, request.KBID, transportLedgerNamespace, m.Collection, m.ID)
			if result.Error != nil || result.RowsAffected != 1 {
				return errTransport
			}
		}
		changed := tx.Exec(`UPDATE hy_memory_namespaces SET revision=revision+1 WHERE tenant_id=? AND kb_id=? AND namespace=? AND revision=?`, request.TenantID, request.KBID, transportLedgerNamespace, preview.LedgerRevision)
		if changed.Error != nil || changed.RowsAffected != 1 {
			return errTransport
		}
		after, post, _, _, e := transportRead(tx, request)
		if e != nil {
			return e
		}
		if post.SourceNodesDigest != preview.SourceNodesDigest || post.KnowledgeDigest != preview.KnowledgeDigest || post.RetainedDigest != preview.RetainedDigest || post.LedgerRevision != preview.LedgerRevision+1 {
			return errTransport
		}
		if e := transportVerifyCopies(tx, request, after, post); e != nil {
			return e
		}
		if e := tx.Exec(`INSERT INTO hy_memory_receipts(tenant_id,kb_id,namespace,idempotency_key,request_hash,revision) VALUES(?,?,?,?,?,?)`, request.TenantID, request.KBID, transportLedgerNamespace, request.OperationID, requestHash+":"+post.Digest, post.LedgerRevision).Error; e != nil {
			return e
		}
		response = TransportResponse{Status: "applied", Preview: post, Copied: len(nodes), Revision: post.LedgerRevision}
		return nil
	})
	return response, err
}

func transportRequestHash(r TransportRequest) string {
	r.Mode = "apply"
	b, _ := json.Marshal(r)
	h := hmac.New(sha256.New, utils.GetAESKey())
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}
func transportCredentialFingerprint(p *types.ModelParameters) string {
	if p == nil {
		return ""
	}
	h := hmac.New(sha256.New, utils.GetAESKey())
	transportFrame(h, []byte("hy-transport-credential-v1"))
	transportFrame(h, []byte(p.APIKey))
	transportFrame(h, []byte(p.AppSecret))
	return hex.EncodeToString(h.Sum(nil))
}

func transportRead(tx *gorm.DB, r TransportRequest) (TransportSnapshot, TransportPreview, *types.Model, string, error) {
	snapshot := TransportSnapshot{RawLedger: TransportLedger{Namespace: transportLedgerNamespace, Records: []TransportRawRecord{}}, ScopedNodes: []TransportNode{}}
	var database string
	if tx.Raw(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&database).Error != nil {
		return snapshot, TransportPreview{}, nil, "", errTransport
	}
	p := TransportPreview{DatabaseIdentity: transportHash("hy-transport-database-v1", database), CatalogDigest: r.CatalogDigest, TargetCredentialFingerprint: transportCredentialFingerprint(r.TargetParameters)}
	fail := func() (TransportSnapshot, TransportPreview, *types.Model, string, error) {
		return snapshot, p, nil, "", errTransport
	}
	var catalog []struct {
		ID      int
		Version int
		Overlay string
	}
	if tx.Raw(`SELECT id,version,overlay FROM model_catalog_configs`).Scan(&catalog).Error != nil || len(catalog) != 1 || catalog[0].ID != 1 || catalog[0].Version != 0 {
		return fail()
	}
	var overlay map[string]interface{}
	if json.Unmarshal([]byte(catalog[0].Overlay), &overlay) != nil || !reflect.DeepEqual(overlay, map[string]interface{}{"providers": map[string]interface{}{}}) {
		return fail()
	}
	var count int64
	for _, check := range []struct {
		query string
		args  []interface{}
	}{
		{`SELECT count(*) FROM knowledge_bases WHERE id=? AND tenant_id=? AND creator_id=? AND embedding_model_id=? AND deleted_at IS NULL`, []interface{}{r.KBID, r.TenantID, r.OwnerID, r.ModelID}},
		{`SELECT count(*) FROM users WHERE id=? AND tenant_id=? AND is_active=1 AND deleted_at IS NULL`, []interface{}{r.OwnerID, r.TenantID}},
	} {
		if e := tx.Raw(check.query, check.args...).Scan(&count).Error; e != nil || count != 1 {
			return fail()
		}
	}
	if e := tx.Raw(`SELECT count(*) FROM knowledge_bases WHERE embedding_model_id=? AND (id<>? OR tenant_id<>?) AND deleted_at IS NULL`, r.ModelID, r.KBID, r.TenantID).Scan(&count).Error; e != nil || count != 0 {
		return fail()
	}
	if e := tx.Raw(`SELECT count(*) FROM knowledges WHERE embedding_model_id=? AND (knowledge_base_id<>? OR tenant_id<>?)`, r.ModelID, r.KBID, r.TenantID).Scan(&count).Error; e != nil || count != 0 {
		return fail()
	}
	var row struct {
		ID         string
		TenantID   uint64
		Name       string
		Type       types.ModelType
		Source     types.ModelSource
		Parameters string
	}
	result := tx.Raw(`SELECT id,tenant_id,name,type,source,parameters FROM models WHERE id=? AND tenant_id=? AND deleted_at IS NULL AND is_builtin=0 AND COALESCE(managed_by,'')=''`, r.ModelID, r.TenantID).Scan(&row)
	if result.Error != nil || result.RowsAffected != 1 || row.Name != "text-embedding-v4" || row.Type != types.ModelTypeEmbedding || row.Source != types.ModelSourceRemote {
		return fail()
	}
	var stored map[string]json.RawMessage
	if json.Unmarshal([]byte(row.Parameters), &stored) != nil {
		return fail()
	}
	// Validate encrypted secrets strictly before calling the lenient native Scan.
	for _, field := range []string{"api_key", "app_secret"} {
		if b, ok := stored[field]; ok {
			var value string
			if json.Unmarshal(b, &value) != nil {
				return fail()
			}
			if _, e := utils.DecryptStoredSecret(value); e != nil {
				return fail()
			}
		}
	}
	model := &types.Model{ID: row.ID, TenantID: row.TenantID, Name: row.Name, Type: row.Type, Source: row.Source}
	if model.Parameters.Scan([]byte(row.Parameters)) != nil || model.Parameters.EmbeddingParameters.Dimension != 1024 {
		return fail()
	}
	// The scoped operator cannot classify arbitrary header/extra credentials for
	// the secret-free planner snapshot. Refuse them instead of returning values.
	if len(model.Parameters.CustomHeaders) != 0 {
		return fail()
	}
	for key := range model.Parameters.ExtraConfig {
		if key != "api" && key != "remote_model_name" && key != "api_version" {
			return fail()
		}
	}
	current, e := transportIdentity(model)
	if e != nil {
		return fail()
	}
	p.Current = current
	p.Target = current
	if r.TargetParameters != nil {
		if e := transportTarget(model.Parameters, *r.TargetParameters); e != nil {
			return fail()
		}
		target := *model
		target.Parameters = *r.TargetParameters
		p.Target, e = transportIdentity(&target)
		if e != nil {
			return fail()
		}
	}
	if r.Expected != nil && (r.Mode == "apply" || r.Mode == "verify") {
		p.Current = r.Expected.Current
		if current != p.Current && current != p.Target {
			return fail()
		}
	}
	if p.Current.SpaceID == p.Target.SpaceID && r.Mode != "snapshot" {
		return fail()
	}
	var binding struct {
		ModelIdentity string
		Dimensions    int
	}
	result = tx.Raw(`SELECT model_identity,dimensions FROM hy_memory_spaces WHERE tenant_id=? AND kb_id=? AND space_id=?`, r.TenantID, r.KBID, p.Current.SpaceID).Scan(&binding)
	if result.Error != nil || result.RowsAffected != 1 || binding.ModelIdentity != p.Current.ModelIdentity || binding.Dimensions != 1024 {
		return fail()
	}
	result = tx.Raw(`SELECT revision FROM hy_memory_namespaces WHERE tenant_id=? AND kb_id=? AND namespace=?`, r.TenantID, r.KBID, transportLedgerNamespace).Scan(&snapshot.RawLedger.Revision)
	if result.Error != nil || result.RowsAffected != 1 {
		return fail()
	}
	var records []struct{ Collection, ID, Value string }
	if e := tx.Raw(`SELECT collection,id,value FROM hy_memory_records WHERE tenant_id=? AND kb_id=? AND namespace=? ORDER BY collection COLLATE BINARY,id COLLATE BINARY`, r.TenantID, r.KBID, transportLedgerNamespace).Scan(&records).Error; e != nil {
		return fail()
	}
	ledgerHash := sha256.New()
	for _, v := range []string{"hy-transport-ledger-v1", strconv.FormatUint(r.TenantID, 10), r.KBID, transportLedgerNamespace, strconv.FormatInt(snapshot.RawLedger.Revision, 10), strconv.Itoa(len(records))} {
		transportFrame(ledgerHash, []byte(v))
	}
	control := 0
	for _, record := range records {
		if record.Collection == "meta" && record.ID == "control" {
			control++
		}
		snapshot.RawLedger.Records = append(snapshot.RawLedger.Records, TransportRawRecord{record.Collection, record.ID, record.Value})
		for _, v := range []string{record.Collection, record.ID, record.Value} {
			transportFrame(ledgerHash, []byte(v))
		}
	}
	if control != 1 {
		return fail()
	}
	p.LedgerDigest = hex.EncodeToString(ledgerHash.Sum(nil))
	p.LedgerRevision = snapshot.RawLedger.Revision
	p.RecordCount = len(records)
	snapshot.ScopedNodes, e = transportReadNodes(tx, r, p.Current.SpaceID)
	if e != nil {
		return fail()
	}
	nodeSet := sha256.New()
	for _, v := range []string{"hy-transport-node-set-v1", strconv.FormatUint(r.TenantID, 10), r.KBID, strconv.Itoa(len(snapshot.ScopedNodes))} {
		transportFrame(nodeSet, []byte(v))
	}
	for _, node := range snapshot.ScopedNodes {
		digest, _ := hex.DecodeString(node.Digest)
		transportFrame(nodeSet, digest)
		if !node.Active {
			p.InactiveCount++
		}
	}
	p.SourceNodesDigest = hex.EncodeToString(nodeSet.Sum(nil))
	p.NodeCount = len(snapshot.ScopedNodes)
	p.KnowledgeDigest, e = transportKnowledgeDigest(tx)
	if e != nil {
		return fail()
	}
	h := sha256.New()
	for _, q := range []struct {
		sql  string
		args []interface{}
	}{
		{`SELECT * FROM model_catalog_configs ORDER BY id`, nil},
		{`SELECT * FROM models WHERE id=? AND tenant_id=?`, []interface{}{r.ModelID, r.TenantID}},
		{`SELECT * FROM knowledge_bases WHERE id=? AND tenant_id=?`, []interface{}{r.KBID, r.TenantID}},
		{`SELECT * FROM hy_memory_spaces WHERE tenant_id=? AND kb_id=? ORDER BY space_id`, []interface{}{r.TenantID, r.KBID}},
	} {
		if e := transportSQLHash(tx, h, q.sql, q.args...); e != nil {
			return fail()
		}
	}
	p.ModelSpaceDigest = hex.EncodeToString(h.Sum(nil))
	retained := sha256.New()
	for _, q := range []struct {
		sql  string
		args []interface{}
	}{
		{`SELECT * FROM model_catalog_configs ORDER BY id`, nil},
		{`SELECT * FROM hy_memory_spaces WHERE tenant_id=? AND kb_id=? AND space_id<>? ORDER BY space_id`, []interface{}{r.TenantID, r.KBID, p.Target.SpaceID}},
		{`SELECT * FROM hy_memory_records WHERE tenant_id=? AND kb_id=? AND namespace<>? ORDER BY namespace,collection,id`, []interface{}{r.TenantID, r.KBID, transportLedgerNamespace}},
		{`SELECT * FROM hy_memory_namespaces WHERE tenant_id=? AND kb_id=? AND namespace<>? ORDER BY namespace`, []interface{}{r.TenantID, r.KBID, transportLedgerNamespace}},
		{`SELECT * FROM hy_memory_receipts WHERE tenant_id=? AND kb_id=? AND NOT(namespace=? AND idempotency_key=?) ORDER BY namespace,idempotency_key`, []interface{}{r.TenantID, r.KBID, transportLedgerNamespace, r.OperationID}},
		{`SELECT * FROM hy_memory_nodes WHERE tenant_id=? AND kb_id=? AND space_id<>? ORDER BY rowid`, []interface{}{r.TenantID, r.KBID, p.Target.SpaceID}},
	} {
		if e := transportSQLHash(tx, retained, q.sql, q.args...); e != nil {
			return fail()
		}
	}
	var dimensions []int
	if tx.Raw(`SELECT DISTINCT dimensions FROM hy_memory_nodes WHERE tenant_id=? AND kb_id=? AND space_id<>? ORDER BY dimensions`, r.TenantID, r.KBID, p.Target.SpaceID).Scan(&dimensions).Error != nil {
		return fail()
	}
	for _, dim := range dimensions {
		if dim < 1 || dim > 65536 {
			return fail()
		}
		query := `SELECT n.rowid,v.embedding FROM hy_memory_nodes n LEFT JOIN ` + vecTable(dim) + ` v ON v.rowid=n.rowid WHERE n.tenant_id=? AND n.kb_id=? AND n.space_id<>? AND n.dimensions=? ORDER BY n.rowid`
		if transportSQLHash(tx, retained, query, r.TenantID, r.KBID, p.Target.SpaceID, dim) != nil {
			return fail()
		}
	}
	if transportSQLHash(tx, retained, `SELECT n.rowid,f.content FROM hy_memory_nodes n LEFT JOIN hy_memory_fts f ON f.rowid=n.rowid WHERE n.tenant_id=? AND n.kb_id=? AND n.space_id<>? ORDER BY n.rowid`, r.TenantID, r.KBID, p.Target.SpaceID) != nil {
		return fail()
	}
	p.RetainedDigest = hex.EncodeToString(retained.Sum(nil))
	p.Digest = transportDigest(p)
	snapshot.Model.ID = model.ID
	snapshot.Model.Name = model.Name
	snapshot.Model.Type = model.Type
	snapshot.Model.Source = model.Source
	snapshot.Model.Parameters = model.Parameters
	snapshot.Model.Parameters.APIKey = ""
	snapshot.Model.Parameters.AppSecret = ""
	return snapshot, p, model, row.Parameters, nil
}

func transportTarget(old, target types.ModelParameters) error {
	parsed, e := url.Parse(target.BaseURL)
	if e != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || target.Provider != "openai" || strings.TrimSpace(target.APIKey) == "" || target.EmbeddingParameters.Dimension != 1024 {
		return errTransport
	}
	// Preserve the Aliyun v4 request ceiling after selecting the OpenAI adapter.
	// This operator admits only the reviewed nil-spec transition and exact replay.
	reviewed := &types.ModelSpecOverride{Compat: map[string]any{"max_batch_size": float64(10)}}
	if !reflect.DeepEqual(target.Spec, reviewed) || old.Spec != nil && !reflect.DeepEqual(old.Spec, reviewed) {
		return errTransport
	}
	old.Spec = reviewed
	old.BaseURL = target.BaseURL
	old.Provider = target.Provider
	old.APIKey = target.APIKey
	if !reflect.DeepEqual(old, target) {
		return errTransport
	}
	return nil
}
func transportEncryptedParameters(raw string, target types.ModelParameters) (string, error) {
	encoded, e := target.Value()
	if e != nil {
		return "", e
	}
	b, ok := encoded.([]byte)
	if !ok {
		return "", errTransport
	}
	var roundtrip types.ModelParameters
	if roundtrip.Scan(b) != nil || !reflect.DeepEqual(target, roundtrip) {
		return "", errTransport
	}
	var original, updated map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &original) != nil || json.Unmarshal(b, &updated) != nil {
		return "", errTransport
	}
	var key string
	if json.Unmarshal(updated["api_key"], &key) != nil || !strings.HasPrefix(key, "enc:v1:") || key == target.APIKey {
		return "", errTransport
	}
	for _, field := range []string{"base_url", "provider", "api_key", "spec"} {
		original[field] = updated[field]
	}
	result, e := json.Marshal(original)
	return string(result), e
}

func transportReadNodes(tx *gorm.DB, r TransportRequest, space string) ([]TransportNode, error) {
	var rows []struct {
		Namespace, SpaceID, ID, Content, Payload string
		Active                                   bool
		Dimensions                               int
		Embedding                                []byte
	}
	result := tx.Raw(`SELECT n.namespace,n.space_id,n.id,n.content,n.payload,n.active,n.dimensions,v.embedding FROM hy_memory_nodes n LEFT JOIN hy_memory_vec_1024 v ON v.rowid=n.rowid WHERE n.tenant_id=? AND n.kb_id=? AND n.space_id=? ORDER BY n.namespace COLLATE BINARY,n.space_id COLLATE BINARY,n.id COLLATE BINARY`, r.TenantID, r.KBID, space).Scan(&rows)
	if result.Error != nil {
		return nil, result.Error
	}
	nodes := make([]TransportNode, 0, len(rows))
	for _, row := range rows {
		if row.Dimensions != 1024 || len(row.Embedding) != 4096 {
			return nil, errTransport
		}
		n := TransportNode{Namespace: row.Namespace, SpaceID: row.SpaceID, ID: row.ID, Content: row.Content, PayloadRaw: row.Payload, Active: row.Active, Dimensions: row.Dimensions, VectorFloat32LE: row.Embedding}
		h := sha256.New()
		active := "0"
		if n.Active {
			active = "1"
		}
		for _, v := range []string{"hy-transport-node-v1", strconv.FormatUint(r.TenantID, 10), r.KBID, n.Namespace, n.SpaceID, n.ID, n.Content, n.PayloadRaw, active, strconv.Itoa(n.Dimensions)} {
			transportFrame(h, []byte(v))
		}
		transportFrame(h, n.VectorFloat32LE)
		n.Digest = hex.EncodeToString(h.Sum(nil))
		nodes = append(nodes, n)
	}
	return nodes, nil
}

// SQL text comes only from fixed operator queries. Stream rows so the 87k
// document vectors do not become a second in-memory copy of the corpus.
func transportSQLHash(tx *gorm.DB, h hash.Hash, query string, args ...interface{}) error {
	rows, e := tx.Raw(query, args...).Rows()
	if e != nil {
		return e
	}
	defer rows.Close()
	columns, e := rows.Columns()
	if e != nil {
		return e
	}
	transportFrame(h, []byte(query))
	for _, c := range columns {
		transportFrame(h, []byte(c))
	}
	values := make([]interface{}, len(columns))
	dest := make([]interface{}, len(columns))
	for i := range values {
		dest[i] = &values[i]
	}
	var count int64
	for rows.Next() {
		if e := rows.Scan(dest...); e != nil {
			return e
		}
		for _, v := range values {
			var kind string
			var b []byte
			switch x := v.(type) {
			case nil:
				kind = "null"
			case []byte:
				kind = "bytes"
				b = x
			case string:
				kind = "text"
				b = []byte(x)
			case int64:
				kind = "integer"
				b = []byte(strconv.FormatInt(x, 10))
			case float64:
				kind = "float"
				b = []byte(strconv.FormatFloat(x, 'g', -1, 64))
			case bool:
				kind = "boolean"
				b = []byte(strconv.FormatBool(x))
			case time.Time:
				kind = "time"
				b = []byte(x.UTC().Format(time.RFC3339Nano))
			default:
				return errTransport
			}
			transportFrame(h, []byte(kind))
			transportFrame(h, b)
		}
		count++
	}
	transportFrame(h, []byte(strconv.FormatInt(count, 10)))
	return rows.Err()
}
func transportKnowledgeDigest(tx *gorm.DB) (string, error) {
	h := sha256.New()
	for _, table := range []string{"knowledges", "chunks", "chunk_images", "chunk_revisions", "lite_embeddings"} {
		if e := transportSQLHash(tx, h, "SELECT * FROM "+table+" ORDER BY rowid"); e != nil {
			return "", e
		}
	}
	if e := transportSQLHash(tx, h, "SELECT rowid,embedding FROM vec_embeddings_1024 ORDER BY rowid"); e != nil {
		return "", e
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Only the two native identity fields inside an existing canonical engine row
// may change. Unknown engine metadata and source hashes are compared intact.
func transportValidatePlan(r TransportRequest, s TransportSnapshot, p TransportPreview) ([]TransportNode, error) {
	records := map[string]TransportRawRecord{}
	for _, row := range s.RawLedger.Records {
		records[row.Collection+"\x00"+row.ID] = row
	}
	allowed := map[string]string{}
	seen := map[string]bool{}
	for _, row := range s.RawLedger.Records {
		if row.Collection != "entry" || !strings.HasPrefix(row.ID, "hy:") {
			continue
		}
		var engine struct {
			Collection string          `json:"collection"`
			Value      json.RawMessage `json:"value"`
		}
		if json.Unmarshal([]byte(row.ValueRaw), &engine) != nil {
			return nil, errTransport
		}
		if engine.Collection == "model-space-migration" {
			return nil, errTransport
		}
	}
	for _, m := range r.LedgerMutations {
		key := m.Collection + "\x00" + m.ID
		row, ok := records[key]
		if !ok || seen[key] || m.Collection != "entry" || !strings.HasPrefix(m.ID, "hy:") || len(m.ValueRaw) > maxRecordJSON || !json.Valid([]byte(m.ValueRaw)) {
			return nil, errTransport
		}
		seen[key] = true
		var old, next map[string]interface{}
		decoder := json.NewDecoder(strings.NewReader(row.ValueRaw))
		decoder.UseNumber()
		if decoder.Decode(&old) != nil {
			return nil, errTransport
		}
		decoder = json.NewDecoder(strings.NewReader(m.ValueRaw))
		decoder.UseNumber()
		if decoder.Decode(&next) != nil {
			return nil, errTransport
		}
		project, ok := old["projectId"].(string)
		if !ok || project == "" {
			return nil, errTransport
		}
		collection, _ := old["collection"].(string)
		id, _ := old["id"].(string)
		if m.ID != transportEngineID(project, collection, id) {
			return nil, errTransport
		}
		value, ok := old["value"].(map[string]interface{})
		if !ok || value["spaceId"] != p.Current.SpaceID || value["configurationId"] != p.Current.ConfigurationID {
			return nil, errTransport
		}
		if dim, ok := value["dimensions"]; ok && dim != json.Number("1024") {
			return nil, errTransport
		}
		switch collection {
		case "model-space":
			if id != "current" || project == "global" {
				return nil, errTransport
			}
			allowed[transportNamespace(project)+":core"] = key
			allowed[transportNamespace(project)+":cards"] = key
		case "manual-index":
			if value["state"] != "ready" || value["dimensions"] != json.Number("1024") {
				return nil, errTransport
			}
			sourceHash, ok := value["sourceHash"].(string)
			if !ok || !transportHex(sourceHash) {
				return nil, errTransport
			}
			allowed[transportNamespace(project)+":manual\x00"+id] = key
		default:
			return nil, errTransport
		}
		value["spaceId"] = p.Target.SpaceID
		value["configurationId"] = p.Target.ConfigurationID
		if !reflect.DeepEqual(old, next) {
			return nil, errTransport
		}
	}
	nodes := map[string]TransportNode{}
	for _, n := range s.ScopedNodes {
		nodes[n.Namespace+"\x00"+n.ID] = n
	}
	used := map[string]bool{}
	var selected []TransportNode
	for _, selection := range r.SelectedNodes {
		key := selection.Namespace + "\x00" + selection.NodeID
		n, ok := nodes[key]
		authority := allowed[selection.Namespace]
		if strings.HasSuffix(selection.Namespace, ":manual") {
			authority = allowed[key]
		}
		if !ok || used[key] || authority == "" || selection.SourceSpaceID != p.Current.SpaceID || selection.TargetSpaceID != p.Target.SpaceID || selection.ExpectedNodeDigest != n.Digest || len(selection.AuthorityRecordIDs) == 0 {
			return nil, errTransport
		}
		used[key] = true
		includes := false
		for _, ref := range selection.AuthorityRecordIDs {
			refkey := ref.Collection + "\x00" + ref.ID
			if _, ok := records[refkey]; !ok {
				return nil, errTransport
			}
			if refkey == authority {
				includes = true
			}
		}
		if !includes {
			return nil, errTransport
		}
		selected = append(selected, n)
	}
	// Every published manual marker must have its exact copied node.
	for key := range allowed {
		if strings.Contains(key, "\x00") && !used[key] {
			return nil, errTransport
		}
	}
	return selected, nil
}
func transportVerifyCopies(tx *gorm.DB, r TransportRequest, s TransportSnapshot, p TransportPreview) error {
	if r.TargetParameters == nil {
		return errTransport
	}
	var raw string
	if e := tx.Raw(`SELECT parameters FROM models WHERE id=? AND tenant_id=?`, r.ModelID, r.TenantID).Scan(&raw).Error; e != nil {
		return e
	}
	var params types.ModelParameters
	if params.Scan([]byte(raw)) != nil || !reflect.DeepEqual(params, *r.TargetParameters) {
		return errTransport
	}
	var binding struct {
		ModelIdentity string
		Dimensions    int
	}
	found := tx.Raw(`SELECT model_identity,dimensions FROM hy_memory_spaces WHERE tenant_id=? AND kb_id=? AND space_id=?`, r.TenantID, r.KBID, p.Target.SpaceID).Scan(&binding)
	if found.Error != nil || found.RowsAffected != 1 || binding.ModelIdentity != p.Target.ModelIdentity || binding.Dimensions != 1024 {
		return errTransport
	}
	targets, e := transportReadNodes(tx, r, p.Target.SpaceID)
	if e != nil || len(targets) != len(r.SelectedNodes) {
		return errTransport
	}
	source := map[string]TransportNode{}
	for _, n := range s.ScopedNodes {
		source[n.Namespace+"\x00"+n.ID] = n
	}
	target := map[string]TransportNode{}
	for _, n := range targets {
		target[n.Namespace+"\x00"+n.ID] = n
	}
	for _, selection := range r.SelectedNodes {
		key := selection.Namespace + "\x00" + selection.NodeID
		old, ok := source[key]
		copied, has := target[key]
		if !ok || !has || old.Digest != selection.ExpectedNodeDigest || old.Content != copied.Content || old.PayloadRaw != copied.PayloadRaw || old.Active != copied.Active || !bytes.Equal(old.VectorFloat32LE, copied.VectorFloat32LE) {
			return errTransport
		}
		var indexed string
		result := tx.Raw(`SELECT f.content FROM hy_memory_nodes n JOIN hy_memory_fts f ON f.rowid=n.rowid WHERE n.tenant_id=? AND n.kb_id=? AND n.namespace=? AND n.space_id=? AND n.id=?`, r.TenantID, r.KBID, selection.Namespace, p.Target.SpaceID, selection.NodeID).Scan(&indexed)
		if result.Error != nil || result.RowsAffected != 1 || indexed != strings.Join(terms(old.Content), " ") {
			return errTransport
		}
	}
	for _, m := range r.LedgerMutations {
		var value string
		result := tx.Raw(`SELECT value FROM hy_memory_records WHERE tenant_id=? AND kb_id=? AND namespace=? AND collection=? AND id=?`, r.TenantID, r.KBID, transportLedgerNamespace, m.Collection, m.ID).Scan(&value)
		if result.Error != nil || result.RowsAffected != 1 || value != m.ValueRaw {
			return errTransport
		}
	}
	return nil
}
