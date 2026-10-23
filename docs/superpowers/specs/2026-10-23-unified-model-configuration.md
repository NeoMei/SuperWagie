# SuperWagie model configuration catalog

Reviewed on 2026-10-23, Asia/Shanghai.

This is a requirements and API recommendation inventory, based on the local 2.6.1 checkout at `/Users/neomei/项目/codexprojects/SuperWagie-open`. It covers the app, bundled components, and all 13 bundled skills. It does not claim coverage of GitHub 2.7.0, installed skill copies, or runtime acceptance. No credentials were read and no billable model requests were made.

## Model purposes

The primary navigation groups configuration by model purpose. Components and skills are consumers shown within each purpose. Connections own credentials, protocol, endpoint, region and workspace. Purpose bindings reference connections and models.

| Purpose | Consumers | Important capability checks |
|---|---|---|
| Agent conversation | Chat, task execution, writing, coding, skill orchestration | Tool calls, streaming and the actual OpenCode provider path |
| Auxiliary text generation | Titles, notes and spoken summaries, goal extraction/checking, session assist, Git commit/PR text | Short generation; structured output only for consumers requiring it |
| OCR and document parsing | Scanned PDFs, document images, editable-slide reconstruction | Text/layout extraction and structured results, not just image description |
| Image understanding | Embedded knowledge VLM, slide inspection, screenshots, diagram review | Image input and required region/coordinate outputs |
| Text embedding | Knowledge indexing and semantic queries | Dimension, batching and index compatibility |
| Reranking | Knowledge retrieval | Query/document ranking protocol and score/index output |
| Speech recognition | Voice input; file transcription consumers when connected | Separate short voice-message, continuous streaming and file-transcription presets; timestamps where required |
| Speech synthesis | Chat read-aloud and SuperVideo narration | Voice, language, downloadable audio and narration requirements |
| Image generation | SuperPPT, ai-image-to-ppt and optional illustrated-document/video workflows | Text-to-image, reference images, resolution and output format |
| Image editing and completion | Optional editable-PPT repair and other declared editing workflows | Reference-guided edits, masks/inpainting and preservation constraints; preserve safe backgrounds when repair is unavailable |
| Classification and routing, advanced | Jev Auto routing, risk judgments and completion judgments | System One typed decisions; a generic chat endpoint is not a drop-in replacement |

Image/multimodal embedding, knowledge audio/video ingestion, Wiki/graph generation and independent video-generation providers remain future or incomplete consumers in this checkout. They must not produce a required-configuration warning as if they already worked. Existing ASR UI is independent of the incomplete knowledge ASR import path.

## Bundled consumers

| Component or skill | Required or conditional purpose bindings | Current configuration source |
|---|---|---|
| SuperWagie/OpenCode chat | Agent conversation | OpenCode connections; app/project/agent/command/session model choices |
| App helpers and change walkthrough | Auxiliary text; optional structured-output override | Existing OpenCode connections and helper model settings |
| Embedded knowledge / WeKnora | Embedding, rerank; OCR and VLM when needed | Embedded backend model records, parser token and one-time provisioning |
| App dictation and read-aloud | STT and TTS | Voice settings and voice credential store; local paths also exist |
| superppt | Agent, image generation; OCR, vision and editing for editable conversion | Delegates to the image and editable-PPT skills |
| ai-image-to-ppt | Image generation; optional vision checks | OpenAI/Gemini/Doubao scripts, environment or secret files; optional host tool |
| image-to-editable-pptx | OCR and vision; optional image editing/completion with a safe-background fallback | Skill declares OpenAI or Alibaba credentials; this bundle lacks its independent execution runtime |
| supervideo | Agent, TTS; optional image assets | Bundled engine uses Alibaba or ElevenLabs credentials, or system/host audio |
| superwriter | Agent; optional image generation and vision | Delegates media and layout to other skills |
| WPSComposer | Inherits the upstream Agent; optional visual acceptance | Local document/layout engine itself consumes no model API key |
| superweb | Agent; optional screenshot understanding | CLI owns workflow state and browser acceptance, not a separate model client |
| obsidian-excalidraw | Agent and visual review | Local generation/rendering plus host vision |
| grilling | Agent | Current Agent |
| grill-me | Agent | Delegates to grilling |
| grill-with-docs | Agent | Delegates to grilling/domain-modeling |
| to-spec | Agent | Current Agent; issue tracker credentials are external services |
| domain-modeling | Agent | Current Agent |

