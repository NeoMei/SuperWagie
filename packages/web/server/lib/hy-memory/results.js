import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sanitizeMemoryText } from '../conversation-memory/reader.js';
import { memoryNamespace } from './organizer.js';

const refSchema = z.object({ sessionId: z.string(), messageId: z.string(), partId: z.string().optional(), sourceHash: z.string(), sourceRevision: z.number().int().nonnegative().nullish() });
const cardSchema = z.object({ id:z.string().min(1).max(1024),kind:z.enum(['segment','experience','methodology']),title:z.string().min(1).max(240),body:z.string().min(1).max(96000),sourceMessageIds:z.array(z.string()).min(1).max(100),sourcePartIds:z.array(z.string()).max(100),limitations:z.array(z.string()).max(20),sourceRefs:z.array(refSchema).optional(),supportingEntryIds:z.array(z.string()).optional() });
const nodeSchema = z.object({id:z.string().min(1).max(1024),content:z.string().max(200000),vector:z.array(z.number().finite()).min(1).max(32768),payload:z.object({user_id:z.string(),workspace_id:z.string(),custom:z.object({source_refs:z.array(refSchema)}).passthrough()}).passthrough(),active:z.boolean()});
const operationSchema = z.discriminatedUnion('operation',[
 z.object({operation:z.literal('nodes/upsert'),space_id:z.string().min(1).nullish(),nodes:z.array(nodeSchema).max(512)}),
 z.object({operation:z.literal('nodes/delete'),space_id:z.string().nullish(),ids:z.array(z.string()).min(1).max(1024)}),
 z.object({operation:z.enum(['records/upsert','records/delete']),collection:z.string().min(1).max(100),id:z.string().min(1),value:z.json().optional()}),
 z.object({operation:z.enum(['relations/upsert','relations/delete']),id:z.string().min(1),value:z.json().optional()}),
]);
const resultSchema = z.object({cards:z.array(cardSchema).max(512),operations:z.array(operationSchema).max(2048),continuation:z.json().optional()});
const fail=()=>Object.assign(new Error('Hy result does not match authorized sources'),{code:'hy_source_invalid'});

export function prepareHyResult({result:raw,segment,state}) {
 const result=resultSchema.parse(raw);
 for(const op of result.operations)if(op.operation.startsWith('records/')&&!['trace','code_history','review'].includes(op.collection))throw fail();
 const spaceId=z.object({spaceId:z.string().optional()}).parse(raw).spaceId;
 for(const op of result.operations)if(op.operation==='nodes/upsert'&&!op.space_id){if(!spaceId)throw fail();op.space_id=spaceId;}
 const namespace=`${memoryNamespace(segment.projectId)}:core`;
 const sources=[segment,...state.jobs.filter(j=>j.segment?.projectId===segment.projectId && !state.sessions[j.segment.sessionId]?.deleted && (state.sessions[j.segment.sessionId]?.revision??0)===(j.sourceRevision??0)).map(j=>j.segment)];
 const sourceMatches=(ref)=>sources.some(source=>source.sessionId===ref.sessionId && source.sourceHash===ref.sourceHash && (ref.sourceRevision==null || ref.sourceRevision===(state.sessions[ref.sessionId]?.revision??0))
   && source.messages.some(m=>m.id===ref.messageId && (!ref.partId || m.partId===ref.partId)));
 const validateRef=sourceMatches;
 for(const op of result.operations)if(op.operation==='nodes/upsert')for(const node of op.nodes){
  if(node.payload.user_id!==namespace || node.payload.workspace_id!==segment.projectId || !node.payload.custom.source_refs.length || node.payload.custom.source_refs.some(ref=>!validateRef(ref)))throw fail();
 }
 const cards=result.cards.map(card=>{
  const refs=card.sourceRefs??segment.messages.filter(m=>card.sourceMessageIds.includes(m.id)).map(m=>{
   const ref={sessionId:segment.sessionId,messageId:m.id,sourceHash:segment.sourceHash};
   if(m.partId)ref.partId=m.partId;
   return ref;
  });
  if(!refs.length || refs.some(ref=>!validateRef(ref)) || card.sourceMessageIds.some(id=>!refs.some(ref=>ref.messageId===id)) || card.sourcePartIds.some(id=>!refs.some(ref=>ref.partId===id)))throw fail();
  return {id:card.id,kind:card.kind,title:sanitizeMemoryText(card.title),body:sanitizeMemoryText(card.body),status:card.kind==='segment'?'active':'candidate',verification:'unverified',sourceMessageIds:card.sourceMessageIds,sourcePartIds:card.sourcePartIds,
   limitations:[...new Set([...card.limitations.map(sanitizeMemoryText),'Hy-generated inference. Verify current sources and applicability before acting.'])].slice(0,20),
   sourceReferences:refs.map(ref=>({sessionId:ref.sessionId,messageId:ref.messageId})),supportingEntryIds:card.supportingEntryIds??[]};
 });
 return {cards,operations:result.operations,continuation:result.continuation??null,namespace};
}

