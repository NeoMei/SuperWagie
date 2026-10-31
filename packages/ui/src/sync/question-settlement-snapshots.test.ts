import { expect, test } from 'bun:test'
import type { MessagePage } from '@/lib/opencode/client'
import type { FormRequest, Message, Part, ToolPart } from '@/lib/opencode/model'
import { ChildStoreManager } from './child-store'
import { SessionMessageLoader } from './session-message-loader'
import { applyRecoverableQuestionEvents, deriveRecoveredQuestions, noteQuestionFormSnapshot, resetRecoverableQuestions, useRecoverableQuestionsStore } from './recoverable-questions'

const sessionID = 'settled-session'
const directory = '/settled-question'
const messageID = 'msg_0000_a'
const partID = 'question-tool'
const form: FormRequest = {
  id: 'settled-form', sessionID, title: 'Question', fields: [{ key: 'q', type: 'string' }],
  metadata: { kind: 'question', tool: { messageID, id: partID } },
}
const interrupted = () => {
  noteQuestionFormSnapshot(directory, [form])
  applyRecoverableQuestionEvents(directory, [{ type: 'message.tool.transition', properties: {
    sessionID, messageID, partID,
    transition: { kind: 'failed', error: 'Tool execution interrupted', errorType: 'aborted', executed: false, end: 3 },
  } }])
}
const page = (state: ToolPart['state']): MessagePage => {
  const items: Array<{ info: Message; parts: Part[] }> = []
  for (let index = 0; index < 25; index += 1) {
    const id = String(index).padStart(4, '0')
    items.push({ info: { id: `msg_${id}_u`, sessionID, role: 'user', time: { created: index * 2 + 1 } }, parts: [] })
    items.push({ info: { id: `msg_${id}_a`, sessionID, role: 'assistant', time: { created: index * 2 + 2, completed: index * 2 + 3 }, providerID: 'p', modelID: 'm', agent: 'build' }, parts: [] })
  }
  items[1].parts = [{ id: partID, sessionID, messageID, type: 'tool', tool: 'question', callID: partID, state }]
  return { items, cursor: {} }
}
const terminalStates: ToolPart['state'][] = [
  { status: 'completed', input: {}, output: 'answered', time: { start: 2, end: 3 } },
  { status: 'error', input: {}, error: 'form cancelled', errorType: 'tool.execution', time: { start: 2, end: 3 } },
  { status: 'error', input: {}, error: 'Interaction cancelled because the location shut down', errorType: 'aborted', time: { start: 2, end: 3 } },
]
for (const [index, terminal] of terminalStates.entries()) {
  test(`authoritative terminal state ${index} remains settled after trim and eviction`, async () => {
    resetRecoverableQuestions()
    interrupted()
    const stores = new ChildStoreManager()
    const loader = new SessionMessageLoader(stores, { sdk: { getSessionMessages: async () => page(terminal) }, runtimeKey: 'question-runtime' })
    const target = { directory, sessionID }
    try {
      await loader.ensure(target, { reason: 'navigation' })
      const store = stores.getChild(directory)!
      const recovered = () => deriveRecoveredQuestions(store.getState(), useRecoverableQuestionsStore.getState(), new Set([sessionID]))
      expect(recovered()).toEqual([])
      expect(loader.trimHistory(target)).toBe(true)
      expect(store.getState().part[messageID]).toBeUndefined()
      expect(recovered()).toEqual([])
      const released = loader.startCacheRetention({ idleTtlMs: 0, isCurrent: () => true, isViewed: () => false, isActive: () => false, releaseDerivedCache: () => {} })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(store.getState().message[sessionID]).toBeUndefined()
      expect(recovered()).toEqual([])
      released()
    } finally { loader.dispose(); stores.disposeAll(); resetRecoverableQuestions() }
  })
}

test('a retired runtime snapshot cannot settle a same-id question after reset and runtime round trip', async () => {
  resetRecoverableQuestions()
  interrupted()
  let resolvePage!: (value: MessagePage) => void
  const response = new Promise<MessagePage>((resolve) => { resolvePage = resolve })
  const stores = new ChildStoreManager()
  const sdk = { getSessionMessages: async () => response }
  const loader = new SessionMessageLoader(stores, { sdk, runtimeKey: 'runtime-a' })
  try {
    const reading = loader.ensure({ directory, sessionID }, { reason: 'navigation' })
    await Promise.resolve()
    loader.configure({ sdk, runtimeKey: 'runtime-b' })
    resetRecoverableQuestions()
    interrupted()
    loader.configure({ sdk, runtimeKey: 'runtime-a' })
    resolvePage(page(terminalStates[0]))
    await reading
    const state = { form: {}, part: {} }
    expect(deriveRecoveredQuestions(state, useRecoverableQuestionsStore.getState(), new Set([sessionID]))).toHaveLength(1)
  } finally { loader.dispose(); stores.disposeAll(); resetRecoverableQuestions() }
})
