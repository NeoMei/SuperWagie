# Dictation module

Server-authoritative speech-to-text for the chat composer, plus local
text-to-speech. The client streams 16 kHz mono PCM16 chunks (base64) over a
WebSocket while the user speaks; the server buffers them and transcribes each
segment exactly once, when the segment is committed. Continuous dictation and
short voice input resolve the `stt-realtime` purpose, which the model
configuration binds to LLMRouter ASR `qwen3-asr-flash` through the
SuperWagie account key at `https://llmrouter.quukk.com/v1`. Each committed
segment is wrapped as WAV and submitted to
`/v1/audio/transcriptions`; there is no local STT model download and no
custom Whisper fallback.

Transcription is deliberately not incremental. LLMRouter ASR transcribes a
finished audio segment, so re-decoding the growing buffer to animate a live
transcript would repeatedly resubmit audio that the final result replaces. The
composer shows no text while recording and inserts the full transcript on
stop. A configured binding supplies the endpoint, model and key together;
client-selected provider options cannot override the server-resolved
destination.

Local TTS (Kokoro and Piper/VITS via sherpa-onnx OfflineTts) runs in the same
worker process and is exposed as `POST /api/dictation/tts/speak` (JSON
`{text, speakerId?, speed?, model?, language?, languageSample?}` → WAV bytes; 503 with
`reasonCode` while the model is downloading). Local TTS models live in
`local/model-catalog.js` (`LOCAL_TTS_MODEL_CATALOG`) and are managed by the
status/download/delete routes; STT no longer uses a local model catalog.

Each TTS catalog entry declares the `languages` it speaks. With
`language: 'auto'` the service detects the language of `languageSample` — the
whole message the chunk belongs to, sent by the client with every chunk — or
of `text` when no sample is given
(`../tts/language-detect.js`, script plus function-word scoring, no
dependencies) and keeps the caller's model when it speaks that language;
otherwise it switches to the catalog model for the language, downloading it on
first use like any other model, and starts from that model's default speaker
(`defaultSpeakerByLanguage`) instead of the caller's speaker id. A language no
catalog model covers keeps the caller's model, so text is always spoken. The
response carries `X-Speech-Model` and `X-Speech-Language`.

## Ownership

- `runtime.js` — registers `GET /api/dictation/status`,
  `POST /api/dictation/models/:modelId/download`, and the
  `/api/dictation/ws` WebSocket endpoint (auth-gated the same way as the
  terminal WS: UI session token or `oc_url_token`, plus origin check).
  Created from the startup pipeline (`startup-pipeline-runtime.js`) before
  the generic OpenCode proxy so routes are not shadowed.
- `stream-manager.js` — `DictationStreamManager`, one per WS connection.
  Chunk reordering by `seq` + ack, resampling to the provider rate, segment
  splitting inside pauses, silence suppression by PCM peak, partial-transcript
  concatenation, adaptive finalization timeout.
- `service.js` — resolves `stt-realtime` at invocation, refuses enterprise
  mode, returns `stt_not_configured` when no binding exists, and opens one
  `OpenAICompatibleTranscriptionSession` per dictation with `configured:
  true`. It owns local TTS model download state and readiness only.
- `openai-compatible-session.js` — buffered per-segment transcription against
  the resolved LLMRouter ASR `/v1/audio/transcriptions` endpoint (reuses
  `../tts/stt.js`). `connect()` runs the same URL check as every
  transcription (`normalizeCustomOpenAIBaseURL`), so a refused host — any
  remote one in enterprise mode — fails before the user dictates.
- `local/` — worker process + client (IPC, idle shutdown TTL), local TTS
  engine, model catalog and downloader. The native `sherpa-onnx-node` addon
  is only ever loaded inside the worker process, where local read-aloud models
  run. There is no local STT catalog, recognizer or session: transcription
  resolves the LLMRouter ASR binding in the main server process.
- `audio.js` — PCM16 helpers: format parsing, peak, per-frame RMS, WAV
  wrapping, streaming linear resampler.

## WebSocket protocol (JSON text frames)

Client → server: `start {dictationId, format, options}`,
`chunk {dictationId, seq, audio}`, `finish {dictationId, finalSeq}`,
`cancel {dictationId}`, `ping`.

