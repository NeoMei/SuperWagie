import { create } from 'zustand';

type PlatformAccountTab = 'profile' | 'billing' | 'usage' | 'orders' | 'keys';

export const usePlatformAccountTabStore = create<{
  tab: PlatformAccountTab;
  purchaseTarget: 'membership' | 'addon' | 'funding' | null;
  setTab: (tab: PlatformAccountTab) => void;
  clearPurchaseTarget: () => void;
}>((set) => ({ tab: 'billing', purchaseTarget: null, setTab: (tab) => set({ tab, purchaseTarget: null }), clearPurchaseTarget: () => set({ purchaseTarget: null }) }));

export const preparePlatformAccountTarget = (id: string): void => {
  if (id === 'platform-account.recharge' || id === 'platform-account.model-recharge') {
    usePlatformAccountTabStore.setState({ tab: 'billing', purchaseTarget: 'addon' });
  }
  if (id === 'platform-account.membership' || id === 'platform-account.addon' || id === 'platform-account.funding') {
    usePlatformAccountTabStore.setState({ tab: 'billing', purchaseTarget: id === 'platform-account.membership' ? 'membership' : id === 'platform-account.addon' ? 'addon' : 'funding' });
  }
  if (['platform-account.profile', 'platform-account.avatar', 'platform-account.password'].includes(id)) {
    usePlatformAccountTabStore.getState().setTab('profile');
  }
};