The 13 skill rows run from superppt through domain-modeling. Creating a separate model or key field for each prompt-only skill is unnecessary. Their explicit dependencies must nevertheless appear in the consumer inventory.

## Recommended model presets: Chinese and international models

Every purpose must offer both Chinese-origin and international-origin model options. This is a mainstream-provider shortlist, not a benchmark ranking. Model origin is distinct from API service region: a Chinese model served by an international endpoint is still a Chinese model. Users choose their preference explicitly and may mix providers across purposes.

These recommendations target the new configuration catalog. They do not assert that every current app component or skill already supports every provider. Each displayed preset must carry its consumer compatibility and adapter status.

| Purpose | Chinese-origin recommendations | International-origin recommendations | Binding and compatibility notes |
|---|---|---|---|
| Agent conversation | Qwen `qwen3.8-max`; DeepSeek `deepseek-flash`; GLM `glm-5.3`; Kimi `kimi-k3`; retain `qwen3.7-plus` as an alternative | OpenAI `gpt-6.1-sol` / `gpt-6-astra`; Claude `claude-sonnet-5-5` / `claude-opus-5-5`; Gemini `gemini-3.8-flash` / `gemini-4-argon` | Use an eligible OpenCode provider; verify tool calls and streaming through the actual consumer |
| Auxiliary text | Qwen `qwen3.8-flash`; DeepSeek `deepseek-flash`; or explicit reuse of the Agent model | OpenAI `gpt-6-luna`; Claude `claude-haiku-5-5`; Gemini `gemini-3.5-flash-lite` | Structured output is required only by consumers that actually need it |
| OCR and document parsing | PaddleOCR `PaddleOCR-VL-1.6`; `PP-OCRv6` for plain OCR | Mistral `mistral-ocr-4-1` / `mistral-ocr-latest`; Azure Document Intelligence `prebuilt-layout` / `prebuilt-read` | Parser protocols differ. Azure is a resource-scoped service. None automatically becomes an editable-PPT analysis provider |
| Image understanding | Qwen `qwen3.7-plus` / `qwen3.8-flash`; Kimi `kimi-k3` | OpenAI `gpt-6.1-sol`; Gemini `gemini-3.8-flash` / `gemini-4-argon`; Claude `claude-sonnet-5-5` | Reuse eligible connections; editable-PPT currently declares OpenAI/Alibaba analysis and explicitly excludes Gemini |
| Text embedding | New indexes: Qwen `qwen3.7-text-embedding`; existing compatibility option `text-embedding-v4` | OpenAI `text-embedding-3-small` / `text-embedding-3-large`; Voyage `voyage-4` / `voyage-4-large`; Cohere `embed-v5.0-pro` / `embed-v5.0-fast` | Existing indexes retain their model and dimensions. Mixing different embedding spaces is not a general compatibility rule |
| Rerank | Qwen `qwen3.7-text-rerank`; compatibility option `qwen3-rerank` | Cohere `rerank-v5.0-pro` / `rerank-v5.0-fast`; Voyage `rerank-3` / `rerank-3-lite` | Match each provider's ranking request and response protocol |
| STT: short voice input | Alibaba `qwen-audio-3.1-asr-flash-message` | ElevenLabs `scribe_v2_realtime`; Deepgram `nova-3` where language support fits | Realtime protocol; a file-transcription binding is a different capability |
| STT: continuous transcription | Alibaba `qwen-audio-3.1-asr-flash-streaming` | ElevenLabs `scribe_v2_realtime`; Deepgram `nova-3`; optional conversational Flux `flux-general-multi` | Validate streaming, endpointing and supported languages separately |
| STT: file transcription | Alibaba `qwen-audio-3.1-asr-flash-filetrans` | OpenAI `gpt-transcribe`; ElevenLabs `scribe_v2`; Deepgram `nova-3` | Validate timestamps, segmentation and diarization only where required. This does not imply that knowledge audio ingestion is connected |
| TTS: read-aloud and narration | Alibaba `qwen-audio-3.1-tts-plus`; MiniMax `speech-2.8-hd` / `speech-2.8-turbo` | ElevenLabs `eleven_v4` / `eleven_multilingual_v2`; Gemini `gemini-3.8-flash-tts` / `gemini-3.8-flash-lite-tts` | Save a compatible voice and durable narration output. Low-latency ElevenLabs `eleven_v4_turbo` uses a distinct dialogue WebSocket workflow |
| Image generation | Alibaba Qwen Image `qwen-image-3.0-pro` / `qwen-image-3.0`, Wan `wan2.7-image-pro` / `wan2.7-image`; Volcengine Seedream `doubao-seedream-5-0-pro-260628` / `doubao-seedream-5-0-flash-260915` | OpenAI `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`; Gemini `gemini-nano-banana-2.1` | Existing scripts have older defaults; verify request parameters and output handling |
| Image editing and optional completion | Alibaba Qwen Image `qwen-image-3.0-pro`, Wan `wan2.7-image-pro`; Volcengine Seedream `doubao-seedream-5-0-pro-260628` / `doubao-seedream-5-0-flash-260915` | OpenAI `gpt-image-2.5-sunburst` / `gpt-image-2.5-flare`; Gemini `gemini-nano-banana-2.1` for compatible general editing consumers | Reference editing, region-guided edits and mask inpainting are distinct capabilities. Qwen/Seedream are not declared OpenAI-mask drop-ins; Gemini is excluded by the current editable-PPT skill. Keep safe-background fallback |
| Classification, judgment and routing | Qwen `qwen3.8-flash` structured output; DeepSeek `deepseek-flash` JSON output, via a new typed-decision adapter | TypeSafe `jev-latest` for native System One decisions; OpenAI `gpt-6-luna` / Claude `claude-haiku-5-5` for schema-based classification | Current Auto uses Jev's System One contract. Generic LLM options require adapter/schema/threshold validation and are not native Jev equivalents. A self-reported probability is not a calibrated Jev probability |

