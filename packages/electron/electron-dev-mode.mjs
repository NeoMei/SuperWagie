export const resolveElectronDevMode = (env = {}) => {
  const requestedBundledUi = env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI === '1';
  const requestedHmr = env.OPENCHAMBER_ELECTRON_AUTO_START_HMR === '1';
  const startHmr = requestedHmr && !requestedBundledUi;

  return {
    startHmr,
    useBundledUi: requestedBundledUi || !startHmr,
  };
};
