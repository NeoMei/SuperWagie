import type { Kind } from './wizard.ts';
import { creationLocale, creationText, type CreationMessageKey } from './i18n.ts';

const translator = (locale: string | undefined) => (key: CreationMessageKey, params?: { [name: string]: string | number }): string => creationText(locale, key, params);

export type StepState = 'done' | 'now' | 'next';
export type Step = { id: string; label: string; state: StepState };

export type GateChoice = {
  styleId: string;
  styleName: string;
  levels: number[];
  palettes: Array<{ id: string; name: string }>;
};

export type GateMedia = { kind: 'image' | 'video' | 'html'; label: string; path: string };

export type GateOption = { id: string; name: string; detail?: string };

export type Gate = {
  key: 'deck-style' | 'deck-sample' | 'deck-deliver' | 'doc-review' | 'video-script' | 'video-sample' | 'video-final' | 'web-direction' | 'web-sample' | 'web-full' | 'web-acceptance';
  title: string;
  excerpt: string;
  version: string;
  revision?: string;
  decisionId?: string;
  object?: { id: string; version: number; label: string };
  choices?: GateChoice[];
  options?: GateOption[];
  acceptancePassed?: boolean;
  prompts?: Record<string, string>;
  /** The whole artifact, shown in the panel instead of a three-line excerpt. */
  body?: string;
  /** Structured content: deck pages, video scenes. */
  sections?: Array<{ title: string; text: string }>;
  /** A visual artifact the panel cannot show; the chat beside it can. */
  openHint?: string;
  /** Project files the host preview can show above the guide. */
  media?: GateMedia[];
};

export type WorkView = {
  kind: Kind;
  steps: Step[];
  gate: Gate | null;
  deliveredPath: string | null;
  deliveredMedia?: GateMedia;
  note: string | null;
};

export type WorkFiles = { state?: string | null; plan?: string | null; prompts?: string | null; directions?: string | null; artifact?: string | null; result?: string | null };
export type FileRequest = { plan?: string; prompts?: string; directions?: string; artifact?: string; result?: string };

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Row = { [key: string]: JsonValue };
type Choice = { styleId: string; level: number; paletteId: string };
type WebChoice = { directionId?: string; action?: 'accept' | 'rework' };

const steps = (labels: string[], current: number): Step[] =>
  labels.map((label, index) => ({ id: `${index}`, label, state: index < current ? 'done' : index === current ? 'now' : 'next' }));

// A row is a plain JSON object: arrays, primitives and foreign prototypes are
// not state, and the JSON model above already fixes what its values can be.
const isRow = (value: JsonValue | undefined): value is Row =>
  value !== null &&
  value !== undefined &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const isText = (value: JsonValue | undefined): value is string => String(value) === value;

const parse = (raw: string | null | undefined): Row | null => {
  if (!raw) return null;
  try {
    // SAFETY: JSON.parse only yields JSON values; isRow is the only way a value
    // leaves here, so every Row is a plain object of JsonValue fields.
    const value = JSON.parse(raw) as JsonValue;
    return isRow(value) ? value : null;
  } catch {
    return null;
  }
};

const record = (value: JsonValue | undefined): Row | null => (isRow(value) ? value : null);

const text = (value: JsonValue | undefined): string => (isText(value) ? value : '');

const DECK_STEPS: CreationMessageKey[] = ['stage.approach', 'stage.style', 'stage.sample', 'stage.deck', 'stage.delivery'];

const DECK_STAGE_INDEX = new Map<string, number>([
  ['planning', 0],
  ['plan-review', 1],
  ['sample-generation', 2],
  ['sample-review', 2],
  ['deck-generation', 3],
  ['deck-qa', 3],
  ['deck-review', 3],
  ['delivered', 4],
]);

