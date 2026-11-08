//go:build darwin || linux

// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package transportlock

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var errLocked = errors.New("transport_lock_rejected")

func ownerPID(owner string) (int, error) {
	parts := strings.Split(owner, ":")
	if len(parts) != 2 || len(parts[1]) < 1 || len(owner) > 200 {
		return 0, errLocked
	}
	pid, err := strconv.Atoi(parts[0])
	if err != nil || pid < 1 || pid > 2147483647 {
		return 0, errLocked
	}
	return pid, nil
}
func liveOwner(owner string) bool {
	pid, err := ownerPID(owner)
	return err == nil && syscall.Kill(pid, 0) != syscall.ESRCH
}

// The lease inode is permanent. No recovery process can unlink another lease.
// Every acquisition/recovery is exclusive; in-flight database children retain
// a shared lease, including after their coordinator parent is killed.
func openLease(file string, shared bool) (*os.File, error) {
	if !filepath.IsAbs(file) || !strings.HasSuffix(file, ".lock") {
		return nil, errLocked
	}
	fd, err := syscall.Open(file+".lease", syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, errLocked
	}
	handle := os.NewFile(uintptr(fd), file+".lease")
	info, err := handle.Stat()
	if err != nil || !info.Mode().IsRegular() {
		handle.Close()
		return nil, errLocked
	}
	mode := syscall.LOCK_EX
	if shared {
		mode = syscall.LOCK_SH
	}
	if syscall.Flock(fd, mode|syscall.LOCK_NB) != nil {
		handle.Close()
		return nil, errLocked
	}
	return handle, nil
}
func withLease(file string, shared bool, task func() error) error {
	lease, err := openLease(file, shared)
	if err != nil {
		return err
	}
	defer lease.Close()
	return task()
}
func readClaim(file string) ([]byte, error) {
	info, err := os.Lstat(file)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 200 {
		return nil, errLocked
	}
	return os.ReadFile(file)
}
func removeStaleClaim(file string) error {
	old, err := readClaim(file)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errLocked
	}
	if len(old) == 0 {
		// The normal runtime owns an empty wx file while its FD remains open.
		// A stopped legacy writer may leave the same bytes after a crash.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, "lsof", "-t", "--", file)
		output, err := command.CombinedOutput()
		var status *exec.ExitError
		if !errors.As(err, &status) || status.ExitCode() != 1 || len(bytes.TrimSpace(output)) != 0 {
			return errLocked
		}
	} else {
		if _, err := ownerPID(string(old)); err != nil || liveOwner(string(old)) {
			return errLocked
		}
	}
	current, err := readClaim(file)
	if err != nil || !bytes.Equal(current, old) {
		return errLocked
	}
	return os.Remove(file)
}
func syncDirectory(file string) error {
	folder, err := os.Open(filepath.Dir(file))
	if err != nil {
		return err
	}
	defer folder.Close()
	return folder.Sync()
}

// Acquire publishes an already initialized claim with link(2). A racing normal
// runtime wx writer wins or loses atomically; its file is never replaced.
func Acquire(file, owner string) error {
	if !liveOwner(owner) {
		return errLocked
	}
	return withLease(file, false, func() error {
		if err := removeStaleClaim(file); err != nil {
			return err
		}
		temporary, err := os.CreateTemp(filepath.Dir(file), ".transport-owner-*")
		if err != nil {
			return err
		}
		defer os.Remove(temporary.Name())
		defer temporary.Close()
		if _, err = fmt.Fprint(temporary, owner); err != nil {
			return err
		}
		if err = temporary.Sync(); err != nil {
			return err
		}
		if err = os.Link(temporary.Name(), file); err != nil {
			return errLocked
		}
		return syncDirectory(file)
	})
}
func Release(file, owner string) error {
	return withLease(file, false, func() error {
		value, err := readClaim(file)
		if err != nil || string(value) != owner {
			return errLocked
		}
		if err = os.Remove(file); err != nil {
			return err
		}
		return syncDirectory(file)
	})
}

// Hold is acquired before opening SQLite and released only after closing it.
func Hold(file, owner string) (func(), error) {
	lease, err := openLease(file, true)
	if err != nil {
		return nil, err
	}
	value, err := readClaim(file)
	if err != nil || string(value) != owner || !liveOwner(owner) {
		lease.Close()
		return nil, errLocked
	}
	return func() { _ = lease.Close() }, nil
}
