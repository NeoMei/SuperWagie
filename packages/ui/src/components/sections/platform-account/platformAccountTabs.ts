import { create } from 'zustand';

type PlatformAccountTab = 'profile' | 'billing' | 'usage';

export const usePlatformAccountTabStore = create<{
  tab: PlatformAccountTab;
  setTab: (tab: PlatformAccountTab) => void;
}>((set) => ({ tab: 'profile', setTab: (tab) => set({ tab }) }));

export const preparePlatformAccountTarget = (id: string): void => {
  if (['platform-account.profile', 'platform-account.avatar', 'platform-account.password'].includes(id)) {
    usePlatformAccountTabStore.getState().setTab('profile');
  }
};