const DOC_STEPS: CreationMessageKey[] = ['stage.intake', 'stage.approach', 'stage.outline', 'stage.chapters', 'stage.illustrations', 'stage.manuscript', 'stage.export'];
const DOC_STAGE_INDEX = new Map<string, number>([
  ['intake', 0],
  ['approach', 1],
  ['outline', 2],
  ['chapters', 3],
  ['illustrations', 4],
  ['manuscript', 5],
  ['delivery', 6],
]);
const DOC_GATE_LABEL = new Map<string, CreationMessageKey>([
  ['approach', 'gate.writingApproach'],
  ['outline', 'stage.outline'],
  ['chapter', 'gate.chapter'],
  ['figure_set', 'gate.figureSet'],
  ['figure', 'stage.illustrations'],
  ['layout', 'gate.layout'],
  ['manuscript', 'stage.manuscript'],
  ['delivery', 'stage.delivery'],
]);

// The engine resolves the named outline first, then any single object of that kind.
const outlineObject = (objects: Row): Row | null => {
  const named = record(objects.outline);
  if (named) return named;
  const candidates = Object.values(objects).map(record).filter((object): object is Row => text(object?.kind) === 'outline');
  return candidates.length === 1 ? candidates[0] : null;
};

const chapterOrder = (objects: Row): string[] => {
  const metadata = record(outlineObject(objects)?.metadata);
  const order = metadata?.chapter_order;
  return Array.isArray(order) ? order.map((id) => text(id)).filter(Boolean) : [];
};

// Outside chapter_order there is no position to report: this is not progress.
const chapterPosition = (objects: Row, activeId: string): { number: number; total: number } | null => {
  const order = chapterOrder(objects);
  const index = order.indexOf(activeId);
  if (index < 0) return null;
  return { number: index + 1, total: order.length };
};

const chapterLabel = (objects: Row, activeId: string, locale: string | undefined): string | null => {
  const t = translator(locale);
  const position = chapterPosition(objects, activeId);
  return position ? t('chapterPosition', { number: position.number, total: position.total }) : null;
};

const docExcerpt = (artifact: string | null | undefined): string =>
  text(artifact)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((line) => line.slice(0, 80))
    .join('\n');

const verifiedDelivery = (objects: Row): Row | null => {
  for (const entry of Object.values(objects)) {
    const object = record(entry);
    if (object && text(object.kind) === 'delivery' && text(object.status) === 'verified') return object;
  }
  return null;
};

const deckChoices = (plan: Row | null): GateChoice[] => {
  const styles = Array.isArray(plan?.styles) ? plan.styles : [];
  return styles.flatMap((entry) => {
    const style = record(entry);
    if (!style) return [];
    const tiers = Array.isArray(style.tiers) ? style.tiers : [];
    const palettes = Array.isArray(style.palettes) ? style.palettes : [];
    return [{
      styleId: text(style.id),
      styleName: text(style.name) || text(style.id),
      levels: tiers.map((tier) => Number(record(tier)?.level)).filter((level) => Number.isInteger(level)),
      palettes: palettes.flatMap((palette) => {
        const item = record(palette);
        return item ? [{ id: text(item.id), name: text(item.name) || text(item.id) }] : [];
      }),
    }];
  }).filter((choice) => choice.styleId && choice.levels.length > 0 && choice.palettes.length > 0);
};

const planSections = (plan: Row | null, locale: string | undefined): Array<{ title: string; text: string }> => {
  const t = translator(locale);
  const slides = Array.isArray(plan?.slides) ? plan.slides : [];
  return slides.flatMap((entry, index) => {
    const slide = record(entry);
    if (!slide) return [];
    const required = Array.isArray(slide.requiredText)
      ? slide.requiredText.map((line) => text(line)).filter(Boolean).join('\n')
      : '';
    const body = [text(slide.coreMessage), required].filter(Boolean).join('\n');
    return [{ title: text(slide.title) || t('pageNumber', { number: index + 1 }), text: body }];
  });
};

// A generation job's result names every page image it produced. A missing or
// unreadable result is no pictures, never a guess at a folder name.
const resultImages = (raw: string | null | undefined): string[] => {
  const result = parse(raw);
  const pages = Array.isArray(result?.pages) ? result.pages : [];
  return pages.flatMap((entry) => {
    const artifact = record(record(entry)?.artifact);
    const path = text(artifact?.path);
    return path ? [path] : [];
  });
};

