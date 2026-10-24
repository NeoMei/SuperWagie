import { creationText, type CreationMessageKey } from './i18n.ts';
import {
  type Answers,
  type Kind,
} from './wizard.ts';

/** The whole skill, in the order the guide walks it. The first stage is intake. */
export const flowStages = (kind: Kind, locale: string | undefined): readonly string[] => {
  const t = (key: CreationMessageKey): string => creationText(locale, key);
  return {
  doc: [t('stage.intake'), t('stage.approach'), t('stage.outline'), t('stage.chapters'), t('stage.illustrations'), t('stage.manuscript'), t('stage.export')],
  deck: [t('stage.intake'), t('stage.contentPlan'), t('stage.style'), t('stage.sample'), t('stage.deck'), t('stage.delivery')],
  video: [t('stage.intake'), t('stage.brief'), t('stage.script'), t('stage.sampleVideo'), t('stage.finalVideo'), t('stage.delivery')],
  page: [t('stage.intake'), t('stage.direction'), t('stage.sample'), t('stage.fullPage'), t('stage.acceptance'), t('stage.delivery')],
  }[kind];
};

export type IntakeFieldID =
  | 'content'
  | 'audience'
  | 'docType'
  | 'length'
  | 'materials'
  | 'occasion'
  | 'pages'
  | 'outcome'
  | 'mode'
  | 'webGoal'
  | 'references';

export type IntakeField = {
  id: IntakeFieldID;
  label: string;
  hint?: string;
  kind: 'text' | 'long' | 'choice';
  options?: readonly { value: string; label: string }[];
  optional?: boolean;
};

const base = (kind: IntakeField['kind'], id: IntakeFieldID, label: string, hint?: string): IntakeField => {
  const field: IntakeField = { id, label, kind };
  if (hint) field.hint = hint;
  return field;
};

/** What this kind must know before its first skill stage can start. */
export const intakeFields = (kind: Kind, locale: string | undefined): readonly IntakeField[] => {
  const t = (key: CreationMessageKey): string => creationText(locale, key);
  const options = (pairs: readonly (readonly [string, CreationMessageKey])[]) => pairs.map(([value, key]) => ({ value, label: t(key) }));
  const audiences = options([['自己', 'option.self'], ['同事', 'option.colleagues'], ['客户', 'option.clients'], ['学生', 'option.students'], ['其他', 'option.other']]);
  return ({
  doc: [
    base('long', 'content', t('intake.docContent'), t('intake.pasteContent')),
    { ...base('choice', 'docType', t('intake.docType')), options: options([['标书', 'option.bid'], ['方案', 'option.proposal'], ['报告', 'option.report'], ['白皮书', 'option.whitepaper'], ['其他', 'option.other']]) },
    base('long', 'materials', t('intake.docMaterials'), t('intake.materialHint')),
    { ...base('choice', 'audience', t('intake.audience')), options: audiences },
    base('text', 'length', t('intake.length'), t('intake.lengthHint')),
  ],
  deck: [
    base('long', 'content', t('intake.deckContent'), t('intake.pasteContent')),
    { ...base('choice', 'audience', t('intake.audience')), options: audiences },
    base('text', 'occasion', t('intake.occasion'), t('intake.occasionHint')),
    base('text', 'pages', t('intake.pages'), t('intake.pagesHint')),
  ],
  video: [
    base('long', 'content', t('intake.videoContent'), t('intake.videoContentHint')),
    { ...base('choice', 'audience', t('intake.audience')), options: audiences },
    base('long', 'outcome', t('intake.outcome')),
    { ...base('choice', 'mode', t('intake.mode')), options: options([['讲解片', 'option.explainer'], ['绘本', 'option.storybook'], ['教程', 'option.tutorial'], ['其他', 'option.other']]) },
  ],
  page: [
    base('long', 'content', t('intake.pageContent'), t('intake.pageContentHint')),
    { ...base('choice', 'audience', t('intake.audience')), options: audiences },
    base('long', 'webGoal', t('intake.webGoal'), t('intake.webGoalHint')),
    { ...base('long', 'materials', t('intake.webMaterials'), t('intake.webMaterialsHint')), optional: true },
    base('text', 'references', t('intake.references'), t('intake.referencesHint')),
  ],
  } satisfies Record<Kind, readonly IntakeField[]>)[kind];
};

const filled = (value: string): boolean => value.trim().length >= 2;

/** Everything required for this kind's intake is present. */
export const canStart = (kind: Kind, answers: Answers): boolean => {
  if (!filled(answers.content) || !answers.audience.trim()) return false;
  if (kind === 'doc') return Boolean(answers.docType);
  if (kind === 'deck') return filled(answers.occasion);
  if (kind === 'video') return filled(answers.outcome) && Boolean(answers.mode);
  return filled(answers.webGoal);
};
