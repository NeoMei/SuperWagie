const params = new URLSearchParams(location.search);
const surfaceType = params.get('type');
const surfaceIdentity = params.get('identity');
window.__initialDomainState = localStorage.getItem('domain-state');
window.__initialCookie = document.cookie;
localStorage.setItem('domain-state', surfaceIdentity);
document.cookie = `surface=${encodeURIComponent(surfaceIdentity)}; SameSite=Strict; Secure`;
window.__coreStatusHistory = ['connected'];
window.__setCoreStatus = (status) => window.__coreStatusHistory.push(status);

window.__surfaceProbe = async () => ({
  type: surfaceType,
  identity: surfaceIdentity,
  initialDomainState: window.__initialDomainState,
  currentDomainState: localStorage.getItem('domain-state'),
  initialCookie: window.__initialCookie,
  currentCookie: document.cookie,
  hasNodeProcess: typeof window.process !== 'undefined',
  hasRequire: typeof window.require !== 'undefined',
  hasRawIpc: typeof window.ipcRenderer !== 'undefined',
  bridge: await window.superwagie.probe(),
});

window.__attemptWindowOpen = () => window.open('https://example.invalid/', '_blank') === null;
window.__attemptNavigation = () => {
  location.href = 'https://example.invalid/navigation';
  return true;
};
window.__permissionState = async () => (await navigator.permissions.query({ name: 'geolocation' })).state;
window.__attemptDownload = () => {
  const link = document.createElement('a');
  link.download = 'forbidden.txt';
  link.href = 'data:text/plain,forbidden';
  document.body.append(link);
  link.click();
  link.remove();
  return true;
};
window.__attemptRemoteFetch = async () => {
  try {
    await fetch('https://example.invalid/forbidden');
    return 'unexpected-success';
  } catch {
    return 'blocked';
  }
};