const deckView = (stateRaw: string, files: WorkFiles, locale: string | undefined): WorkView | null => {
  const t = translator(locale);
  const state = parse(stateRaw);
  if (!state || state.schemaVersion !== 'superppt-task-vnext') return null;
  const stage = text(state.stage);
  const index = DECK_STAGE_INDEX.get(stage);
  if (index === undefined) return null;
  const plan = parse(files.plan);
  const promptsRecord = parse(files.prompts);
  const prompts: Record<string, string> = {};
  for (const [key, value] of Object.entries(promptsRecord ?? {})) {
    if (isText(value)) prompts[key] = value;
  }
  const decision = record(state.pendingDecision);
  // `pendingDecision.kind` is the stage awaiting a decision, not the action
  // (that is the `action` field of a submitted decision): only the stages the
  // panel can turn into a gate get one.
  const kind = text(decision?.kind);
  const delivery = record(state.delivery);
  let gate: Gate | null = null;

  const revision = text(state.contentRevision);
  const decisionId = text(decision?.id);
  const images = resultImages(files.result);
  if (kind === 'plan-review') {
    const choices = deckChoices(plan);
    // No readable plan means no styles: let the panel fall back instead of
    // offering a gate with "0 页" and nothing to pick.
    if (choices.length === 0) return null;
    const title = text(record(plan?.brief)?.title) || text(state.title);
    gate = {
      key: 'deck-style',
      title: t('gate.selectStyle'),
      excerpt: Array.isArray(plan?.slides)
        ? t('samplePlanSlides', { title, count: plan.slides.length })
        : t('samplePlan', { title }),
      version: t('planVersion', { revision, decisionId }),
      revision,
      decisionId,
      choices,
      prompts,
      sections: planSections(plan, locale),
    };
  } else if (kind === 'sample-review') {
    gate = {
      key: 'deck-sample',
      title: t('gate.sampleReview'),
      excerpt: t('gate.sampleExcerpt'),
      version: t('planVersion', { revision, decisionId }),
      revision,
      decisionId,
      media: images.slice(0, 1).map((path) => ({ kind: 'image' as const, label: t('stage.sample'), path })),
    };
    if (images.length === 0) gate.openHint = t('gate.sampleHint');
  } else if (kind === 'deck-review') {
    gate = {
      key: 'deck-deliver',
      title: t('confirmDelivery'),
      excerpt: text(record(state.currentDeck)?.relativePath) || t('gate.deckOpened'),
      version: t('planVersion', { revision, decisionId }),
      revision,
      decisionId,
      media: images.map((path, index) => ({ kind: 'image' as const, label: t('pageNumber', { number: index + 1 }), path })),
    };
    if (images.length === 0) gate.openHint = t('gate.deckHint');
  }

  return {
    kind: 'deck',
    steps: steps(DECK_STEPS.map((key) => t(key)), index),
    gate,
    deliveredPath: delivery ? text(delivery.relativePath) : null,
    note: null,
  };
};

const docView = (stateRaw: string, files: WorkFiles, locale: string | undefined): WorkView | null => {
  const t = translator(locale);
  const state = parse(stateRaw);
  if (!state || state.schema_version !== 2) return null;
  const objects = record(state.objects);
  if (!objects) return null;
  const stage = text(state.stage);
  const index = DOC_STAGE_INDEX.get(stage);
  if (index === undefined) return null;

  const activeId = text(state.active_object_id);
  const active = record(objects[activeId]);
  const revision = state.revision === undefined || state.revision === null ? '' : String(state.revision);
  const versionParts = (parts: Array<string | null>): string => parts.filter((part): part is string => Boolean(part)).join(' · ');
  const labels = DOC_STEPS.map((key) => t(key));
  const position = chapterPosition(objects, activeId);
  if (position) labels[3] = t('chapterNumber', { number: position.number });

  let gate: Gate | null = null;
  if (active && text(active.status) === 'pending_review') {
    const version = Number(active.version);
    const labelKey = DOC_GATE_LABEL.get(text(active.kind));
    const label = text(active.kind) === 'chapter'
      ? chapterLabel(objects, activeId, locale) ?? t('gate.chapter')
      : (labelKey ? t(labelKey) : undefined);
    if (label && Number.isInteger(version)) {
      gate = {
        key: 'doc-review',
        title: label,
        excerpt: docExcerpt(files.artifact),
        body: (files.artifact ?? '').trim(),
        version: versionParts([t('objectVersion', { version }), revision ? `revision ${revision}` : null]),
        revision: revision || undefined,
        decisionId: revision || undefined,
        object: { id: activeId, version, label },
      };
    }
  } else if (!active) {
    const labelKey = DOC_GATE_LABEL.get(stage);
    const label = labelKey ? t(labelKey) : undefined;
    if (label) {
      gate = {
        key: 'doc-review',
        title: label,
        excerpt: docExcerpt(files.artifact),
        body: (files.artifact ?? '').trim(),
        version: versionParts([revision ? `revision ${revision}` : null]),
        revision: revision || undefined,
        decisionId: revision || undefined,
      };
    }
  }

  const delivered = text(verifiedDelivery(objects)?.path);
  const view: WorkView = {
    kind: 'doc',
    steps: steps(labels, index),
    gate,
    deliveredPath: delivered || null,
    note: null,
  };
  if (delivered.toLowerCase().endsWith('.pdf')) {
    view.deliveredMedia = { kind: 'image', label: 'PDF', path: delivered };
  }
  return view;
};

