/** Pin the original host connection authority, then ask its owning runtime at each use. */
export const captureMobileOfficialTransport = async (req, { tunnelAuthController, getUiAuthController }) => {
  const uiAuthController = getUiAuthController();
  const scope = tunnelAuthController.classifyRequestScope(req);
  const tunneled = scope === 'tunnel' || scope === 'unknown-public';
  const tunnelSession = tunneled ? tunnelAuthController.getTunnelSessionFromRequest(req) : null;
  if (tunneled ? !tunnelSession : !await uiAuthController?.hasRuntimeAccess(req)) return null;
  if (tunneled) {
    if (!tunnelSession) return null;
    const sessionId = tunnelSession.sessionId;
    return async () => tunnelAuthController.getTunnelSessionFromRequest(req)?.sessionId === sessionId;
  }
  return async () => getUiAuthController() === uiAuthController
    && tunnelAuthController.classifyRequestScope(req) === scope
    && await uiAuthController.hasRuntimeAccess(req);
};
