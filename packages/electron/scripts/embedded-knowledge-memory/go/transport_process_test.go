//go:build darwin || linux

// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package memoryindex

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Tencent/WeKnora/internal/memoryindex/transportlock"
	sqlitevec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	sqlite3 "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestTransportLeaseProcess(t *testing.T) {
	phase := os.Getenv("TRANSPORT_PROCESS_PHASE")
	if phase == "" {
		return
	}
	requestFile := os.Getenv("TRANSPORT_PROCESS_REQUEST")
	bytes, err := os.ReadFile(requestFile)
	if err != nil {
		os.Exit(2)
	}
	var request TransportRequest
	if json.Unmarshal(bytes, &request) != nil {
		os.Exit(2)
	}
	if phase == "owner" {
		request.LockOwner = strconv.Itoa(os.Getpid()) + ":owner"
		if transportlock.Acquire(request.LockPath, request.LockOwner) != nil {
			os.Exit(2)
		}
		child := exec.Command(os.Args[0], "-test.run=^TestTransportLeaseProcess$")
		child.Env = append(os.Environ(), "TRANSPORT_PROCESS_PHASE=job", "TRANSPORT_PROCESS_OWNER="+request.LockOwner)
		child.Stdout = os.Stdout
		child.Stderr = os.Stderr
		if child.Run() != nil {
			os.Exit(2)
		}
		return
	}
	request.LockOwner = os.Getenv("TRANSPORT_PROCESS_OWNER")
	release, err := transportlock.Hold(request.LockPath, request.LockOwner)
	if err != nil {
		os.Exit(2)
	}
	defer release()
	sqlitevec.Auto()
	sql.Register("transport-barrier", &sqlite3.SQLiteDriver{ConnectHook: func(connection *sqlite3.SQLiteConn) error {
		return connection.RegisterFunc("transport_test_barrier", func() int {
			fmt.Printf("job:%d\n", os.Getpid())
			deadline := time.Now().Add(20 * time.Second)
			for time.Now().Before(deadline) {
				if _, err := os.Stat(requestFile + ".continue"); err == nil {
					return 1
				}
				time.Sleep(10 * time.Millisecond)
			}
			return 0
		}, false)
	}})
	db, err := gorm.Open(sqlite.Dialector{DriverName: "transport-barrier", DSN: request.Database}, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		os.Exit(2)
	}
	connection, err := db.DB()
	if err != nil {
		os.Exit(2)
	}
	defer connection.Close()
	result, err := RunTransportMigration(context.Background(), db, request)
	if err != nil {
		os.Exit(2)
	}
	resultBytes, _ := json.Marshal(result)
	if os.WriteFile(requestFile+".result", resultBytes, 0600) != nil {
		os.Exit(2)
	}
}

func TestTransportParentDeathRetainsInflightNativeExclusion(t *testing.T) {
	s, r := transportFixture(t)
	// The real SQL update pauses after writer reservation and global baseline CAS.
	require.NoError(t, s.db.Exec(`CREATE TRIGGER transport_barrier BEFORE UPDATE ON models BEGIN SELECT CASE WHEN transport_test_barrier()=0 THEN RAISE(ABORT,'barrier timeout') END; END`).Error)
	r = preparedTransport(t, s, r)
	require.NoError(t, s.db.Raw(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&r.Database).Error)
	r.LockPath = filepath.Join(t.TempDir(), "configuration.lock")
	requestFile := filepath.Join(t.TempDir(), "request.json")
	bytes, err := json.Marshal(r)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(requestFile, bytes, 0600))
	connection, err := s.db.DB()
	require.NoError(t, err)
	require.NoError(t, connection.Close())
	owner := exec.Command(os.Args[0], "-test.run=^TestTransportLeaseProcess$")
	owner.Env = append(os.Environ(), "TRANSPORT_PROCESS_PHASE=owner", "TRANSPORT_PROCESS_REQUEST="+requestFile)
	pipe, err := owner.StdoutPipe()
	require.NoError(t, err)
	owner.Stderr = os.Stderr
	require.NoError(t, owner.Start())
	t.Cleanup(func() { _ = owner.Process.Kill(); _ = owner.Wait() })
	line, err := bufio.NewReader(pipe).ReadString('\n')
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(line, "job:"))
	jobPID, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "job:")))
	require.NoError(t, err)
	t.Cleanup(func() { process, _ := os.FindProcess(jobPID); _ = process.Kill() })
	require.NoError(t, owner.Process.Kill())
	_ = owner.Wait()
	contender := strconv.Itoa(os.Getpid()) + ":recovery"
	require.Error(t, transportlock.Acquire(r.LockPath, contender), "rollback must not acquire while orphan apply can still commit")
	require.NoError(t, os.WriteFile(requestFile+".continue", nil, 0600))
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if transportlock.Acquire(r.LockPath, contender) == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	claim, err := os.ReadFile(r.LockPath)
	require.NoError(t, err)
	require.Equal(t, contender, string(claim))
	defer transportlock.Release(r.LockPath, contender)
	resultBytes, err := os.ReadFile(requestFile + ".result")
	require.NoError(t, err)
	var result TransportResponse
	require.NoError(t, json.Unmarshal(resultBytes, &result))
	require.Equal(t, "applied", result.Status)
	// Recovery is admitted only after the late transaction has actually committed.
	reopened, err := gorm.Open(sqlite.Open(r.Database), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	handle, err := reopened.DB()
	require.NoError(t, err)
	defer handle.Close()
	var revision int64
	require.NoError(t, reopened.Raw(`SELECT revision FROM hy_memory_namespaces WHERE namespace='superwagie:memory'`).Scan(&revision).Error)
	require.Equal(t, r.Expected.LedgerRevision+1, revision)
}