const VIDEO_STEPS: CreationMessageKey[] = ['stage.brief', 'stage.script', 'stage.sampleVideo', 'stage.finalVideo', 'stage.delivery'];

const videoExcerpt = (scenes: Row[]): string =>
  scenes
    .slice(0, 2)
    .flatMap((scene) => (Array.isArray(scene.sentences) ? scene.sentences : []).map((sentence) => text(record(sentence)?.text)))
    .filter(Boolean)
    .join(' / ')
    .slice(0, 200);

// The engine treats "approval or waiver" as the same current authorization.
const approvedAt = (approvals: Row[], stage: string): Row[] =>
  approvals.filter((approval) =>
    text(approval.stage) === stage &&
    (text(approval.decision) === 'approved' || text(approval.decision) === 'waived'));

const approvalScope = (approval: Row): string[] =>
  Array.isArray(approval.scope) ? approval.scope.map((id) => text(id)).filter(Boolean) : [];

const videoView = (stateRaw: string, locale: string | undefined): WorkView | null => {
  const t = translator(locale);
  const state = parse(stateRaw);
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.scenes)) return null;
  const scenes = state.scenes.map((scene) => record(scene)).filter((scene): scene is Row => Boolean(scene));
  const approvals = (Array.isArray(state.approvals) ? state.approvals : [])
    .map((approval) => record(approval))
    .filter((approval): approval is Row => Boolean(approval));
  const revision = state.revision === undefined || state.revision === null ? '' : String(state.revision);
  const sceneIds = scenes.map((scene) => text(scene.id)).filter(Boolean);
  const excerpt = videoExcerpt(scenes);
  const jobs = (Array.isArray(state.jobs) ? state.jobs : [])
    .map((job) => record(job))
    .filter((job): job is Row => Boolean(job));

  const sceneSections = scenes.map((scene, index) => ({
    title: text(scene.title) || t('sceneNumber', { number: index + 1 }),
    text: (Array.isArray(scene.sentences) ? scene.sentences : [])
      .map((sentence) => text(record(sentence)?.text))
      .filter(Boolean)
      .join('\n'),
  }));
  // A render job writes manifest.json next to video.mp4. Only current,
  // succeeded jobs of the asked kind count; anything else is no preview.
  const renderVideo = (kind: 'sample' | 'full'): string => {
    for (let index = jobs.length - 1; index >= 0; index -= 1) {
      const job = jobs[index];
      if (text(job.kind) !== 'render' || text(job.state) !== 'succeeded') continue;
      if (text(record(job.request)?.kind) !== kind) continue;
      const manifest = text(job.manifestPath);
      if (manifest) return manifest.replace(/manifest\.json$/, 'video.mp4');
    }
    return '';
  };

  const gate = (key: 'video-script' | 'video-sample' | 'video-final', title: string, mediaPath = ''): Gate => {
    const result: Gate = {
      key,
      title,
      excerpt,
      version: revision ? `revision ${revision}` : t('gate.followChat'),
      revision: revision || undefined,
      decisionId: revision || undefined,
      object: { id: '', version: 0, label: title },
    };
    if (key === 'video-script') result.sections = sceneSections;
    if (mediaPath) {
      result.media = [{ kind: 'video', label: key === 'video-final' ? t('stage.finalVideo') : t('stage.sampleVideo'), path: mediaPath }];
    } else if (key !== 'video-script') {
      result.openHint = key === 'video-final' ? t('gate.videoHint') : t('gate.sampleVideoHint');
    }
    return result;
  };

  if (sceneIds.length === 0) {
    return { kind: 'video', steps: steps(VIDEO_STEPS.map((key) => t(key)), 0), gate: null, deliveredPath: null, note: null };
  }
  // Every current script approval covers its own scenes; the step is done when
  // their scopes together cover every scene, not when one approval covers all.
  const scriptScope = new Set(approvedAt(approvals, 'script').flatMap(approvalScope));
  const scriptApproved = sceneIds.every((id) => scriptScope.has(id));
  const sampleApproved = approvedAt(approvals, 'sample').length > 0;
  const final = approvedAt(approvals, 'final').find((approval) => Boolean(record(approval.target)));

  if (final) {
    const target = record(final.target);
    const manifest = text(target?.manifestPath);
    const video = manifest ? manifest.replace(/manifest\.json$/, 'video.mp4') : '';
    const view: WorkView = {
      kind: 'video',
      steps: steps(VIDEO_STEPS.map((key) => t(key)), 4),
      gate: null,
      deliveredPath: manifest || null,
      note: null,
    };
    if (video) view.deliveredMedia = { kind: 'video', label: t('stage.finalVideo'), path: video };
    return view;
  }
  if (sampleApproved) {
    return { kind: 'video', steps: steps(VIDEO_STEPS.map((key) => t(key)), 3), gate: gate('video-final', t('stage.finalVideo'), renderVideo('full')), deliveredPath: null, note: null };
  }
  if (scriptApproved) {
    return { kind: 'video', steps: steps(VIDEO_STEPS.map((key) => t(key)), 2), gate: gate('video-sample', t('stage.sampleVideo'), renderVideo('sample')), deliveredPath: null, note: null };
  }
  return { kind: 'video', steps: steps(VIDEO_STEPS.map((key) => t(key)), 1), gate: gate('video-script', t('stage.script')), deliveredPath: null, note: null };
};


