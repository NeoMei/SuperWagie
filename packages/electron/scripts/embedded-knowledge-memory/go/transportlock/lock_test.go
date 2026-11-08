//go:build darwin || linux

package transportlock

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCrashChild(t *testing.T) {
	phase := os.Getenv("TRANSPORT_LOCK_CHILD")
	if phase == "" {
		return
	}
	file := os.Getenv("TRANSPORT_LOCK_PATH")
	owner := fmt.Sprintf("%d:fixture", os.Getpid())
	wait := func() {
		fmt.Println("ready")
		for {
			time.Sleep(time.Hour)
		}
	}
	if phase == "acquiring" || phase == "recovering" {
		err := withLease(file, false, func() error {
			if phase == "recovering" {
				if err := removeStaleClaim(file); err != nil {
					return err
				}
			}
			wait()
			return nil
		})
		if err != nil {
			os.Exit(2)
		}
	} else if phase == "owned" {
		if Acquire(file, owner) != nil {
			os.Exit(2)
		}
		wait()
	}
}

func startCrashChild(t *testing.T, phase, file string) (*exec.Cmd, *bufio.Reader) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashChild$")
	cmd.Env = append(os.Environ(), "TRANSPORT_LOCK_CHILD="+phase, "TRANSPORT_LOCK_PATH="+file)
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	reader := bufio.NewReader(pipe)
	line, err := reader.ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "ready" {
		t.Fatalf("child handshake %q %v", line, err)
	}
	return cmd, reader
}
func TestKernelRecoveryAfterSIGKILL(t *testing.T) {
	for _, phase := range []string{"acquiring", "recovering", "owned"} {
		t.Run(phase, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "config.lock")
			if phase == "recovering" {
				if err := os.WriteFile(file, []byte("999999999:dead"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			child, _ := startCrashChild(t, phase, file)
			owner := strconv.Itoa(os.Getpid()) + ":parent"
			if Acquire(file, owner) == nil {
				t.Fatal("stole live exclusion")
			}
			_ = child.Process.Kill()
			_ = child.Wait()
			if err := Acquire(file, owner); err != nil {
				t.Fatal(err)
			}
			if err := Release(file, owner); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestLegacyEmptyWriterAndStaleRecovery(t *testing.T) {
	file := filepath.Join(t.TempDir(), "normal.lock")
	handle, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	owner := strconv.Itoa(os.Getpid()) + ":parent"
	if Acquire(file, owner) == nil {
		t.Fatal("stole live normal writer")
	}
	if err = handle.Close(); err != nil {
		t.Fatal(err)
	}
	if err = Acquire(file, owner); err != nil {
		t.Fatal(err)
	}
	if err = Release(file, owner); err != nil {
		t.Fatal(err)
	}
}
