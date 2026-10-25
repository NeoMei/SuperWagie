import { create } from 'zustand';
import {
  loadProductHelpArticles,
  ProductHelpError,
  requestProductHelp,
  type ProductHelpAnswer,
  type ProductHelpArticle,
  type ProductHelpRequest,
  type ProductHelpOperation,
} from './client';
import type { ProductHelpOperationResult } from './operations';

type Message =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'assistant'; answer: ProductHelpAnswer };
type Failure = 'unsupported' | 'request' | 'invalid-response';
type HelpState = {
  runtimeKey: string;
  messages: Message[];
  draft: string;
  pending: boolean;
  failure: Failure | null;
  operation: { messageId: number; actionId: string; status: 'running' | ProductHelpOperationResult } | null;
  articles: ProductHelpArticle[];
  articleLocale: ProductHelpRequest['locale'] | null;
  articlesPending: boolean;
  articlesFailure: Failure | null;
  setDraft: (draft: string) => void;
  syncRuntime: (key: string) => void;
  clear: () => void;
  cancel: () => void;
  ask: (request: Omit<ProductHelpRequest, 'history'>) => Promise<void>;
  loadArticles: (locale: ProductHelpRequest['locale']) => Promise<void>;
  execute: (messageId: number, actionId: string, run: (operation: ProductHelpOperation, isCurrent: () => boolean) => Promise<ProductHelpOperationResult>) => Promise<void>;
};

// The server accepts up to 4,000 characters per history entry. The complete
// answer stays in the transcript even when its request context is shorter.
const HISTORY_TEXT_LIMIT = 4_000;

export function createProductHelpStore(dependencies = { answer: requestProductHelp, articles: loadProductHelpArticles }) {
  let requestId = 0;
  let articleRequestId = 0;
  let messageId = 0;
  let operationId = 0;
  let controller: AbortController | null = null;
  let articleController: AbortController | null = null;

  return create<HelpState>((set, get) => ({
    runtimeKey: '',
    messages: [],
    draft: '',
    pending: false,
    failure: null,
    operation: null,
    articles: [],
    articleLocale: null,
    articlesPending: false,
    articlesFailure: null,

    setDraft: (draft) => set({ draft }),

    syncRuntime: (runtimeKey) => {
      if (runtimeKey === get().runtimeKey) return;
      requestId++;
      articleRequestId++;
      operationId++;
      controller?.abort();
      articleController?.abort();
      set({
        runtimeKey,
        messages: [],
        draft: '',
        pending: false,
        failure: null,
        operation: null,
        articles: [],
        articleLocale: null,
        articlesPending: false,
        articlesFailure: null,
      });
    },

    clear: () => {
      requestId++;
      operationId++;
      controller?.abort();
      set({ messages: [], draft: '', pending: false, failure: null, operation: null });
    },

    cancel: () => {
      requestId++;
      controller?.abort();
      const last = get().messages.at(-1);
      set({
        pending: false,
        draft: get().draft || (last?.role === 'user' ? last.text : ''),
      });
    },

    ask: async (request) => {
      const question = request.question.trim();
      if (!question || get().pending) return;
      const history: ProductHelpRequest['history'] = get().messages.slice(-6).map(message => ({
        role: message.role,
        text: (message.role === 'user' ? message.text : message.answer.text).slice(0, HISTORY_TEXT_LIMIT),
      }));
      const id = ++requestId;
      controller?.abort();
      controller = new AbortController();
      const userMessage: Message = { id: ++messageId, role: 'user', text: question };
      set({
        messages: [...get().messages.slice(-39), userMessage],
        pending: true,
        failure: null,
        draft: '',
      });
      try {
        const answer = await dependencies.answer({ ...request, question, history }, controller.signal);
        if (id !== requestId) return;
        set({
          messages: [...get().messages, { id: ++messageId, role: 'assistant', answer }],
          pending: false,
        });
      } catch (error) {
        if (id !== requestId) return;
        set({ pending: false, failure: error instanceof ProductHelpError ? error.code : 'request', draft: get().draft || question });
      }
    },

    loadArticles: async (locale) => {
      if (get().articleLocale === locale && (get().articlesPending || !get().articlesFailure)) return;
      const id = ++articleRequestId;
      articleController?.abort();
      articleController = new AbortController();
      set({ articles: [], articleLocale: locale, articlesPending: true, articlesFailure: null });
      try {
        const articles = await dependencies.articles(locale, articleController.signal);
        if (id === articleRequestId) set({ articles, articlesPending: false });
      } catch (error) {
        if (id === articleRequestId) set({ articlesPending: false, articlesFailure: error instanceof ProductHelpError ? error.code : 'request' });
      }
    },

    execute: async (messageId, actionId, run) => {
      if (get().operation?.status === 'running') return;
      const message = get().messages.find(message => message.id === messageId);
      if (message?.role !== 'assistant' || message.answer.kind !== 'answer') return;
      const action = message.answer.actions.find(action => action.id === actionId);
      if (action?.kind !== 'execute') return;
      const id = ++operationId;
      const isCurrent = () => id === operationId;
      set({ operation: { messageId, actionId, status: 'running' } });
      try {
        const status = await run(action.operation, isCurrent);
        if (isCurrent()) set({ operation: { messageId, actionId, status } });
      } catch {
        if (isCurrent()) set({ operation: { messageId, actionId, status: 'failed' } });
      }
    },
  }));
}

export const useProductHelpStore = createProductHelpStore();
