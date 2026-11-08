// Copyright 2026 SuperWagie contributors. SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"os"

	"github.com/Tencent/WeKnora/internal/memoryindex"
)

// No arguments, prompts, service startup or network listener. Both stdin and
// snapshot stdout are private inherited pipes owned by the coordinator.
func main() {
	log.SetOutput(io.Discard)
	fail := func() { _, _ = io.WriteString(os.Stdout, "{\"error\":\"transport_migration_rejected\"}\n"); os.Exit(1) }
	if len(os.Args) != 1 {
		fail()
	}
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 64*1024*1024))
	decoder.DisallowUnknownFields()
	var request memoryindex.TransportRequest
	if decoder.Decode(&request) != nil {
		fail()
	}
	var extra interface{}
	if decoder.Decode(&extra) != io.EOF {
		fail()
	}
	result, err := memoryindex.ExecuteTransportRequest(context.Background(), request)
	if err != nil {
		fail()
	}
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		os.Exit(1)
	}
}