const WEB_STEPS: CreationMessageKey[] = ['stage.intake', 'stage.direction', 'stage.sample', 'stage.fullPage', 'stage.acceptance', 'stage.delivery'];
const WEB_STAGE_INDEX = new Map<string, number>([
  ['brief', 0],
  ['direction', 1],
  ['sample', 2],
  ['full', 3],
  ['acceptance', 4],
  ['delivered', 5],
]);

const webDirectionOptions = (raw: string | null | undefined): GateOption[] => {
  const options: GateOption[] = [];
  let current: GateOption | null = null;
  for (const line of text(raw).replace(/\r/g, '').split('\n')) {
    const heading = line.match(/^##\s+\d+\.\s+([a-z0-9-]+)\s+—\s+(.+?)\s*$/);
    if (heading) {
      current = { id: heading[1]!, name: heading[2]! };
      options.push(current);
      continue;
    }
    if (line.startsWith('## ')) {
      current = null;
      continue;
    }
    const concept = current ? line.match(/^- 概念：(.+)$/) : null;
    if (concept && current) current.detail = concept[1]!;
  }
  return options;
};

const pageView = (stateRaw: string, files: WorkFiles, locale: string | undefined): WorkView | null => {
  const t = translator(locale);
  const state = parse(stateRaw);
  if (!state || state.version !== 1) return null;
  const stage = text(state.stage);
  const index = WEB_STAGE_INDEX.get(stage);
  if (index === undefined) return null;
  const revision = state.stageRevision === undefined || state.stageRevision === null ? '' : String(state.stageRevision);
  const artifacts = record(state.artifacts);
  const acceptance = record(state.acceptance);
  const decisionId = revision ? `web-${stage}-${revision}` : undefined;
  const version = revision ? `revision ${revision}` : t('gate.followChat');
  const samplePath = text(artifacts?.sample) || '预览/v0.html';
  const previewPath = text(artifacts?.preview) || '预览/index.html';
  const screenshots = Array.isArray(acceptance?.screenshots)
    ? acceptance.screenshots.map((entry) => text(entry)).filter(Boolean)
    : [];
  let gate: Gate | null = null;

  if (stage === 'direction') {
    gate = {
      key: 'web-direction',
      title: t('gate.selectDirection'),
      excerpt: t('gate.directionExcerpt'),
      version,
      revision: revision || undefined,
      decisionId,
      options: webDirectionOptions(files.directions),
      openHint: t('gate.directionHint'),
    };
  } else if (stage === 'sample') {
    gate = {
      key: 'web-sample',
      title: t('stage.sample'),
      excerpt: t('gate.pageSampleExcerpt'),
      version,
      revision: revision || undefined,
      decisionId,
      media: [{ kind: 'html', label: t('stage.sample'), path: samplePath }],
      openHint: t('gate.pageSampleHint'),
    };
  } else if (stage === 'full') {
    gate = {
      key: 'web-full',
      title: t('stage.fullPage'),
      excerpt: t('gate.pageFullExcerpt'),
      version,
      revision: revision || undefined,
      media: [{ kind: 'html', label: t('stage.fullPage'), path: previewPath }],
      openHint: t('gate.pageFullHint'),
    };
  } else if (stage === 'acceptance') {
    const issueCount = Number.isFinite(Number(acceptance?.issueCount)) ? Number(acceptance?.issueCount) : 0;
    gate = {
      key: 'web-acceptance',
      title: t('gate.browserChecks'),
      excerpt: acceptance?.passed === true
        ? t('gate.checksPassed')
        : t('issues', { count: issueCount }),
      version,
      revision: revision || undefined,
      decisionId,
      acceptancePassed: acceptance?.passed === true,
      options: [
        { id: 'accept', name: t('acceptDeliver') },
        { id: 'rework', name: t('rework') },
      ],
      media: screenshots.map((path, index) => ({ kind: 'image' as const, label: [t('media.desktop'), t('media.tablet'), t('media.phone')][index] ?? t('screenshotNumber', { number: index + 1 }), path })),
      openHint: t('gate.checksHint'),
    };
  }

  return {
    kind: 'page',
    steps: steps(WEB_STEPS.map((key) => t(key)), index),
    gate,
    deliveredPath: stage === 'delivered' ? '交付/index.html' : null,
    deliveredMedia: stage === 'delivered' ? { kind: 'html', label: t('media.page'), path: '交付/index.html' } : undefined,
    note: null,
  };
};

export const workFilePaths = (kind: Kind, stateRaw: string): FileRequest => {
  const state = parse(stateRaw);
  if (!state) return {};
  const request: FileRequest = {};
  if (kind === 'deck') {
    const plan = text(state.planPath);
    if (plan) request.plan = plan;
    const revision = text(state.contentRevision);
    if (revision) request.prompts = `planning/${revision}/sample-prompts.json`;
    const job = text(state.activeJobId);
    if (job) request.result = `generation/${job}/result.json`;
    return request;
  }
  if (kind === 'doc') {
    const objects = record(state.objects);
    const artifact = text(record(objects?.[text(state.active_object_id)])?.path);
    if (artifact) request.artifact = artifact;
  }
  if (kind === 'page') {
    const artifacts = record(state.artifacts);
    const directions = text(artifacts?.directions);
    if (directions) request.directions = directions;
  }
  return request;
};

export const readWorkView = (kind: Kind, files: WorkFiles, locale = 'zh-CN'): WorkView | null => {
  if (kind === 'deck') return deckView(files.state ?? '', files, locale);
  if (kind === 'doc') return docView(files.state ?? '', files, locale);
  if (kind === 'video') return videoView(files.state ?? '', locale);
  if (kind === 'page') return pageView(files.state ?? '', files, locale);
  return null;
};

export const confirmMessage = (kind: Kind, gate: Gate, choice?: Choice | WebChoice, locale = 'zh-CN'): string | null => {
  const t = translator(locale);
  if (kind === 'doc') {
    if (!gate.object || !gate.revision) return null;
    if (creationLocale(locale) === 'en') return t('prompt.approveDocument', { label: gate.object.label, id: gate.object.id, version: gate.object.version, revision: gate.revision });
    return `确认${gate.object.label}（对象 ${gate.object.id}，版本 ${gate.object.version}，revision ${gate.revision}），按 SuperWriter 流程记录批准。`;
  }
  if (kind === 'video') {
    if (!gate.object || !gate.revision) return null;
    if (creationLocale(locale) === 'en') return t('prompt.approveVideo', { label: gate.object.label, revision: gate.revision });
    return `确认当前${gate.object.label}（revision ${gate.revision}），按 SuperVideo 流程记录批准。`;
  }
  if (kind === 'page') {
    if (!gate.revision || !gate.decisionId) return null;
    const revision = gate.revision;
    const decisionId = gate.decisionId;
    if (gate.key === 'web-direction') {
      const directionId = choice && 'directionId' in choice ? choice.directionId : undefined;
      if (!directionId || !gate.options?.some((option) => option.id === directionId)) return null;
      if (creationLocale(locale) === 'en') return t('prompt.webDirection', { directionId, revision, decisionId });
      return `方向：${directionId}；revision ${revision}；决定编号 ${decisionId}；请按 SuperWeb 流程运行 superweb decide --gate direction --choice ${directionId} --revision ${revision} --decision-id ${decisionId}。`;
    }
    if (gate.key === 'web-sample') {
      if (creationLocale(locale) === 'en') return t('prompt.webSample', { revision, decisionId });
      return `确认样页；revision ${revision}；决定编号 ${decisionId}；请按 SuperWeb 流程运行 superweb decide --gate sample --choice accept --revision ${revision} --decision-id ${decisionId}。`;
    }
    if (gate.key === 'web-acceptance') {
      const action = choice && 'action' in choice ? choice.action : 'accept';
      if (action === 'rework') {
        if (creationLocale(locale) === 'en') return t('prompt.webRework', { revision, decisionId });
        return `返工；revision ${revision}；决定编号 ${decisionId}；请按 SuperWeb 流程运行 superweb decide --gate acceptance --choice rework --target full --revision ${revision} --decision-id ${decisionId}。`;
      }
      if (creationLocale(locale) === 'en') return t(gate.acceptancePassed === false ? 'prompt.webAcceptIssues' : 'prompt.webAccept', { revision, decisionId });
      const acknowledge = gate.acceptancePassed === false ? ' --acknowledge-issues' : '';
      return `接受验收并交付；revision ${revision}；决定编号 ${decisionId}；请按 SuperWeb 流程运行 superweb decide --gate acceptance --choice accept --revision ${revision} --decision-id ${decisionId}${acknowledge}。`;
    }
    return null;
  }
  if (kind !== 'deck') return null;
  if (!gate.revision || !gate.decisionId) return null;
  if (gate.key === 'deck-style') {
    if (!choice) return null;
    const key = `${choice.styleId}/${choice.level}/${choice.paletteId}`;
    if (!gate.prompts?.[key]) return null;
    const style = gate.choices?.find((entry) => entry.styleId === choice.styleId);
    const palette = style?.palettes.find((entry) => entry.id === choice.paletteId);
    if (!style || !palette) return null;
    if (creationLocale(locale) === 'en') return t('prompt.deckStyle', { revision: gate.revision, decisionId: gate.decisionId, styleName: style.styleName, level: choice.level, paletteName: palette.name, key });
    return `方案版本：${gate.revision}；决定编号：${gate.decisionId}；选择${style.styleName}，${choice.level} 档，${palette.name}（${key}）；授权新增生图调用：1 次。`;
  }
  if (gate.key === 'deck-sample') {
    if (creationLocale(locale) === 'en') return t('prompt.deckSample', { revision: gate.revision, decisionId: gate.decisionId });
    return `方案版本：${gate.revision}；决定编号：${gate.decisionId}；确认样页，生成整套。`;
  }
  if (gate.key === 'deck-deliver') {
    if (creationLocale(locale) === 'en') return t('prompt.deckDeliver', { revision: gate.revision, decisionId: gate.decisionId });
    return `方案版本：${gate.revision}；决定编号：${gate.decisionId}；确认交付当前完整 PPTX。`;
  }
  return null;
};
