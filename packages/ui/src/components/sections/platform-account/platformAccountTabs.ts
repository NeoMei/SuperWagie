import { create } from 'zustand';

type PlatformAccountTab = 'profile' | 'billing' | 'usage';

export const usePlatformAccountTabStore = create<{
  tab: PlatformAccountTab;
  rechargeTarget: 'superwagie' | 'llmrouter' | null;
  setTab: (tab: PlatformAccountTab) => void;
  clearRechargeTarget: () => void;
}>((set) => ({ tab: 'billing', rechargeTarget: null, setTab: (tab) => set({ tab, rechargeTarget: null }), clearRechargeTarget: () => set({ rechargeTarget: null }) }));

export const preparePlatformAccountTarget = (id: string): void => {
  if (id === 'platform-account.recharge' || id === 'platform-account.model-recharge') {
    usePlatformAccountTabStore.setState({ tab: 'billing', rechargeTarget: id === 'platform-account.model-recharge' ? 'llmrouter' : 'superwagie' });
  }
  if (['platform-account.profile', 'platform-account.avatar', 'platform-account.password'].includes(id)) {
    usePlatformAccountTabStore.getState().setTab('profile');
  }
};