export function appendHyProjection(state,{id,projectId,operations,sourceSessionIds}) {
 if(!operations.length || state.engine.projections.some(p=>p.id===id))return;
 state.engine.projections.push({id,projectId,sourceSessionIds:[...new Set(sourceSessionIds)],operations,state:'pending',error:null});
}
export async function applyHyProjection({store,backend,projection,validateState=()=>true}) {
 const indexes=[];
 const mutate=state=>{
  indexes.length=0;
  const current=state.engine.projections.find(p=>p.id===projection.id);if(!current||current.state==='done')return;
  if(current.projectId!==projection.projectId)throw Object.assign(new Error('Projection project changed'),{code:'hy_scope_mismatch'});
  if(!validateState(state)||current.sourceSessionIds.some(id=>state.sessions[id]?.deleted||state.sessions[id]?.reconciling))throw Object.assign(new Error('Source withdrawn'),{code:'source_changed'});
  const operations=current.operations.map(op=>operationSchema.parse(op));
  const namespace=`${memoryNamespace(current.projectId)}:core`;
  for(const op of operations.filter(op=>op.operation==='nodes/upsert'))for(const node of op.nodes){
   if(state.tombstones.includes(node.id)||node.payload.custom.source_refs.some(ref=>{
    const source=state.sessions[ref.sessionId];
    if(!source||source.deleted||source.reconciling)return true;
    if(ref.sourceRevision!=null)return ref.sourceRevision!==(source.revision??0);
    return !state.jobs.some(job=>job.segment?.projectId===current.projectId&&job.segment?.sessionId===ref.sessionId&&job.segment?.sourceHash===ref.sourceHash&&job.sourceRevision===(source.revision??0));
   }))throw Object.assign(new Error('Source withdrawn'),{code:'source_changed'});
  }
  for(const op of operations.filter(op=>op.operation.startsWith('nodes/'))){
   if(op.operation==='nodes/upsert')for(let offset=0;offset<op.nodes.length;offset+=256)indexes.push({...op,namespace,nodes:op.nodes.slice(offset,offset+256)});
   if(op.operation==='nodes/delete')for(let offset=0;offset<op.ids.length;offset+=256)indexes.push({...op,namespace,ids:op.ids.slice(offset,offset+256)});
  }
  const retired=new Set();
  for(const op of operations){
   if(op.operation==='nodes/delete')for(const id of op.ids)retired.add(id);
   if(op.operation==='nodes/upsert')for(const node of op.nodes)if(!node.active||['superseded','forgotten'].includes(node.payload.status))retired.add(node.id);
  }
  const retiredCards=[];
  for(const entry of state.entries)if(entry.projectId===current.projectId&&retired.has(entry.id)&&['active','candidate'].includes(entry.status)){
   entry.status='superseded';entry.cleanupPending=false;entry.documentId=null;entry.knowledgeId=null;entry.indexState='pending';entry.error=null;retiredCards.push(entry.id);
  }
  for(let offset=0;offset<retiredCards.length;offset+=256)indexes.push({operation:'nodes/delete',namespace:`${memoryNamespace(current.projectId)}:cards`,ids:retiredCards.slice(offset,offset+256)});
  for(const op of operations){
   if(op.operation.startsWith('nodes/'))continue;
   const collection=op.operation.startsWith('relations/')?'relation':op.collection;
   const i=state.engine.records.findIndex(r=>r.projectId===projection.projectId&&r.collection===collection&&r.id===op.id);
   if(i>=0)state.engine.records.splice(i,1);
   if(op.operation.endsWith('/upsert'))state.engine.records.push({collection,id:op.id,projectId:projection.projectId,value:op.value??null});
  }
  for(const op of operations.filter(op=>op.operation==='nodes/delete'))state.engine.records=state.engine.records.filter(record=>record.projectId!==current.projectId||record.collection!=='node-source'||!op.ids.includes(record.id));
  for(const op of operations.filter(op=>op.operation==='nodes/upsert'))for(const node of op.nodes){
   const i=state.engine.records.findIndex(r=>r.collection==='node-source'&&r.id===node.id&&r.projectId===projection.projectId);
   const value={id:node.id,sourceRefs:node.payload.custom.source_refs};if(i>=0)state.engine.records.splice(i,1);
   state.engine.records.push({collection:'node-source',id:node.id,projectId:projection.projectId,value});
  }
  current.state='done';current.error=null;current.operations=[];
 };
 if(store.atomicIndex)await store.update(mutate,{indexOperations:indexes});
 else {
  const before=await store.read();mutate(before);
  if(indexes.some(op=>op.operation==='nodes/upsert'))throw Object.assign(new Error('Atomic projection store required'),{code:'hy_atomic_projection_required'});
  for(const {operation,...input} of indexes)await backend(operation,input);
  await store.update(mutate);
 }
}
export const hyBatchId=(id,hash)=>`hy:${createHash('sha256').update(`${id}:${hash}`).digest('hex')}`;