### Planned-purpose recommendations

These pairs complete the catalog for future consumers. They remain marked as not connected and must not generate required-configuration warnings in the current product.

| Planned purpose | Chinese-origin recommendations | International-origin recommendations | Status |
|---|---|---|---|
| Image/multimodal embedding | Qwen `qwen3-vl-embedding` | Gemini `gemini-embedding-2` | Knowledge consumer not connected; modality and indexing contract required |
| Independent video generation | Alibaba Wan `wan2.7-t2v` / `wan2.7-i2v`; Volcengine Seedance `doubao-seedance-2-5-260628`, with the 2.0 family as alternatives | Gemini `gemini-omni-1.1-flash` | No current bundled video-generation provider; native API/job adapters required |

The regional shortcut should change the recommendation filter, not restrict the available models. Every purpose keeps Chinese, international and all-model views, plus existing local/custom options. API account region, endpoint region, credential type and model origin remain separate properties. Existing bindings are preserved when a recommendation filter changes.

## Chinese media provider families

Image and video recommendations must both explicitly cover Alibaba Model Studio and Volcengine ModelArk. They are two provider families with separate connections, not an image-only versus video-only split. International choices remain available beside them.

| Purpose | Alibaba Model Studio | Volcengine ModelArk |
|---|---|---|
| Image generation | Qwen Image `qwen-image-3.0-pro` / `qwen-image-3.0`; Wan `wan2.7-image-pro` / `wan2.7-image` | Seedream `doubao-seedream-5-0-pro-260628` / `doubao-seedream-5-0-flash-260915` |
| Image editing | Eligible Qwen Image and Wan image models, matched to the consumer's required editing capabilities | Eligible Seedream 5.0 models, matched to the consumer's required editing capabilities |
| Text-to-video | Wan `wan2.7-t2v`; pinned version `wan2.7-t2v-2026-06-12` | Seedance `doubao-seedance-2-5-260628`; alternatives `doubao-seedance-2-0-260128`, `doubao-seedance-2-0-fast-260128`, `doubao-seedance-2-0-mini-260615` |
| Image-to-video | Wan `wan2.7-i2v`; pinned version `wan2.7-i2v-2026-04-25` | Seedance 2.5 and eligible 2.0 variants; select the required first-frame, first/last-frame or reference-input capability |

