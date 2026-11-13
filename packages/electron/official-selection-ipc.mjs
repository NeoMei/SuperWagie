import { z } from 'zod';

const operation = z.object({ operationId: z.string().uuid(), apiBaseUrl: z.string().min(1).max(2048), accountToken: z.string().min(1).max(512).optional() });
const selectRequest = operation.extend({ input: z.unknown() }).strict();
const revokeRequest = operation.extend({ id: z.string().uuid() }).strict();
const cancelRequest = z.object({ operationId: z.string().uuid() }).strict();
const refuse = () => { throw new Error('mobile_local_desktop_required'); };

/** Only the native top frame receives this in-process capability. No HTTP token can acquire it. */
export const createOfficialSelectionIpc = ({ isFrameAllowed, isLocalTarget, getController, resolveAuthentication }) => {
  const pending = new Map();
  return async (event, command, value) => {
    if (!isFrameAllowed(event)) refuse();
    const frame = event.senderFrame;
    if (command === 'desktop_official_selection_cancel') {
      const { operationId } = cancelRequest.parse(value);
      if (pending.get(operationId)?.frame === frame) pending.delete(operationId);
      return null;
    }
    const input = (command === 'desktop_official_select' || command === 'desktop_creation_approval' ? selectRequest : revokeRequest).parse(value);
    if (!isLocalTarget(input.apiBaseUrl) || pending.has(input.operationId)) refuse();
    const controller = getController();
    if (!controller) refuse();
    const lease = { frame };
    pending.set(input.operationId, lease);
    const isCurrent = () => pending.get(input.operationId) === lease && isFrameAllowed(event)
      && isLocalTarget(input.apiBaseUrl) && getController() === controller;
    try {
      const authentication = await resolveAuthentication(event, input.accountToken);
      if (!isCurrent()) refuse();
      if (command === 'desktop_creation_approval') {
        const result = await controller.creationApproval({ authentication, input: input.input, isCurrent });
        if (!isCurrent()) refuse();
        return result;
      }
      return command === 'desktop_official_select'
        ? await controller.select({ authentication, input: input.input, isCurrent })
        : await controller.revoke({ authentication, id: input.id, isCurrent });
    } finally { if (pending.get(input.operationId) === lease) pending.delete(input.operationId); }
  };
};
