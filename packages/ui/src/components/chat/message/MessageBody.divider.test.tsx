import React from 'react';
import { describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { OpenCode } from '@opencode/client';
import type { Part } from '@/lib/opencode/model';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import type { ChatMessageEntry, TurnGroupingContext } from '../lib/turns/types';
import { projectTurnActivity } from '../lib/turns/projectTurnActivity';

// Bun needs the asset URL that Vite normally supplies to the real renderer.
plugin({
  name: 'message-divider-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});
const { default: MessageBody } = await import('./MessageBody');

const unavailable = (): never => { throw new Error('Message rendering must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); },
  get git() { return unavailable(); },
  get files() { return unavailable(); },
  get settings() { return unavailable(); },
  get permissions() { return unavailable(); },
  get notifications() { return unavailable(); },
  get sourceControl() { return unavailable(); },
};
let runtimeRequests = 0;
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => { runtimeRequests++; return Response.json([]); } });
const answer: Part = { id: 'text', sessionID: 'session', messageID: 'answer', type: 'text', text: 'The answer.', time: { start: 1, end: 2 } };
const reasoning = (text: string): Part => ({ id: 'reasoning', sessionID: 'session', messageID: 'answer', type: 'reasoning', text, time: { start: 0, end: 1 } });
const context: TurnGroupingContext = {
  turnId: 'turn', isFirstAssistantInTurn: true, isLastAssistantInTurn: true,
  isLatestTurn: true, isWorking: false, hasTools: false, hasReasoning: false,
};
const renderAnswer = (parts: Part[], turnContext = context, showReasoningTraces = true, error?: { message?: string; responseBody?: string }) => renderToStaticMarkup(
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <SyncProvider sdk={sdk} directory="">
      <I18nProvider>
        <MessageBody
          messageId="answer" parts={parts} isUser={false} isMessageCompleted messageFinish="stop"
          isMobile={false} copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()}
          onToggleTool={() => {}} onShowPopup={() => {}} streamPhase="completed" allowAnimation={false}
          hasTextContent showReasoningTraces={showReasoningTraces} turnGroupingContext={turnContext}
          errorMessage={error?.message} errorResponseBody={error?.responseBody}
        />
      </I18nProvider>
    </SyncProvider>
  </RuntimeAPIContext.Provider>,
);
const renderStreamingReasoning = (parts: Part[]) => renderToStaticMarkup(
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <SyncProvider sdk={sdk} directory="">
      <I18nProvider>
        <MessageBody
          messageId="answer" parts={parts} isUser={false} isMessageCompleted={false}
          isMobile={false} copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()}
          onToggleTool={() => {}} onShowPopup={() => {}} streamPhase="streaming" allowAnimation={false}
          hasTextContent={false} showReasoningTraces turnGroupingContext={{ ...context, isWorking: true }}
        />
      </I18nProvider>
    </SyncProvider>
  </RuntimeAPIContext.Provider>,
);
const divider = 'mt-1.5 mb-3 h-px w-full bg-muted-foreground/20';
const assistant = (id: string, parts: Part[]): ChatMessageEntry => ({
  info: { id, sessionID: 'session', role: 'assistant', agent: 'build', providerID: 'mock', modelID: 'mock', finish: 'stop', time: { created: 1, completed: 2 } },
  parts,
});

describe('managed gateway size refusal', () => {
  for (const error of [
    { message: 'session.prompt failed (413): platform_gateway_request_too_large' },
    { responseBody: '{"error":{"code":"platform_gateway_request_too_large"}}' },
    { message: 'platform_model_funding_required', responseBody: '{"error":{"code":"platform_gateway_request_too_large"}}' },
  ]) {
    test(`explains the gateway limit without a funding action for ${JSON.stringify(error)}`, () => {
      runtimeRequests = 0;
      const html = renderAnswer([], context, true, error);
      expect(html).toContain('The model gateway rejected this request during its body read or size check (HTTP 413).');
      expect(html).toContain('System instructions and tool definitions also count toward the request size.');
      expect(html).toContain('Contact your administrator to check the gateway limit.');
      expect(html).toContain('This request will not be retried automatically.');
      expect(html).not.toContain('Top up model balance');
      expect(html).toContain('Show response details');
      expect(html).not.toContain('<pre');
      expect(runtimeRequests).toBe(0);
    });
  }

  test('shows credit purchase guidance for a native credit funding refusal', () => {
    const html = renderAnswer([], context, true, { responseBody: '{"error":{"code":"platform_model_credits_required"}}' });
    expect(html).toContain('Get credits');
    expect(html).toContain('There are not enough credits');
    expect(html).not.toContain('Top up model balance');
  });

  test('keeps the funding action for the confirmed funding refusal', () => {
    const html = renderAnswer([], context, true, { responseBody: '{"error":{"code":"platform_model_funding_required"}}' });
    expect(html).toContain('Top up model balance');
    expect(html).not.toContain('The model gateway rejected this request during its body read or size check');
  });
});

describe('final answer divider', () => {
  test('omits the divider for a direct answer without reasoning', () => {
    expect(renderAnswer([answer])).not.toContain(divider);
  });

  for (const text of ['', ' \n\t', '\u200b\u2060']) {
    test(`omits the divider for an invisible reasoning part ${JSON.stringify(text)}`, () => {
      expect(renderAnswer([reasoning(text), answer])).not.toContain(divider);
    });
  }

  test('keeps the divider after visible reasoning', () => {
    expect(renderAnswer([reasoning('Checking the response.'), answer])).toContain(divider);
  });

  test('omits the divider when reasoning is hidden', () => {
    expect(renderAnswer([reasoning('Checking the response.'), answer], context, false)).not.toContain(divider);
  });

  test('ignores invisible reasoning in an earlier assistant step', () => {
    const activity = projectTurnActivity({ turnId: 'turn', assistantMessages: [assistant('earlier-step', [reasoning('')])] });
    expect(renderAnswer([answer], {
      ...context, ...activity, isFirstAssistantInTurn: false,
    })).not.toContain(divider);
  });

  test('keeps the divider after visible reasoning in an earlier assistant step', () => {
    const activity = projectTurnActivity({ turnId: 'turn', assistantMessages: [assistant('earlier-step', [reasoning('Checking the response.')])] });
    expect(renderAnswer([answer], {
      ...context, ...activity, isFirstAssistantInTurn: false,
    })).toContain(divider);
  });


  test('keeps empty reasoning mounted while it streams', () => {
    const streaming: Part = { id: 'reasoning', sessionID: 'session', messageID: 'answer', type: 'reasoning', text: '', time: { start: 0 } };
    const ended: Part = { ...streaming, time: { start: 0, end: 1 } };
    expect(renderStreamingReasoning([streaming])).not.toBe(renderStreamingReasoning([ended]));
  });
});
