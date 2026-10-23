import { create } from 'zustand';
import type { ModelPurposeId } from './modelConfigurationView';

type ModelConfigurationTab = 'overview' | 'purposes' | 'connections' | 'coverage';

export const useModelConfigurationTabStore = create<{
  tab: ModelConfigurationTab;
  purpose: ModelPurposeId;
  setTab: (tab: ModelConfigurationTab) => void;
  setPurpose: (purpose: ModelPurposeId) => void;
}>((set) => ({
  tab: 'overview',
  purpose: 'agent',
  setTab: (tab) => set({ tab }),
  setPurpose: (purpose) => set({ purpose }),
}));

export function prepareModelConfigurationTarget(id: string): void {
  const store = useModelConfigurationTabStore.getState();
  if (id === 'models.overview') {
    store.setTab('overview');
    return;
  }
  if (id === 'models.connections') {
    store.setTab('connections');
    return;
  }
  if (id === 'models.coverage') {
    store.setTab('coverage');
    return;
  }
  const purposeTargets = new Map<string, ModelPurposeId>([
    ['sessions.default-model', 'agent'],
    ['sessions.default-thinking', 'agent'],
    ['sessions.small-model', 'auxiliary'],
    ['sessions.walkthrough-model', 'auxiliary'],
    ['models.agent', 'agent'], ['models.auxiliary', 'auxiliary'],
    ['models.ocr', 'ocr'], ['models.vision', 'vision'],
    ['models.embedding', 'embedding'], ['models.rerank', 'rerank'],
    ['models.stt-short', 'stt-short'], ['models.stt-realtime', 'stt-realtime'],
    ['models.stt-file', 'stt-file'], ['models.tts', 'tts'],
    ['models.image-generation', 'image-generation'], ['models.image-editing', 'image-editing'],
    ['models.routing', 'routing'], ['models.multimodal-embedding', 'multimodal-embedding'],
    ['models.video-generation', 'video-generation'],
  ]);
  const purpose = purposeTargets.get(id);
  if (purpose) {
    store.setTab('purposes');
    store.setPurpose(purpose);
  }
}