An eligible Alibaba connection can be referenced by both image and video purposes; the same applies to an eligible Volcengine Ark connection. Actual access still depends on the selected account, region, model enablement and API capability. Video generation remains a planned consumer in this checkout.

## Connection and endpoint presets

Place provider-specific protocol fields behind the preset. A single generic Base URL plus Model ID form cannot represent all of these APIs.

| Connection | Endpoint configuration | Credentials |
|---|---|---|
| Alibaba Beijing | Host `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`; Chat `/compatible-mode/v1/chat/completions`; embedding `/compatible-mode/v1/embeddings` | Region, workspace ID, API key; Bearer |
| Alibaba rerank | Same host, `/api/v1/services/rerank/text-rerank/text-rerank` | Same eligible connection; nested `input.query` / `input.documents` |
| Alibaba image | Same host, `/compatible-mode/v1/images/generations` | Same eligible connection; provider-specific editing payload |
| Alibaba file ASR | Same host, `/api/v1/services/audio/asr/transcription`; poll `/api/v1/tasks/{task_id}` | Bearer; asynchronous header and accessible file URL |
| Alibaba TTS | Same host, `/api/v1/services/audio/tts/SpeechSynthesizer` | Bearer; select a voice supported by the model |
| PaddleOCR official cloud | `https://paddleocr.aistudio-app.com/api/v2/ocr/jobs`; poll job ID | AI Studio Access Token, Bearer; not a DashScope key |
| DeepSeek | `https://api.deepseek.com/chat/completions` | DeepSeek platform API key, Bearer |
| OpenAI | Base `https://api.openai.com/v1`; Responses `/responses`, embeddings `/embeddings`, images `/images/generations` and `/images/edits`, transcription `/audio/transcriptions` | OpenAI API connection, typically a project API key, Bearer |
| Claude | `https://api.anthropic.com/v1/messages` | Claude API key, native protocol and required version headers |
| Gemini native | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | Gemini API key; `x-goog-api-key` |
| Gemini chat compatibility | `https://generativelanguage.googleapis.com/v1beta/openai/` | Gemini API key; Bearer; do not assume this endpoint implements all image/audio workflows |
| Cohere rerank | `https://api.cohere.com/v2/rerank` | Cohere API key; Bearer |
| TypeSafe Jev | `https://api.typesafe.ai/v1/systemone` | TypeSafe API key; Bearer; typed decision schema |
| GLM standard API | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | Standard API key; do not substitute Coding Plan keys |
| Kimi standard API | China base `https://api.moonshot.cn/v1`; international base `https://api.moonshot.ai/v1` | Standard platform API key; Coding `k3` and standard `kimi-k3` are separate presets |
| Seedream | `https://ark.cn-beijing.volces.com/api/v3/images/generations` | Volcengine Ark API key; Bearer |
| MiniMax TTS | China `https://api.minimax.cn/v1/t2a_v2`; international `https://api.minimax.io/v1/t2a_v2` | Region-specific MiniMax API key; select a voice ID |
| Mistral OCR | `https://api.mistral.ai/v1/ocr` | Mistral API key; Bearer |
| Azure Document Intelligence | `{resourceEndpoint}/documentintelligence/documentModels/{modelId}:analyze?api-version=2024-11-30` | Resource Endpoint and Key or supported Microsoft identity; key header `Ocp-Apim-Subscription-Key` |
| Cohere embedding | `https://api.cohere.com/v2/embed` | Cohere API key; Bearer |
| Voyage | `https://api.voyageai.com/v1/embeddings`; `/v1/rerank` | Voyage API key; Bearer |
| Deepgram file/live STT | `https://api.deepgram.com/v1/listen?model=nova-3`; WebSocket equivalent `wss://api.deepgram.com/v1/listen?model=nova-3` | Deepgram API key; `Authorization: Token ...`; language selection required |
| ElevenLabs file/live STT | `https://api.elevenlabs.io/v1/speech-to-text`; `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime` | ElevenLabs credential; header/token flow depends on server versus browser transport |
| ElevenLabs TTS | `https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` | `xi-api-key`; model and voice; newer dialogue WebSocket presets use another workflow |
| Gemini TTS 3.8 | Recommended `https://generativelanguage.googleapis.com/v1beta/interactions`; legacy supported generateContent route is a separate protocol preset | Gemini API key; `x-goog-api-key`; use the 3.8 speech metadata/voice contract |
| Planned Wan video | Alibaba host plus `/api/v1/services/aigc/video-generation/video-synthesis` | Same eligible Alibaba connection; async request and task polling |
| Planned Seedance video | `POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`; poll `GET /api/v3/contents/generations/tasks/{id}` | Volcengine Ark API key; Bearer; native asynchronous task protocol |
| Alibaba Wan image | Alibaba host plus `/api/v1/services/aigc/multimodal-generation/generation` for synchronous generation, or `/api/v1/services/aigc/image-generation/generation` for asynchronous tasks | Eligible Alibaba key and workspace; native Wan image payload, separate from the Qwen OpenAI-compatible image preset |
| Planned Gemini multimodal embedding | `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent` | Gemini API key; `x-goog-api-key`; modality-specific payload |
| Planned Gemini video | `https://generativelanguage.googleapis.com/v1beta/interactions` | Gemini API key; native video-generation workflow |


