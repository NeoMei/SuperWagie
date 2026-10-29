import { describe, expect, it, vi } from 'vitest';
import { readPlatformExecution } from './execution.js';

const fixture = (pages) => {
  const session = { model: { providerID: 'unihub', id: 'model' }, time: { idle: 42 } };
  const list = vi.fn(async ({ cursor }) => {
    const value = pages[cursor ?? 'first'];
    if (value instanceof Error) throw value;
    return value;
  });
  return { client: { session: { get: vi.fn(async () => session) }, message: { list } }, list, session };
};

describe('platform execution prompt lookup', () => {
  it('finds the newest user across message pages using cursor-only continuation', async () => {
    const f = fixture({first:{data:Array.from({length:100},(_,i)=>({type:'assistant',id:`a${i}`})),cursor:{next:'older'}},older:{data:[{type:'assistant',id:'a100'},{type:'user',id:'msg_current'},{type:'user',id:'msg_previous'}]}});
    expect(await readPlatformExecution(f.client, 'ses_1')).toEqual({model:f.session.model,parentID:undefined,idle:42,promptID:'msg_current'});
    expect(f.list.mock.calls.map(([q])=>q)).toEqual([{sessionID:'ses_1',limit:100,order:'desc'},{sessionID:'ses_1',limit:100,cursor:'older'}]);
  });
  it('does not mistake a previous turn for the current prompt', async () => {
    const f=fixture({first:{data:[{type:'assistant',id:'a1'},{type:'idle',id:'idle'},{type:'user',id:'msg_previous'}]}});
    expect((await readPlatformExecution(f.client,'ses_1')).promptID).toBeUndefined();
  });
  it('fails closed on malformed pages, repeated cursor, errors and a bounded search', async () => {
    const invalid = fixture({first:{data:null}}); await expect(readPlatformExecution(invalid.client,'ses_1')).rejects.toThrow();
    const error = fixture({first:{data:[{type:'assistant',id:'a'}],cursor:{next:'older'}},older:new Error('offline')}); await expect(readPlatformExecution(error.client,'ses_1')).rejects.toThrow();
    const loop = fixture({first:{data:[{type:'assistant',id:'a'}],cursor:{next:'loop'}},loop:{data:[{type:'assistant',id:'a'}],cursor:{next:'loop'}}}); await expect(readPlatformExecution(loop.client,'ses_1')).rejects.toThrow();
    const list=vi.fn(async({cursor})=>({data:[{type:'assistant',id:'a'}],cursor:{next:String(Number(cursor ?? 0)+1)}}));
    const result=await readPlatformExecution({session:{get:async()=>({})},message:{list}},'ses_1'); expect(result.promptID).toBeUndefined(); expect(list).toHaveBeenCalledTimes(10);
  });
});
