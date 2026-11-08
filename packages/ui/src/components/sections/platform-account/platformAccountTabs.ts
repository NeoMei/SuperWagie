import { create } from 'zustand';

type PlatformAccountTab = 'profile' | 'billing' | 'usage' | 'orders' | 'keys';

export const usePlatformAccountTabStore = create<{
  tab: PlatformAccountTab;
  rechargeTarget: 'superwagie' | 'llmrouter' | null;
  purchaseTarget: 'membership' | 'addon' | 'funding' | null;
  setTab: (tab: PlatformAccountTab) => void;
  clearRechargeTarget: () => void;
  clearPurchaseTarget: () => void;
}>((set) => ({ tab: 'billing', rechargeTarget: null, purchaseTarget: null, setTab: (tab) => set({ tab, rechargeTarget: null, purchaseTarget: null }), clearRechargeTarget: () => set({ rechargeTarget: null }), clearPurchaseTarget: () => set({ purchaseTarget: null }) }));

export const preparePlatformAccountTarget = (id: string): void => {
  if (id === 'platform-account.recharge' || id === 'platform-account.model-recharge') {
    usePlatformAccountTabStore.setState({ tab: 'billing', purchaseTarget: null, rechargeTarget: id === 'platform-account.model-recharge' ? 'llmrouter' : 'superwagie' });
  }
  if (id === 'platform-account.membership' || id === 'platform-account.addon' || id === 'platform-account.funding') {
    usePlatformAccountTabStore.setState({ tab: 'billing', rechargeTarget: null, purchaseTarget: id === 'platform-account.membership' ? 'membership' : id === 'platform-account.addon' ? 'addon' : 'funding' });
  }
  if (['platform-account.profile', 'platform-account.avatar', 'platform-account.password'].includes(id)) {
    usePlatformAccountTabStore.getState().setTab('profile');
  }
};