Alibaba documentation now recommends workspace-specific hosts. Legacy DashScope hosts remain a compatibility choice but no longer receive new features from 2026-09-30. Region-specific keys, hosts and model catalogs are not interchangeable. Existing installations must not be silently migrated.

OpenAI's older speech models should not be fresh defaults: `tts-1`, `tts-1-hd`, and `gpt-4o-mini-tts` are scheduled to shut down on 2027-01-06. The recommended `gpt-realtime-2.1-mini` replacement uses Realtime rather than `/audio/speech`. Old Whisper/GPT-4o transcription models are scheduled to shut down on 2027-02-26; use `gpt-transcribe` for new file-transcription presets.


## Provider setup links

Each recommendation needs a visible official setup link as well as a model documentation link. Use the selected provider's identity and region rather than opening an unrelated reseller.

| Provider | Official key/setup entry |
|---|---|
| Alibaba | [Get API key](https://help.aliyun.com/zh/model-studio/get-api-key) |
| DeepSeek | [Official API onboarding](https://api-docs.deepseek.com/) |
| GLM | [Standard API documentation](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3) |
| Kimi | [API keys](https://platform.kimi.com/console/api-keys) |
| PaddleOCR | [Official token onboarding](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/serving/paddleocr_official_api/overview.html) |
| Volcengine Ark | [Beijing API keys](https://ark.volcengine.com/region:cn-beijing/apikey) |
| MiniMax China | [API keys](https://platform.minimax.cn/console/access?tab=api-keys) |
| OpenAI | [API authentication and project setup](https://developers.openai.com/api/reference/overview#authentication) |
| Claude | [API onboarding](https://platform.claude.com/docs/en/api/overview) |
| Gemini | [AI Studio API keys](https://aistudio.google.com/apikey) |
| Mistral | [API keys](https://console.mistral.ai/api-keys/) |
| Azure | [Create the Document Intelligence resource](https://portal.azure.com/) |
| Cohere | [API keys](https://dashboard.cohere.com/api-keys) |
| Voyage | [API keys](https://dashboard.voyageai.com/organization/api-keys) |
| Deepgram | [Console](https://console.deepgram.com/) |
| ElevenLabs | [API keys](https://elevenlabs.io/app/api/api-keys) |
| TypeSafe | [Developer console](https://console.typesafe.ai/) |

## Configuration and verification behavior

Each purpose should display its recommendation, consumers, selected connection/model, optional inheritance, required parameters and verification result. Each recommendation records model origin, official documentation and setup URLs, review date, release status, supported service regions and adapter status. Chinese/international grouping must be complete for every purpose; honest unsupported-equivalence states remain visible.

- Connection fields: provider, credential type, endpoint/protocol, region/workspace when applicable, and execution location. API keys, OAuth, Coding Plan credentials and host tools are different access paths.
- Purpose fields: model, required capabilities, purpose-specific parameters and a connection reference. A compatible model may serve more than one purpose.
- Consumer binding: component/skill identity, required/optional role, inherited or explicit selection, supported protocol/provider restrictions, runtime availability and validation state. Global presets apply only when compatible with the consumer. Optional editable-PPT repair does not block the safe-background fallback.
- Verification states: unconfigured, saved but untested, verified for this purpose, failed with cause, unavailable adapter/component, or local operation without a key.
- Run verification through the actual consumer environment. A browser-side test does not prove that a server, remote OpenCode process, skill script or isolated container can consume the configuration.
- Use small purpose-specific tests: a tool call, structured result, OCR sample, image description, dimension-checked embedding, ranked documents, short transcription, audio synthesis, image generation, or editing preservation/mask test.
- Show missing requirements for enabled capabilities. Do not require every listed purpose merely to start the app.
- Retain model-scope information for app, project, agent, command and existing session overrides. Changing the global selection must not falsely imply that it replaced all overrides.
- Keep external search/MCP/business credentials in an external-services area. They are not automatically model API credentials.

## Current integration work required

1. Replace scattered model configuration entry points with purpose bindings that reuse existing credential owners through explicit adapters.
2. Add durable model/key update and rebind operations for embedded knowledge. Existing provisioning reuses model records and hides its key form after initialization.
3. Add an OCR configuration UI and match the selected cloud protocol to the embedded parser.
4. Connect skill execution to purpose bindings. Existing image scripts read environment variables/secret files; SuperVideo separately reads Alibaba/ElevenLabs keys.
5. Adapt newer Alibaba audio/image protocols and current model defaults. Merely changing an ID does not migrate the protocol.
6. Handle the incomplete editable-PPT runtime package independently of credential configuration.
7. Distinguish bundled recommendations from installed skill copies. The installer skips an already-existing skill and does not automatically replace its scripts.
8. Keep future knowledge ASR, multimodal embedding, Wiki/graph and independent video generation visibly incomplete until their consumers are implemented.

## Official sources

All below were consulted on 2026-10-23. Recommendations require later refreshes as catalogs and deprecations change.

- [Alibaba regions, hosts and credentials](https://help.aliyun.cn/zh/model-studio/regions)
- [Alibaba API key setup](https://help.aliyun.com/zh/model-studio/get-api-key)
- [Qwen3.7 Plus](https://help.aliyun.com/zh/model-studio/qwen3-7-plus)
- [Qwen3.8 Flash](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)
- [Alibaba embedding](https://help.aliyun.com/zh/model-studio/embedding?disableWebsiteRedirect=true)
- [Alibaba rerank](https://help.aliyun.com/en/model-studio/text-rerank-api)
- [Qwen image generation and editing](https://help.aliyun.com/en/model-studio/qwen-image-generation-and-editing-api-reference)
- [Alibaba ASR choices](https://help.aliyun.com/zh/model-studio/asr-model)
- [Alibaba file transcription](https://help.aliyun.com/en/model-studio/fun-asr-recorded-speech-recognition-http-api)
- [Alibaba TTS choices](https://help.aliyun.com/zh/model-studio/tts-model)
- [Alibaba HTTP TTS](https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide)
- [PaddleOCR official API](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/serving/paddleocr_official_api/overview.html)
- [PaddleOCR API models](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/serving/paddleocr_official_api/python.html)
- [PaddleOCR SDK endpoint source](https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/api_sdk/go/options.go)
- [DeepSeek API](https://api-docs.deepseek.com/)
- [OpenAI models](https://developers.openai.com/api/docs/models)
- [OpenAI image API](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI embedding](https://developers.openai.com/api/docs/guides/embeddings)
- [OpenAI transcription](https://developers.openai.com/api/docs/guides/speech-to-text)
- [OpenAI TTS migration](https://developers.openai.com/api/docs/guides/text-to-speech)
- [Claude models](https://platform.claude.com/docs/en/models/overview)
- [Claude API](https://platform.claude.com/docs/en/api/overview)
- [Gemini models](https://ai.google.dev/gemini-api/docs/models)
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [Cohere rerank](https://docs.cohere.com/reference/rerank)
- [TypeSafe models and aliases](https://docs.typesafe.ai/models)


- [Qwen current text models](https://help.aliyun.cn/zh/model-studio/text-generation-model/)
- [Qwen structured output](https://help.aliyun.com/zh/model-studio/qwen-structured-output)
- [GLM 5.3 standard API](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)
- [GLM Coding Plan credential separation](https://docs.bigmodel.cn/cn/coding-plan/quick-start)
- [Kimi K3 standard API](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)
- [Kimi Code and product API separation](https://www.kimi.com/code/docs/en/)
- [Seedream current image models](https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=en)
- [Seedream editing capabilities](https://docs.volcengine.com/docs/ark/seedream-5-0-pro-editing-guide?lang=en)
- [MiniMax China TTS](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)
- [MiniMax international TTS](https://platform.minimax.io/docs/api-reference/speech-t2a-http)
- [DeepSeek JSON output](https://api-docs.deepseek.com/guides/json_mode/)
- [Mistral OCR](https://docs.mistral.ai/studio/document-processing/basic_ocr)
- [Mistral OCR API](https://docs.mistral.ai/api/endpoint/ocr)
- [Mistral model lifecycle](https://docs.mistral.ai/resources/changelogs)
- [Azure layout model](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0)
- [Cohere embedding models](https://docs.cohere.com/docs/cohere-embed)
- [Voyage embeddings](https://docs.voyageai.com/docs/embeddings)
- [Voyage rerank](https://docs.voyageai.com/docs/reranker)
- [Deepgram file transcription](https://developers.deepgram.com/docs/pre-recorded-audio)
- [Deepgram streaming](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)
- [Deepgram language coverage](https://developers.deepgram.com/docs/models-languages-overview/)
- [ElevenLabs models](https://elevenlabs.io/docs/overview/models/)
- [ElevenLabs STT](https://elevenlabs.io/docs/overview/capabilities/speech-to-text/)
- [ElevenLabs realtime STT](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)
- [ElevenLabs TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
- [Gemini TTS 3.8](https://ai.google.dev/gemini-api/docs/speech-generation)
- [Qwen multimodal embeddings](https://www.alibabacloud.com/help/en/model-studio/model-list-embedding-reranking)
- [Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings)
- [Wan video API](https://help.aliyun.com/zh/model-studio/text-to-video-api-reference)
- [Wan image API](https://help.aliyun.com/en/model-studio/wan-image-generation-and-editing-api-reference)
- [Wan image-to-video API](https://help.aliyun.com/en/model-studio/image-to-video-general-api-reference)
- [Seedance 2.5 tutorial](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh)
- [Seedance video generation API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)
- [Seedance video task results](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh)
- [Gemini video model](https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash)

## Local source anchors

- `packages/web/server/lib/builtin-skills/install.js:76`: install the ordinary bundled skills and the SuperPPT runtime.
- `packages/web/server/lib/builtin-skills/DOCUMENTATION.md:20`: existing copies are preserved.
- `packages/web/server/lib/embedded-knowledge/provision.js:185`: embedding/rerank setup.
- `packages/web/server/lib/embedded-knowledge/provision.js:118`: Wiki/graph defaults are off.
- `packages/web/server/lib/embedded-knowledge/local-defaults.js:181`: imported chat and image embedding are not wired into the library.
- `packages/ui/src/components/sections/openchamber/KnowledgeLibrarySettings.tsx:89`: first-run-only credential form.
- `packages/ui/src/components/sections/openchamber/DefaultsSettings.tsx:294`: default and helper model controls.
- `packages/web/server/builtin-skills/skills/ai-image-to-ppt/scripts/provider_credentials.py:11`: script credential consumption.
- `packages/web/server/builtin-skills/skills/image-to-editable-pptx/SKILL.md:32`: declared OCR/vision/edit dependencies.
- `packages/web/server/builtin-skills/supervideo-engine/src/providers/bailian.mjs:3`: pinned older TTS models and protocol.
- `packages/web/server/lib/routing/defaults.js:29`: existing Jev protocol and model.
