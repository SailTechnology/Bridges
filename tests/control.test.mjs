import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Controller} from '../src/control.mjs';

function fixture(){
  const calls=[];const rpc=new EventEmitter();rpc.requests=new Map();rpc.call=async(method,params)=>{calls.push({method,params});await new Promise(r=>setTimeout(r,10));return {thread:{id:'thread1'}};};
  rpc.respond=(id,result)=>calls.push({method:'response',id,result});
  const tracker={assertIdle:async()=>({thread:{id:'thread1',modelProvider:'OriginalProvider'},raw:{activity:{state:'idle'}}}),sync:()=>({activity:{state:'idle'},pendingBytes:0}),watch:async()=>{}};
  return {control:new Controller(rpc,tracker),rpc,tracker,calls};
}
test('takeover preserves provider and serializes concurrent clients',async()=>{
  const {control,calls}=fixture();const first=control.takeOver('thread1','one',true);
  await assert.rejects(control.takeOver('thread1','two',true),/正在执行/);await first;
  assert.deepEqual(calls[0],{method:'thread/resume',params:{threadId:'thread1',excludeTurns:true,modelProvider:'OriginalProvider'}});
  await assert.rejects(control.takeOver('thread1','two',true),/另一端持有/);
  await assert.rejects(control.send('thread1','two','text','message1'),/先在此设备/);
});
test('disconnect revokes leases and no send occurs before reacquiring',async()=>{
  const {control,rpc,calls}=fixture();await control.takeOver('thread1','one',true);rpc.emit('disconnected');
  await assert.rejects(control.send('thread1','one','text','message1'),/接续/);assert.equal(calls.length,1);
});
test('permissions are not silently granted and approval requires the lease owner',async()=>{
  const {control,rpc,calls}=fixture();await control.takeOver('thread1','one',true);
  rpc.requests.set('request1',{id:'request1',method:'item/commandExecution/requestApproval',params:{threadId:'thread1'}});
  assert.throws(()=>control.approve('request1','two','accept'),/接续设备/);
  control.approve('request1','one','decline');assert.deepEqual(calls.at(-1).result,{decision:'decline'});
  rpc.requests.set('request2',{id:'request2',method:'item/permissions/requestApproval',params:{threadId:'thread1'}});
  assert.throws(()=>control.approve('request2','one','accept'),/扩展权限/);
});
