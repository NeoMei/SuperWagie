import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import "pixelmatch";
import "pngjs";
import { renderAsync } from "docx-preview";
//#region review-identifiers.ts
var LOWER_SHA256 = /^[0-9a-f]{64}$/;
var ARTIFACT_REVISION_ID = /^artifact-sha256:[0-9a-f]{64}$/;
var PREVIEW_REVISION_ID = /^preview-sha256:[0-9a-f]{64}$/;
var ANNOTATION_ID = /^annotation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var PAGE_ID = /^page-[1-9][0-9]{0,5}$/;
var CONTEXT_DIGEST = /^sha256:[0-9a-f]{64}$/;
var SEMANTIC_OBJECT_ID = /^semantic-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var CANDIDATE_ID = /^candidate-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validateMachineIdentity(value, format, label) {
	if (typeof value !== "string" || !format.test(value)) throw new Error(`${label} is invalid`);
	return value;
}
function validateLowerSha256(value, label) {
	return validateMachineIdentity(value, LOWER_SHA256, label);
}
function validateArtifactRevisionId(value, label = "artifactRevisionId") {
	return validateMachineIdentity(value, ARTIFACT_REVISION_ID, label);
}
function validatePreviewRevisionId(value, label = "previewRevisionId") {
	return validateMachineIdentity(value, PREVIEW_REVISION_ID, label);
}
function createPreviewRevisionId(contentHash) {
	return validatePreviewRevisionId(`preview-sha256:${validateLowerSha256(contentHash, "preview content hash")}`);
}
function validateAnnotationId(value, label = "annotationId") {
	return validateMachineIdentity(value, ANNOTATION_ID, label);
}
function validatePageId(value, label = "pageId") {
	return validateMachineIdentity(value, PAGE_ID, label);
}
function createPageId(pageNumber) {
	if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 999999) throw new Error("page number is invalid");
	return validatePageId(`page-${pageNumber}`);
}
function validateContextDigest(value, label = "context digest") {
	return validateMachineIdentity(value, CONTEXT_DIGEST, label);
}
function validateSemanticObjectId(value, label = "semanticObjectId") {
	return validateMachineIdentity(value, SEMANTIC_OBJECT_ID, label);
}
function validateCandidateId(value, label = "candidateId") {
	return validateMachineIdentity(value, CANDIDATE_ID, label);
}
//#endregion
//#region review-contract.ts
var ALLOWED = {
	queued: [
		"loading_fast",
		"rendering_authoritative",
		"unsupported",
		"dependency_missing"
	],
	loading_fast: [
		"fast_ready",
		"rendering_authoritative",
		"failed_recoverable"
	],
	fast_ready: ["rendering_authoritative", "failed_recoverable"],
	rendering_authoritative: [
		"authoritative_ready",
		"dependency_missing",
		"failed_recoverable",
		"failed_terminal"
	],
	authoritative_ready: ["accepted", "rendering_authoritative"],
	dependency_missing: ["rendering_authoritative"],
	unsupported: [],
	failed_recoverable: ["loading_fast", "rendering_authoritative"],
	failed_terminal: [],
	accepted: []
};
function assertTransition(from, to) {
	if (!ALLOWED[from].includes(to)) throw new Error(`invalid preview transition: ${from} -> ${to}`);
}
//#endregion
//#region annotation-reanchor.ts
var SELECTED_TEXT_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
var SELECTED_TEXT_DOMAIN = "superwagie.review.selected-text.v1\0";
var ANNOTATION_FIELDS = [
	"annotationId",
	"artifactRevisionId",
	"previewRevisionId",
	"fidelity",
	"pageId",
	"bbox",
	"selectedText",
	"beforeContextHash",
	"afterContextHash",
	"semanticObjectId",
	"status"
];
var CANDIDATE_FIELDS = [
	"candidateId",
	"pageId",
	"bbox",
	"semanticObjectId",
	"selectedText",
	"beforeContextHash",
	"afterContextHash",
	"imageFeatureScore"
];
var TARGET_FIELDS = [
	"artifactRevisionId",
	"previewRevisionId",
	"fidelity",
	"pageOrder",
	"candidates"
];
function validateNormalizedBox(value) {
	if (!Array.isArray(value) || value.length !== 4) throw new Error("normalized bbox must contain four finite numbers");
	const [x, y, width, height] = value;
	if (![
		x,
		y,
		width,
		height
	].every((item) => typeof item === "number" && Number.isFinite(item))) throw new Error("normalized bbox values must be finite");
	if (width <= 0 || height <= 0) throw new Error("normalized bbox width and height must be positive");
	if (x < 0 || y < 0 || x > 1 || y > 1 || width > 1 || height > 1) throw new Error("normalized bbox values must be in normalized range");
	if (x + width > 1 || y + height > 1) throw new Error("normalized bbox exceeds page bounds");
	return [
		x,
		y,
		width,
		height
	];
}
function createReviewAnnotation(input) {
	return normalizeReviewAnnotation(input, hashRawSelectedText);
}
function rehydrateReviewAnnotation(input) {
	return normalizeReviewAnnotation(input, validateSelectedTextFingerprint);
}
function normalizeReviewAnnotation(input, selectedTextNormalizer) {
	assertNoUnknownFields(input, ANNOTATION_FIELDS, "ReviewAnnotation");
	const annotationId = validateAnnotationId(input.annotationId, "annotationId");
	const artifactRevisionId = validateArtifactRevisionId(input.artifactRevisionId, "artifactRevisionId");
	const previewRevisionId = validatePreviewRevisionId(input.previewRevisionId, "previewRevisionId");
	const pageId = validatePageId(input.pageId, "pageId");
	const beforeContextHash = validateOptionalContextDigest(input.beforeContextHash, "beforeContextHash");
	const afterContextHash = validateOptionalContextDigest(input.afterContextHash, "afterContextHash");
	const semanticObjectId = validateOptionalSemanticObjectId(input.semanticObjectId, "semanticObjectId");
	if (!["fast", "authoritative"].includes(input.fidelity)) throw new Error("invalid fidelity");
	if (![
		"active",
		"stale",
		"unresolved"
	].includes(input.status)) throw new Error("invalid annotation status");
	const selectedText = selectedTextNormalizer(input.selectedText);
	const annotation = {
		annotationId,
		artifactRevisionId,
		previewRevisionId,
		fidelity: input.fidelity,
		pageId,
		status: input.status
	};
	if (input.bbox !== void 0) annotation.bbox = validateNormalizedBox(input.bbox);
	if (selectedText !== void 0) annotation.selectedText = selectedText;
	if (beforeContextHash !== void 0) annotation.beforeContextHash = beforeContextHash;
	if (afterContextHash !== void 0) annotation.afterContextHash = afterContextHash;
	if (semanticObjectId !== void 0) annotation.semanticObjectId = semanticObjectId;
	return annotation;
}
function reanchor(annotation, target) {
	if (!isValidReanchorInput(annotation, target)) return unresolved();
	const semantic = resolveUnique(annotation.semanticObjectId === void 0 ? [] : target.candidates.filter((entry) => entry.semanticObjectId === annotation.semanticObjectId), "semantic", 1);
	if (semantic !== null) return semantic;
	const exactTextContext = resolveUnique(target.candidates.filter((entry) => hasSelectedText(annotation, entry) && annotation.beforeContextHash !== void 0 && annotation.afterContextHash !== void 0 && entry.beforeContextHash === annotation.beforeContextHash && entry.afterContextHash === annotation.afterContextHash), "text-context", .95);
	if (exactTextContext !== null) return exactTextContext;
	const sourcePageIndex = target.pageOrder.indexOf(annotation.pageId);
	const adjacentText = resolveUnique(target.candidates.filter((entry) => {
		const candidatePageIndex = target.pageOrder.indexOf(entry.pageId);
		const beforeMatches = annotation.beforeContextHash !== void 0 && entry.beforeContextHash === annotation.beforeContextHash;
		const afterMatches = annotation.afterContextHash !== void 0 && entry.afterContextHash === annotation.afterContextHash;
		return hasSelectedText(annotation, entry) && Math.abs(candidatePageIndex - sourcePageIndex) <= 1 && (beforeMatches || afterMatches);
	}), "text-context", .85);
	if (adjacentText !== null) return adjacentText;
	const imageMatches = target.candidates.filter((entry) => entry.pageId === annotation.pageId && entry.imageFeatureScore !== void 0 && entry.imageFeatureScore >= .9);
	if (imageMatches.length === 0) return unresolved();
	const bestScore = Math.max(...imageMatches.map((entry) => entry.imageFeatureScore ?? 0));
	const best = imageMatches.filter((entry) => entry.imageFeatureScore === bestScore);
	return best.length === 1 ? resolved(best[0], "image-feature", bestScore) : unresolved();
}
function isValidReanchorInput(annotation, target) {
	try {
		rehydrateReviewAnnotation(annotation);
		assertNoUnknownFields(target, TARGET_FIELDS, "ReanchorTarget");
		validateArtifactRevisionId(target.artifactRevisionId, "artifactRevisionId");
		validatePreviewRevisionId(target.previewRevisionId, "previewRevisionId");
		if (!["fast", "authoritative"].includes(target.fidelity)) return false;
		if (!Array.isArray(target.pageOrder) || target.pageOrder.length === 0) return false;
		const pageIds = /* @__PURE__ */ new Set();
		for (const pageId of target.pageOrder) {
			validatePageId(pageId, "pageId");
			if (pageIds.has(pageId)) return false;
			pageIds.add(pageId);
		}
		if (!pageIds.has(annotation.pageId) || !Array.isArray(target.candidates)) return false;
		const candidateIds = /* @__PURE__ */ new Set();
		for (const entry of target.candidates) {
			assertNoUnknownFields(entry, CANDIDATE_FIELDS, "ReanchorCandidate");
			validateCandidateId(entry.candidateId, "candidateId");
			validatePageId(entry.pageId, "pageId");
			if (!pageIds.has(entry.pageId) || candidateIds.has(entry.candidateId)) return false;
			candidateIds.add(entry.candidateId);
			validateNormalizedBox(entry.bbox);
			validateOptionalSemanticObjectId(entry.semanticObjectId, "semanticObjectId");
			validateOptionalContextDigest(entry.beforeContextHash, "beforeContextHash");
			validateOptionalContextDigest(entry.afterContextHash, "afterContextHash");
			hashRawSelectedText(entry.selectedText);
			if (entry.imageFeatureScore !== void 0 && (!Number.isFinite(entry.imageFeatureScore) || entry.imageFeatureScore < 0 || entry.imageFeatureScore > 1)) return false;
		}
		return true;
	} catch {
		return false;
	}
}
function resolveUnique(matches, method, confidence) {
	if (matches.length === 0) return null;
	return matches.length === 1 ? resolved(matches[0], method, confidence) : unresolved();
}
function resolved(candidate, method, confidence) {
	return {
		status: "resolved",
		method,
		confidence,
		pageId: candidate.pageId,
		bbox: [...candidate.bbox]
	};
}
function unresolved() {
	return {
		status: "unresolved",
		confidence: 0
	};
}
function hasSelectedText(annotation, candidate) {
	return annotation.selectedText !== void 0 && SELECTED_TEXT_FINGERPRINT.test(annotation.selectedText) && hashRawSelectedText(candidate.selectedText) === annotation.selectedText;
}
function assertNoUnknownFields(value, allowed, label) {
	const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
	if (unknown.length > 0) throw new Error(`${label} has unknown field: ${unknown.join(", ")}`);
}
function validateOptionalContextDigest(value, label) {
	return value === void 0 ? void 0 : validateContextDigest(value, label);
}
function validateOptionalSemanticObjectId(value, label) {
	return value === void 0 ? void 0 : validateSemanticObjectId(value, label);
}
function hashRawSelectedText(value) {
	if (value === void 0) return void 0;
	if (typeof value !== "string" || value.length > 65536) throw new Error("selectedText is invalid");
	return validateContextDigest(`sha256:${createHash("sha256").update(SELECTED_TEXT_DOMAIN, "utf8").update(value, "utf8").digest("hex")}`, "selectedText fingerprint");
}
function validateSelectedTextFingerprint(value) {
	if (value === void 0) return void 0;
	try {
		return validateContextDigest(value, "selectedText fingerprint");
	} catch {
		throw new Error("selectedText fingerprint is invalid");
	}
}
//#endregion
//#region preview-orchestrator.ts
function createPreviewOrchestrator(fastAdapter, truthAdapter, onState) {
	let activeSessions = [];
	let cancellationGeneration = 0;
	return {
		async run(request) {
			const states = [];
			let currentState = null;
			const runGeneration = cancellationGeneration;
			const isCancelled = () => runGeneration !== cancellationGeneration;
			const cancelledResult = () => ({
				states,
				canAccept: false
			});
			const emit = (nextState) => {
				if (isCancelled()) return false;
				if (currentState !== null) assertTransition(currentState, nextState);
				currentState = nextState;
				states.push(nextState);
				onState(nextState);
				return true;
			};
			emit("queued");
			if (request.mediaType.includes("wordprocessingml.document") && fastAdapter !== null) {
				emit("loading_fast");
				try {
					const fastSession = await fastAdapter.open(request);
					if (isCancelled()) {
						await fastAdapter.cancel(fastSession.sessionId);
						return cancelledResult();
					}
					activeSessions.push({
						adapter: fastAdapter,
						sessionId: fastSession.sessionId
					});
					emit("fast_ready");
				} catch {
					if (isCancelled()) return cancelledResult();
					emit("failed_recoverable");
				}
			}
			if (!emit("rendering_authoritative")) return cancelledResult();
			let truthAvailable;
			try {
				truthAvailable = (await truthAdapter.probe()).available;
			} catch {
				if (isCancelled()) return cancelledResult();
				emit("failed_recoverable");
				return {
					states,
					canAccept: false
				};
			}
			if (isCancelled()) return cancelledResult();
			if (!truthAvailable) {
				emit("dependency_missing");
				return {
					states,
					canAccept: false
				};
			}
			try {
				const truthSession = await truthAdapter.open(request);
				if (isCancelled()) {
					await truthAdapter.cancel(truthSession.sessionId);
					return cancelledResult();
				}
				activeSessions.push({
					adapter: truthAdapter,
					sessionId: truthSession.sessionId
				});
				emit("authoritative_ready");
				return {
					states,
					canAccept: true
				};
			} catch {
				if (isCancelled()) return cancelledResult();
				emit("failed_terminal");
				return {
					states,
					canAccept: false
				};
			}
		},
		async cancel() {
			cancellationGeneration += 1;
			const sessionsToCancel = activeSessions;
			activeSessions = [];
			await Promise.all(sessionsToCancel.map(({ adapter, sessionId }) => adapter.cancel(sessionId)));
		}
	};
}
//#endregion
//#region reviewer-ui/src/docx-fast-adapter.ts
var nextSessionId = 0;
var DocxFastAdapter = class {
	host;
	containers;
	id = "docx-preview-fast";
	sessions = /* @__PURE__ */ new Map();
	constructor(host, containers = {}) {
		this.host = host;
		this.containers = containers;
	}
	async probe() {
		return typeof document === "undefined" ? {
			available: false,
			reason: "DOM rendering is unavailable"
		} : { available: true };
	}
	async open(request) {
		if (!request.mediaType.includes("wordprocessingml.document")) throw new Error(`DocxFastAdapter does not support ${request.mediaType}`);
		const artifactRevisionId = validateArtifactRevisionId(request.artifactRevisionId);
		const assetUrl = await this.host.assetUrl(request.artifactHandle, "artifact");
		assertReviewAssetUrl(assetUrl);
		const response = await fetch(assetUrl, {
			method: "GET",
			credentials: "omit",
			cache: "no-store",
			redirect: "error"
		});
		if (!response.ok) throw new Error(`review asset request failed with ${response.status}`);
		const bytes = await response.arrayBuffer();
		const bodyContainer = this.containers.bodyContainer ?? document.createElement("main");
		const styleContainer = this.containers.styleContainer ?? document.createElement("div");
		stampFastOnlyStatus(bodyContainer);
		await renderAsync(bytes, bodyContainer, styleContainer, {
			className: "superwagie-docx-fast",
			renderAltChunks: false,
			useBase64URL: true,
			ignoreLastRenderedPageBreak: false
		});
		makeRenderedLinksInert(bodyContainer);
		stampFastOnlyStatus(bodyContainer);
		let pageElements = Array.from(bodyContainer.querySelectorAll("section.superwagie-docx-fast"));
		if (pageElements.length === 0) pageElements = [bodyContainer];
		const pages = pageElements.map((page, index) => {
			stampFastOnlyStatus(page);
			const bounds = page.getBoundingClientRect();
			return {
				pageId: createPageId(index + 1),
				width: bounds.width || 816,
				height: bounds.height || 1056
			};
		});
		const sourceContentHash = await sha256Hex(new Uint8Array(bytes));
		const pageManifestHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(pages)));
		const previewRevisionInput = {
			artifactRevisionId,
			fidelity: "fast",
			rendererId: "docx-preview",
			rendererVersion: "0.4.0",
			rendererEnvironmentHash: await sha256Hex(new TextEncoder().encode("docx-preview-0.4.0|superwagie-docx-fast")),
			fontEnvironmentHash: await sha256Hex(new TextEncoder().encode("webview-font-environment-non-authoritative")),
			sourceContentHash,
			pageManifestHash
		};
		const previewRevisionId = createPreviewRevisionId(await sha256Hex(new TextEncoder().encode(JSON.stringify(previewRevisionInput))));
		const manifest = {
			previewRevision: {
				...previewRevisionInput,
				previewRevisionId,
				acceptanceState: "not_eligible"
			},
			pages
		};
		const sessionId = `docx-fast-session-${nextSessionId += 1}`;
		this.sessions.set(sessionId, {
			manifest,
			bodyContainer,
			styleContainer,
			pages: new Map(pageElements.map((page, index) => [createPageId(index + 1), page]))
		});
		return {
			sessionId,
			state: "fast_ready",
			manifest
		};
	}
	async getManifest(sessionId) {
		const session = this.requireSession(sessionId);
		assertFastOnlyManifest(session.manifest);
		stampFastOnlyStatus(session.bodyContainer);
		return session.manifest;
	}
	async getPage(sessionId, pageId, _scaleBucket) {
		const session = this.requireSession(sessionId);
		stampFastOnlyStatus(requirePage(session, pageId));
		const manifestPage = session.manifest.pages.find((candidate) => candidate.pageId === pageId);
		if (!manifestPage) throw new Error(`unknown DOCX fast page manifest: ${pageId}`);
		return {
			...manifestPage,
			surfaceHandle: `docx-fast-surface:${sessionId}:${pageId}`
		};
	}
	async getThumbnail(sessionId, pageId) {
		const page = await this.getPage(sessionId, pageId, 1);
		const scale = Math.min(1, 180 / page.width);
		return {
			...page,
			width: page.width * scale,
			height: page.height * scale
		};
	}
	async getTextLayer(sessionId, pageId) {
		const text = requirePage(this.requireSession(sessionId), pageId).textContent?.trim() ?? "";
		if (text.length === 0) return { items: [] };
		return { items: [{
			text,
			bbox: [
				0,
				0,
				1,
				1
			]
		}] };
	}
	mountSurface(surfaceHandle, target) {
		for (const [sessionId, session] of this.sessions) for (const [pageId, page] of session.pages) {
			if (surfaceHandle !== `docx-fast-surface:${sessionId}:${pageId}`) continue;
			const fragment = target.ownerDocument.createDocumentFragment();
			for (const styleNode of session.styleContainer.childNodes) fragment.append(styleNode.cloneNode(true));
			const visiblePage = page.cloneNode(true);
			makeRenderedLinksInert(visiblePage);
			stampFastOnlyStatus(visiblePage);
			visiblePage.hidden = false;
			fragment.append(visiblePage);
			target.replaceChildren(fragment);
			return true;
		}
		return false;
	}
	async cancel(sessionId) {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.sessions.delete(sessionId);
		session.bodyContainer.replaceChildren();
		session.styleContainer.replaceChildren();
		delete session.bodyContainer.dataset.previewFidelity;
		delete session.bodyContainer.dataset.acceptanceState;
		session.pages.clear();
	}
	requireSession(sessionId) {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`unknown DOCX fast session: ${sessionId}`);
		return session;
	}
};
function stampFastOnlyStatus(element) {
	element.dataset.previewFidelity = "fast";
	element.dataset.acceptanceState = "not_eligible";
}
function makeRenderedLinksInert(bodyContainer) {
	for (const link of bodyContainer.querySelectorAll("a, area")) {
		const inertText = bodyContainer.ownerDocument.createElement("span");
		inertText.dataset.docxLinkInert = "";
		inertText.setAttribute("role", "text");
		const className = link.getAttribute("class");
		if (className) inertText.className = className;
		while (link.firstChild) inertText.append(link.firstChild);
		if (!inertText.hasChildNodes()) inertText.textContent = link.getAttribute("aria-label") ?? link.getAttribute("title") ?? "";
		link.replaceWith(inertText);
	}
}
function assertFastOnlyManifest(manifest) {
	if (manifest.previewRevision.fidelity !== "fast" || manifest.previewRevision.acceptanceState !== "not_eligible") throw new Error("DOCX fast preview invariant was violated");
}
function assertReviewAssetUrl(candidate) {
	try {
		const url = new URL(candidate);
		if (url.protocol !== "reviewasset:" || url.hostname !== "localhost" || url.username !== "" || url.password !== "" || url.port !== "" || url.pathname === "" || url.pathname === "/") throw new Error("forbidden");
	} catch {
		throw new Error("HostBridge returned a forbidden review asset URL");
	}
}
function requirePage(session, pageId) {
	const page = session.pages.get(pageId);
	if (!page) throw new Error(`unknown DOCX fast page: ${pageId}`);
	return page;
}
async function sha256Hex(bytes) {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
//#endregion
//#region reviewer-ui/src/review-shell.ts
var ZOOM_BUCKETS = [
	.5,
	.67,
	.8,
	1,
	1.25,
	1.5,
	2
];
var STATUS_LABELS = {
	queued: "正在准备预览",
	loading_fast: "正在快速预览",
	fast_ready: "快速预览可用，原格式待核对",
	rendering_authoritative: "原格式预览准备中",
	authoritative_ready: "原格式已就绪",
	dependency_missing: "需要 WPS 才能核对原格式",
	unsupported: "暂不支持此格式",
	failed_recoverable: "预览暂时失败，可以重试",
	failed_terminal: "无法打开此预览",
	accepted: "此版本已接受"
};
/**
* Recreates the review shell strictly from already-persisted accepted state.
* This entry point deliberately cannot start a truth render: callers must only
* supply an existing manifest whose revision matches the durable receipt.
*/
function rehydrateReviewShell(options) {
	const { durableState, manifest } = options;
	if (!manifest || durableState.acceptedPreviewRevisionId !== manifest.previewRevision.previewRevisionId) throw new Error("accepted preview revision does not match the supplied manifest");
	if (!Number.isSafeInteger(durableState.currentPage) || durableState.currentPage < 1 || durableState.currentPage > manifest.pages.length) throw new Error("durable review page is outside the supplied manifest");
	return renderReviewShell({
		...options,
		state: "accepted",
		currentPage: durableState.currentPage
	});
}
function renderReviewShell(options) {
	const { root, manifest, mode, host, artifactHandle, pageSurfaces = /* @__PURE__ */ new Map(), textLayers = /* @__PURE__ */ new Map(), mountSurface, getViewportSize = () => ({
		width: root.clientWidth,
		height: root.clientHeight
	}), onContinue, onClose, onProgressVisible, onFirstPageVisible, onInteraction } = options;
	let currentState = options.state;
	let currentPage = clampPage(options.currentPage ?? 1, manifest?.pages.length ?? 0);
	let zoomState = {
		bucket: 1,
		displayPercent: 100,
		mode: "percentage"
	};
	let observer = null;
	let destroyed = false;
	let firstPageReported = false;
	const pendingInteractions = /* @__PURE__ */ new Set();
	root.replaceChildren();
	root.className = `review-shell review-shell--${mode}`;
	root.dataset.documentMode = mode;
	root.tabIndex = 0;
	root.setAttribute("aria-label", "文档审阅");
	const header = createRegion("header", "review-header");
	header.className = "review-header";
	const rail = createRegion("aside", "page-rail");
	rail.className = "page-rail";
	rail.setAttribute("aria-label", "页面导航");
	const viewport = createRegion("main", "document-viewport");
	viewport.className = "document-viewport";
	viewport.setAttribute("aria-label", mode === "word" ? "连续文档预览" : "单张幻灯片预览");
	const overlay = createRegion("section", "review-overlay");
	overlay.className = "review-overlay";
	overlay.setAttribute("aria-label", "审阅标记");
	const footer = createRegion("footer", "review-status");
	footer.className = "review-status";
	footer.setAttribute("aria-live", "polite");
	const continueButton = actionButton("继续修改", "continue");
	const openCopyButton = actionButton("在 WPS 打开副本", "open-copy");
	const acceptButton = actionButton("接受此版本", "accept");
	const closeButton = actionButton("关闭预览", "close");
	header.append(continueButton, openCopyButton, acceptButton, closeButton);
	const annotationButton = document.createElement("button");
	annotationButton.type = "button";
	annotationButton.className = "annotation-button";
	annotationButton.setAttribute("aria-label", "添加批注");
	annotationButton.textContent = "添加批注";
	overlay.append(annotationButton);
	const statusText = document.createElement("span");
	statusText.className = "review-status__label";
	const pageText = document.createElement("span");
	pageText.className = "review-status__page";
	const zoomToolbar = document.createElement("div");
	zoomToolbar.className = "zoom-toolbar";
	zoomToolbar.setAttribute("role", "toolbar");
	zoomToolbar.setAttribute("aria-label", "预览缩放");
	const fitWidthButton = zoomButton("适宽", "fit-width");
	const fitPageButton = zoomButton("适页", "fit-page");
	const zoomSelect = document.createElement("select");
	zoomSelect.setAttribute("aria-label", "缩放百分比");
	zoomSelect.className = "zoom-select";
	for (const bucket of ZOOM_BUCKETS) {
		const option = document.createElement("option");
		option.value = String(bucket);
		option.textContent = `${Math.round(bucket * 100)}%`;
		if (bucket === 1) option.selected = true;
		zoomSelect.append(option);
	}
	const zoomDisplay = document.createElement("span");
	zoomDisplay.dataset.testid = "zoom-display";
	zoomDisplay.className = "zoom-display";
	zoomDisplay.textContent = "100%";
	zoomToolbar.append(fitWidthButton, fitPageButton, zoomSelect, zoomDisplay);
	const receiptStatus = document.createElement("span");
	receiptStatus.className = "review-status__receipt";
	receiptStatus.setAttribute("role", "status");
	footer.append(statusText, pageText, zoomToolbar, receiptStatus);
	root.append(header, rail, viewport, overlay, footer);
	function emitInteraction(name) {
		if (!onInteraction || destroyed || pendingInteractions.has(name)) return;
		pendingInteractions.add(name);
		Promise.resolve(onInteraction(name)).finally(() => pendingInteractions.delete(name));
	}
	function renderState() {
		statusText.textContent = STATUS_LABELS[currentState];
		acceptButton.disabled = currentState !== "authoritative_ready" || !manifest;
		openCopyButton.disabled = artifactHandle === null;
		if (currentState === "loading_fast" || currentState === "rendering_authoritative") onProgressVisible?.();
	}
	function renderRail() {
		rail.replaceChildren();
		for (let index = 0; index < (manifest?.pages.length ?? 0); index += 1) {
			const pageNumber = index + 1;
			const button = document.createElement("button");
			button.type = "button";
			button.className = "page-rail__button";
			button.dataset.pageNumber = String(pageNumber);
			button.setAttribute("aria-label", `第 ${pageNumber} 页`);
			button.textContent = String(pageNumber);
			if (pageNumber === currentPage) button.setAttribute("aria-current", "page");
			button.addEventListener("click", () => navigateToPage(pageNumber, true));
			rail.append(button);
		}
	}
	function renderDocument() {
		observer?.disconnect();
		observer = null;
		viewport.replaceChildren();
		const pages = manifest?.pages ?? [];
		if (pages.length === 0) {
			pageText.textContent = "尚无页面";
			return;
		}
		pageText.textContent = `第 ${currentPage} / ${pages.length} 页`;
		pages.forEach((page, index) => {
			const pageNumber = index + 1;
			const mounted = Math.abs(pageNumber - currentPage) <= 2;
			const pageElement = document.createElement("article");
			pageElement.className = mounted ? "review-page" : "review-page-placeholder";
			pageElement.dataset.pageId = page.pageId;
			pageElement.dataset.pageNumber = String(pageNumber);
			pageElement.setAttribute("aria-label", `第 ${pageNumber} 页`);
			pageElement.style.setProperty("--page-aspect-ratio", `${page.width} / ${page.height}`);
			pageElement.style.width = `${page.width * zoomState.displayPercent / 100}px`;
			pageElement.style.height = `${page.height * zoomState.displayPercent / 100}px`;
			pageElement.hidden = mode === "presentation" && pageNumber !== currentPage;
			if (mounted) {
				pageElement.dataset.mountedPage = "";
				if (mode === "word" || pageNumber === currentPage) pageElement.dataset.visiblePage = "";
				if (pageNumber === currentPage) pageElement.dataset.currentPage = "";
				pageElement.dataset.scaleBucket = String(zoomState.bucket);
				renderPageContent(pageElement, page.pageId, pageSurfaces.get(page.pageId), textLayers.get(page.pageId), mountSurface);
			} else {
				pageElement.dataset.pagePlaceholder = "";
				pageElement.setAttribute("aria-hidden", "true");
			}
			viewport.append(pageElement);
		});
		if (typeof IntersectionObserver !== "undefined") {
			observer = new IntersectionObserver((entries) => {
				const visible = entries.filter((entry) => entry.isIntersecting).sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
				const pageNumber = Number((visible?.target)?.dataset.pageNumber);
				if (Number.isInteger(pageNumber) && pageNumber !== currentPage) navigateToPage(pageNumber, false);
			}, {
				root: viewport,
				threshold: [
					.25,
					.5,
					.75
				]
			});
			for (const pageElement of viewport.children) if (!pageElement.hidden) observer.observe(pageElement);
		}
		if (!firstPageReported) {
			firstPageReported = true;
			onFirstPageVisible?.();
		}
	}
	function navigateToPage(requestedPage, isUserAction) {
		const nextPage = clampPage(requestedPage, manifest?.pages.length ?? 0);
		if (nextPage === 0 || nextPage === currentPage) return;
		if (isUserAction) emitInteraction("page");
		currentPage = nextPage;
		renderRail();
		renderDocument();
		if (isUserAction) viewport.querySelector(`[data-page-number="${currentPage}"]`)?.scrollIntoView?.({ block: "center" });
	}
	function setZoom(next, isUserAction = true) {
		if (isUserAction) emitInteraction("zoom");
		zoomState = next;
		zoomDisplay.textContent = `${next.displayPercent}%`;
		zoomSelect.value = String(next.bucket);
		renderDocument();
	}
	function fitZoom(fitMode) {
		const page = manifest?.pages[currentPage - 1];
		if (!page) return;
		const viewportSize = getViewportSize();
		const requestedScale = fitMode === "fit-width" ? viewportSize.width / page.width : Math.min(viewportSize.width / page.width, viewportSize.height / page.height);
		setZoom({
			bucket: closestBucket(requestedScale),
			displayPercent: Math.max(1, Math.round(requestedScale * 100)),
			mode: fitMode
		});
	}
	function adjustZoom(direction) {
		const currentIndex = ZOOM_BUCKETS.indexOf(zoomState.bucket);
		const baseIndex = currentIndex >= 0 ? currentIndex : closestBucketIndex(zoomState.bucket);
		const bucket = ZOOM_BUCKETS[Math.min(ZOOM_BUCKETS.length - 1, Math.max(0, baseIndex + direction))] ?? 1;
		setZoom({
			bucket,
			displayPercent: Math.round(bucket * 100),
			mode: "percentage"
		});
	}
	const handleKeyDown = (event) => {
		if (isEditableTarget(event.target)) return;
		switch (event.key) {
			case "PageUp":
				navigateToPage(currentPage - 1, true);
				break;
			case "PageDown":
				navigateToPage(currentPage + 1, true);
				break;
			case "Home":
				navigateToPage(1, true);
				break;
			case "End":
				navigateToPage(manifest?.pages.length ?? 0, true);
				break;
			case "+":
				adjustZoom(1);
				break;
			case "-":
				adjustZoom(-1);
				break;
			case "0":
				setZoom({
					bucket: 1,
					displayPercent: 100,
					mode: "percentage"
				});
				break;
			default: return;
		}
		event.preventDefault();
	};
	const handleScroll = () => emitInteraction("scroll");
	const handleSelection = () => emitInteraction("selection");
	const handleAnnotation = () => emitInteraction("annotation");
	continueButton.addEventListener("click", () => {
		onContinue?.();
		receiptStatus.textContent = "已返回修改流程";
	});
	openCopyButton.addEventListener("click", async () => {
		if (!artifactHandle) return;
		openCopyButton.disabled = true;
		try {
			const receipt = await host.openControlledCopy(artifactHandle);
			receiptStatus.textContent = `副本回执：${receipt.receiptId}`;
		} catch {
			receiptStatus.textContent = "暂时无法打开受控副本";
		} finally {
			if (!destroyed) openCopyButton.disabled = false;
		}
	});
	acceptButton.addEventListener("click", async () => {
		if (currentState !== "authoritative_ready" || !manifest) return;
		acceptButton.disabled = true;
		try {
			await host.acceptPreview(manifest.previewRevision.previewRevisionId);
			currentState = "accepted";
			renderState();
		} catch {
			receiptStatus.textContent = "暂时无法接受此版本";
			if (!destroyed) renderState();
		}
	});
	closeButton.addEventListener("click", () => {
		if (onClose) onClose();
		else root.hidden = true;
	});
	fitWidthButton.addEventListener("click", () => fitZoom("fit-width"));
	fitPageButton.addEventListener("click", () => fitZoom("fit-page"));
	zoomSelect.addEventListener("change", () => {
		const bucket = Number(zoomSelect.value);
		if (isZoomBucket(bucket)) setZoom({
			bucket,
			displayPercent: Math.round(bucket * 100),
			mode: "percentage"
		});
	});
	root.addEventListener("keydown", handleKeyDown);
	viewport.addEventListener("scroll", handleScroll, { passive: true });
	viewport.addEventListener("pointerup", handleSelection);
	annotationButton.addEventListener("click", handleAnnotation);
	renderState();
	renderRail();
	renderDocument();
	return {
		currentPage: () => currentPage,
		zoom: () => ({ ...zoomState }),
		setState(state) {
			if (destroyed) return;
			currentState = state;
			renderState();
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			observer?.disconnect();
			observer = null;
			root.removeEventListener("keydown", handleKeyDown);
			viewport.removeEventListener("scroll", handleScroll);
			viewport.removeEventListener("pointerup", handleSelection);
			annotationButton.removeEventListener("click", handleAnnotation);
			root.replaceChildren();
		}
	};
}
function createRegion(tag, testId) {
	const element = document.createElement(tag);
	element.dataset.testid = testId;
	return element;
}
function actionButton(label, action) {
	const button = document.createElement("button");
	button.type = "button";
	button.dataset.action = action;
	button.dataset.reviewAction = "";
	button.setAttribute("aria-label", label);
	button.textContent = label;
	return button;
}
function zoomButton(label, mode) {
	const button = document.createElement("button");
	button.type = "button";
	button.dataset.zoom = mode;
	button.setAttribute("aria-label", label === "适宽" ? "缩放至适宽" : "缩放至适页");
	button.textContent = label;
	return button;
}
function renderPageContent(pageElement, pageId, surface, textLayer, mountSurface) {
	const surfaceElement = document.createElement("div");
	surfaceElement.className = "page-surface";
	surfaceElement.dataset.pageSurface = "";
	surfaceElement.setAttribute("aria-hidden", "true");
	if (surface && mountSurface) mountSurface(surface, surfaceElement);
	pageElement.append(surfaceElement);
	const textLayerElement = document.createElement("div");
	textLayerElement.className = "text-layer";
	textLayerElement.dataset.textLayer = "";
	textLayerElement.dataset.pageId = pageId;
	for (const item of textLayer?.items ?? []) {
		const text = document.createElement("span");
		text.textContent = item.text;
		text.style.left = `${item.bbox[0] * 100}%`;
		text.style.top = `${item.bbox[1] * 100}%`;
		text.style.width = `${item.bbox[2] * 100}%`;
		text.style.height = `${item.bbox[3] * 100}%`;
		textLayerElement.append(text);
	}
	pageElement.append(textLayerElement);
}
function clampPage(requestedPage, pageCount) {
	if (pageCount <= 0) return 0;
	return Math.min(pageCount, Math.max(1, Math.trunc(requestedPage)));
}
function closestBucket(requestedScale) {
	return ZOOM_BUCKETS[closestBucketIndex(requestedScale)] ?? 1;
}
function closestBucketIndex(requestedScale) {
	let closestIndex = 0;
	let closestDistance = Number.POSITIVE_INFINITY;
	ZOOM_BUCKETS.forEach((bucket, index) => {
		const distance = Math.abs(bucket - requestedScale);
		if (distance < closestDistance) {
			closestDistance = distance;
			closestIndex = index;
		}
	});
	return closestIndex;
}
function isZoomBucket(value) {
	return ZOOM_BUCKETS.some((bucket) => bucket === value);
}
function isEditableTarget(target) {
	if (!(target instanceof HTMLElement)) return false;
	return target.matches("input, textarea, select, [contenteditable=\"true\"]");
}
//#endregion
//#region recovery-contract-harness.ts
var OLD_ARTIFACT_REVISION = `artifact-sha256:${"2".repeat(64)}`;
var OLD_PREVIEW_REVISION = `preview-sha256:${"1".repeat(64)}`;
var NEW_ARTIFACT_REVISION = `artifact-sha256:${"3".repeat(64)}`;
var NEW_PREVIEW_REVISION = `preview-sha256:${"4".repeat(64)}`;
var FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/gate-3/G3-REVIEW-001");
var UnavailableTruthAdapter = class {
	id = "fixed-unavailable-truth-fault";
	async probe() {
		return { available: false };
	}
	async open(_request) {
		throw new Error("dependency missing");
	}
	async getManifest(_sessionId) {
		throw new Error("dependency missing");
	}
	async getPage(_sessionId, _pageId, _scaleBucket) {
		throw new Error("dependency missing");
	}
	async getThumbnail(_sessionId, _pageId) {
		throw new Error("dependency missing");
	}
	async getTextLayer(_sessionId, _pageId) {
		return null;
	}
	async cancel(_sessionId) {}
};
function installDom() {
	const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true });
	const window = dom.window;
	Object.assign(globalThis, {
		window,
		document: window.document,
		Node: window.Node,
		Element: window.Element,
		HTMLElement: window.HTMLElement,
		HTMLCanvasElement: window.HTMLCanvasElement,
		DOMParser: window.DOMParser,
		XMLSerializer: window.XMLSerializer,
		getComputedStyle: window.getComputedStyle.bind(window)
	});
	return dom;
}
function fixedHost(bytes, onTruthRender = () => {}) {
	const assetUrl = "reviewasset://localhost/fixed-recovery-docx";
	globalThis.fetch = async (input) => {
		if ((typeof input === "string" ? input : input instanceof URL ? input.href : input.url) !== assetUrl) return new Response("missing review asset", { status: 404 });
		return new Response(bytes.slice().buffer, { status: 200 });
	};
	return {
		async assetUrl() {
			return assetUrl;
		},
		async startTruthRender() {
			onTruthRender();
			return { jobId: "00000000000000000000000000000000" };
		},
		async previewStatus() {
			return {
				jobId: "00000000000000000000000000000000",
				state: "queued"
			};
		},
		async saveAnnotation() {},
		async acceptPreview() {},
		async openControlledCopy() {
			return { receiptId: "fixed-recovery-copy-receipt" };
		},
		async recordMetrics(_snapshot) {}
	};
}
async function wpsMissing() {
	const dom = installDom();
	try {
		const host = fixedHost(new Uint8Array(await readFile(path.join(FIXTURE_ROOT, "fixtures/reviewer-torture-30p.docx"))));
		const bodyContainer = document.createElement("main");
		const styleContainer = document.createElement("div");
		document.body.append(bodyContainer, styleContainer);
		const fast = new DocxFastAdapter(host, {
			bodyContainer,
			styleContainer
		});
		const truth = new UnavailableTruthAdapter();
		const request = {
			artifactRevisionId: OLD_ARTIFACT_REVISION,
			artifactHandle: "11111111111111111111111111111111",
			mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			preferredFidelity: "authoritative",
			deadlineMs: 1e3
		};
		const adapterSession = await fast.open(request);
		const manifest = await fast.getManifest(adapterSession.sessionId);
		const firstTextLayer = await fast.getTextLayer(adapterSession.sessionId, manifest.pages[0]?.pageId ?? "");
		await fast.cancel(adapterSession.sessionId);
		const docx = await createPreviewOrchestrator(fast, truth, () => {}).run(request);
		const pptx = await createPreviewOrchestrator(fast, truth, () => {}).run({
			artifactRevisionId: OLD_ARTIFACT_REVISION,
			artifactHandle: "22222222222222222222222222222222",
			mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			preferredFidelity: "authoritative",
			deadlineMs: 1e3
		});
		const readable = manifest.pages.length > 0 && (firstTextLayer?.items.some((item) => item.text.trim().length > 0) ?? false);
		return {
			docx: {
				state: docx.states.at(-1) === "dependency_missing" && docx.states.includes("fast_ready") ? "fast_ready" : docx.states.at(-1),
				fidelity: manifest.previewRevision.fidelity,
				readable,
				acceptance_enabled: docx.canAccept || manifest.previewRevision.acceptanceState !== "not_eligible"
			},
			pptx: {
				state: pptx.states.at(-1),
				preview_published: pptx.states.includes("authoritative_ready"),
				acceptance_enabled: pptx.canAccept
			}
		};
	} finally {
		dom.window.close();
	}
}
function sourceRevisionChanged() {
	const annotation = Object.freeze(createReviewAnnotation({
		annotationId: "annotation-12345678-1234-4123-8123-123456789abc",
		artifactRevisionId: OLD_ARTIFACT_REVISION,
		previewRevisionId: OLD_PREVIEW_REVISION,
		fidelity: "authoritative",
		pageId: "page-4",
		bbox: [
			.1,
			.2,
			.3,
			.2
		],
		semanticObjectId: "semantic-87654321-4321-4123-8123-cba987654321",
		status: "active"
	}));
	const readBinding = () => ({
		annotation_id: annotation.annotationId,
		artifact_revision_id: annotation.artifactRevisionId,
		preview_revision_id: annotation.previewRevisionId,
		page_id: annotation.pageId
	});
	const before = readBinding();
	const relocation = reanchor(annotation, {
		artifactRevisionId: NEW_ARTIFACT_REVISION,
		previewRevisionId: NEW_PREVIEW_REVISION,
		fidelity: "authoritative",
		pageOrder: ["page-4", "page-5"],
		candidates: [{
			candidateId: "candidate-abcdef12-3456-4789-8123-abcdef123456",
			pageId: "page-5",
			bbox: [
				.2,
				.2,
				.3,
				.2
			],
			semanticObjectId: annotation.semanticObjectId
		}]
	});
	const after = readBinding();
	const relocationIsExplicit = relocation.status === "resolved" || relocation.status === "unresolved";
	const bindingChanged = JSON.stringify(before) !== JSON.stringify(after);
	return {
		old_annotation_binding_before: before,
		old_annotation_binding_after: after,
		target_revision: {
			artifact_revision_id: NEW_ARTIFACT_REVISION,
			preview_revision_id: NEW_PREVIEW_REVISION
		},
		relocation: {
			status: relocation.status,
			method: relocation.method ?? null,
			page_id: relocation.pageId ?? null
		},
		silent_movement: bindingChanged || !relocationIsExplicit
	};
}
function acceptedManifest() {
	return {
		previewRevision: {
			previewRevisionId: OLD_PREVIEW_REVISION,
			artifactRevisionId: OLD_ARTIFACT_REVISION,
			fidelity: "authoritative",
			rendererId: "fixed-recovery-renderer",
			rendererVersion: "1",
			rendererEnvironmentHash: "fixed-renderer-environment",
			fontEnvironmentHash: "fixed-font-environment",
			sourceContentHash: "fixed-source-content",
			pageManifestHash: "fixed-page-manifest",
			acceptanceState: "reviewable"
		},
		pages: Array.from({ length: 3 }, (_unused, index) => ({
			pageId: `page-${index + 1}`,
			width: 800,
			height: 1e3
		}))
	};
}
function webviewRestart() {
	const dom = installDom();
	try {
		let startTruthRenderCalls = 0;
		const host = fixedHost(/* @__PURE__ */ new Uint8Array(), () => {
			startTruthRenderCalls += 1;
		});
		const root = document.createElement("div");
		document.body.append(root);
		const durableState = {
			acceptedPreviewRevisionId: OLD_PREVIEW_REVISION,
			currentPage: 2
		};
		const beforeRestart = startTruthRenderCalls;
		const controller = rehydrateReviewShell({
			root,
			manifest: acceptedManifest(),
			mode: "word",
			artifactHandle: "33333333333333333333333333333333",
			host,
			durableState
		});
		const afterRestart = startTruthRenderCalls;
		const outcome = {
			active_page_before: durableState.currentPage,
			active_page_after: controller.currentPage(),
			accepted_state_restored: root.querySelector("[data-testid=\"review-status\"]")?.textContent?.includes("此版本已接受") ?? false,
			render_side_effects: {
				before_restart: beforeRestart,
				after_restart: afterRestart,
				replayed: afterRestart !== beforeRestart
			}
		};
		controller.destroy();
		return outcome;
	} finally {
		dom.window.close();
	}
}
async function main() {
	const scenario = process.argv[2];
	if (process.argv.length !== 3 || ![
		"wps-missing",
		"source-revision-changed",
		"webview-restart"
	].includes(scenario ?? "")) {
		process.exitCode = 64;
		return;
	}
	const outcome = scenario === "wps-missing" ? await wpsMissing() : scenario === "source-revision-changed" ? sourceRevisionChanged() : webviewRestart();
	const contractSources = scenario === "wps-missing" ? ["preview-orchestrator.ts", "reviewer-ui/src/docx-fast-adapter.ts"] : scenario === "source-revision-changed" ? ["annotation-reanchor.ts"] : ["reviewer-ui/src/review-shell.ts"];
	process.stdout.write(`${JSON.stringify({
		schema_id: "superwagie.recovery-ts-harness.v1",
		schema_version: 1,
		scenario,
		contract_sources: contractSources,
		outcome
	})}\n`);
}
main();
//#endregion
export {};
