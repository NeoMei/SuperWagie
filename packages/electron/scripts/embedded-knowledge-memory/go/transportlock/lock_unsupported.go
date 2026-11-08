//go:build !darwin && !linux

// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package transportlock

import "errors"

var errUnsupported = errors.New("transport_lock_platform_unsupported")

func Acquire(string, string) error        { return errUnsupported }
func Release(string, string) error        { return errUnsupported }
func Hold(string, string) (func(), error) { return nil, errUnsupported }