Server → client: `ready`, `ack {ackSeq}`, `partial {text}`,
`finish_accepted {timeoutMs}`, `final {text}`,
`error {error, retryable, reasonCode?}`, `pong`.

The `start` frame carries no provider config. The server resolves the
`stt-realtime` binding for every session; client frames cannot supply an
endpoint, model or credential.

## Segmentation

A dictation is one segment unless it runs long. Past `segmentMinSeconds`
(15 s) the manager cuts inside the first pause it finds, so cuts land between
words; `segmentMaxSeconds` (25 s) is a hard cap for speech with no pause in it.

Pauses are found inside each ~1 s client chunk, not at chunk boundaries: the
chunk is scored in 50 ms RMS frames; a frame is quiet when it is close to the
stream's noise floor (the quietest frame in the last ~10 s, so a fan or a
boosted mic does not hide every pause and a silent first second from a gated
mic is soon forgotten) and well below its loudest frame (so soft speech does
not pass for a pause), a pause is a quiet run of at least 200 ms, and the cut
goes into the middle of that run — a pause that straddles two chunks still
counts, cut at the chunk boundary when its middle already went by. At the
hard cap the cut goes into the quietest frame of the chunk that crosses it.
Bytes before the cut end the committed segment, bytes after it start the next
one; the client's `seq` and ack are untouched because the whole chunk is
consumed either way.

The bounds keep each LLMRouter ASR request small and bounded: a shorter WAV is
cheaper to upload and transcribe, and a long dictation does not depend on one
oversized request. Committed segments are submitted while the user is still
speaking, so only the tail is left to transcribe on stop.

## Invariants

- Never load `sherpa-onnx-node` in the main server process.
- Transcription happens on commit only; sessions never emit non-final
  transcripts. The `partial` messages a client receives are the concatenation
  of already-committed segments, and exist so a dictation that fails partway
  can be salvaged instead of losing minutes of speech.
- The stream manager acks only the highest contiguous seq; the client is
  expected to retain unacked segments for retry/replay.
- Silence-only segments (peak < 300) are cleared, never committed, so the ASR
  endpoint is not asked to transcribe silence.
- Local TTS model files live under `~/.config/openchamber/speech-models`.

## Unified model bindings

The runtime injects `resolveModelBinding` into the service. Every session
and its readiness check resolve `stt-realtime` at invocation against the
LLMRouter ASR `qwen3-asr-flash` binding through the SuperWagie account key.
The endpoint uses the documented buffered per-segment transcription contract;
it does not become an incremental realtime API. Native realtime streaming
remains unsupported until a matching session adapter exists. Enterprise mode
refuses external resolution, so a remote ASR binding cannot be used while it
is active. Saved resolver errors disable readiness and return a stable reason
instead of using an unrelated legacy key.

## Decisions

### Why buffered LLMRouter ASR and not a local model or custom Whisper server

The settled voice design uses one managed binding for both short voice input
and continuous dictation. LLMRouter ASR `qwen3-asr-flash` accepts a finished
WAV segment through `audio/transcriptions`, so the server's existing
segmentation, ack and partial-transcript salvage already fit the contract. A
local sherpa STT download would add a model the account key already replaces,
and a custom Whisper endpoint would put destination and credential selection
back in the client. Local TTS read-aloud stays on this machine, so the worker
and `sherpa-onnx-node` remain in use for synthesis only.

### Why the start frame and status route ignore client provider options

The `start` frame carries `dictationId` and `format` only, and
`GET /api/dictation/status` resolves `stt-realtime` without reading
`provider` or `localModel` query parameters. Older Voice settings still send
those parameters while polling local read-aloud download progress; honoring
them would let a browser choose the transcription destination or select a local
STT model that this module no longer downloads.

### Why stt-realtime stays the purpose id and not a buffered name

The id names the consumer, which is the live dictation session in the chat
composer, and the account-key catalog and activation map both STT purposes to
the same LLMRouter ASR binding. LLMRouter transcribes a finished WAV segment,
so the id does not promise a native realtime stream; renaming it would break
saved bindings, probes and activation rows without changing what the session
does.
