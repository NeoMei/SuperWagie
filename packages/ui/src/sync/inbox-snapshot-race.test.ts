import { expect, test } from 'bun:test'
import { getRuntimeKey } from '@/lib/runtime-switch'
import type { SyntheticMessage } from '@/lib/opencode/model'
import { ChildStoreManager } from './child-store'
import { SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader'
import type { PendingInboxMessage } from '@/lib/opencode/client'
import { createEventRoutingIndex, handleEvent } from './sync-context'

for (const action of ['cancelled', 'delivered'] as const) {
  test(`a ${action} event beats an older pending inbox snapshot`, async () => {
    const target = { directory: '/inbox-race', sessionID: 'ses_race' }
    const info: SyntheticMessage = { id: 'inbox_1', sessionID: target.sessionID, role: 'synthetic', text: 'result', time: { created: 1 }, pending: true }
    let resolveInbox!: (items: readonly PendingInboxMessage[]) => void
    let started!: () => void
    const reading = new Promise<void>((resolve) => { started = resolve })
    const childStores = new ChildStoreManager()
    const loader = new SessionMessageLoader(childStores, { runtimeKey: getRuntimeKey(), sdk: {
      getSessionMessages: async () => ({ items: [], cursor: {} }),
      getSessionInbox: () => { started(); return new Promise((resolve) => { resolveInbox = resolve }) },
    } })
    loader.initializeCreatedSession(target)
    const store = childStores.ensureChild(target.directory, { bootstrap: false })
    setImperativeSessionMessageLoader(loader)
    try {
      const refresh = loader.refreshTail(target, 100)
      await reading
      const event = action === 'cancelled'
        ? { type: 'message.removed' as const, properties: { sessionID: target.sessionID, messageID: info.id } }
        : { type: 'message.patched' as const, properties: { sessionID: target.sessionID, messageID: info.id, patch: { time: { created: 9 } } } }
      handleEvent(target.directory, event, childStores, createEventRoutingIndex(), getRuntimeKey())
      const newer: SyntheticMessage = { ...info, id: 'inbox_2', text: 'new', time: { created: 3 } }
      handleEvent(target.directory, { type: 'message.updated', properties: { info: newer } }, childStores, createEventRoutingIndex(), getRuntimeKey())
      resolveInbox([{ info, parts: null }])
      await refresh
      const messages = store.getState().message[target.sessionID] ?? []
      if (action === 'cancelled') expect(messages).toEqual([newer])
      else expect(messages).toEqual([newer, { id: info.id, sessionID: info.sessionID, role: 'synthetic', text: info.text, time: { created: 9 } }])
    } finally {
      setImperativeSessionMessageLoader(null)
      loader.dispose()
      childStores.disposeAll()
    }
  })
}
