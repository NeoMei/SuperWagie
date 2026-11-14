/** Keeps pending-page state, UI events and notifications on one lifecycle. */
export const createPageWaitChangeHandler = ({ sessionRuntime, broadcastOpenChamberUiEvent, maybeSendPushForTrigger }) => (change) => {
  sessionRuntime.trackWaitingPage(change);
  const payload = change.type === 'waiting'
    ? {
      type: 'openchamber:page-waiting',
      properties: { sessionID: change.sessionId, directory: change.directory, page: { id: change.callId, title: change.title } },
    }
    : {
      type: 'openchamber:page-settled',
      properties: { sessionID: change.sessionId, directory: change.directory, pageID: change.callId },
    };
  broadcastOpenChamberUiEvent(payload);
  void maybeSendPushForTrigger(payload);
};
