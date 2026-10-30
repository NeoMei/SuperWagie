import { expect, test } from 'bun:test';
import { prepareHyResult } from './results.js';
const segment = { id:'seg',projectId:'p',sessionId:'s',sourceHash:'a',messageIds:['u'],messages:[{id:'u',role:'user',text:'Split long slides.'}] };
const card = {id:'c',kind:'experience',title:'Split slides',body:'Split long slides.',status:'active',verification:'observed',sourceMessageIds:['u'],sourcePartIds:[],limitations:[],sourceRefs:[{sessionId:'s',messageId:'u',sourceHash:'a'}]};
test('Hy confidence and supplied statuses cannot elevate an inferred experience', () => {
 const result = prepareHyResult({ result:{cards:[card],operations:[]},segment,state:{jobs:[],sessions:{},entries:[],engine:{records:[]}} });
 expect(result.cards[0]).toMatchObject({status:'candidate',verification:'unverified'});
});
test('unknown source citations reject the entire batch', () => {
 expect(()=>prepareHyResult({result:{cards:[{...card,sourceMessageIds:['unknown']}],operations:[]},segment,state:{jobs:[],sessions:{},entries:[],engine:{records:[]}}})).toThrow();
});
