import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {SignedFileAuthorization} from '../src/authorization.mjs';
import {Ledger} from '../src/ledger.mjs';
import {Executor} from '../src/executor.mjs';
import {BrowserHostPort, BrowserHostClient} from '../src/host-port.mjs';
import {MemoryAnchor} from '../src/anchor.mjs';
import {digest, intentDigest, OPERATIONS} from '../src/protocol.mjs';
import {binding as baseBinding} from './fixture-assembly.mjs';
import {outputSchema} from '../applications/mail/output-schema.mjs';

const control = (request, operation, id, extra = {}) => ({protocol_version:'3.0', app:request.app,
  command:request.command, authorization_ref:request.authorization_ref, operation,
  ...(operation==='lookup'?{request_key:request.request_key}:{task_id:id}), ...extra});
const deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function until(callback, predicate) {
  const deadline=Date.now()+3000;
  do {const value=await callback();if(predicate(value))return value;await delay(5);}while(Date.now()<deadline);
  throw new Error('fixture condition timed out');
}
async function fixture(t, {result={data:{sent:1}}, failClose=true, pauseClose=false, beforeResult, command='send', schema, deadlineMS=20000}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'app-cli-cleanup-result-'));
  fs.chmodSync(root,0o700);const issuer=path.join(root,'issuer');fs.writeFileSync(issuer,randomBytes(32),{mode:0o600});
  const authorization=new SignedFileAuthorization(path.join(root,'grants'),issuer);
  const binding=structuredClone(baseBinding);
  binding.commands.send.host={methods:['deliver'],page:{},family:'outbox',activity:'exclusive'};
  binding.commands.send.reconcile_requires_host=false;
  if(command!=='send') {binding.commands[command]=binding.commands.send;delete binding.commands.send;}
  const manifest=binding.manifest.commands.find(item=>item.name==='send');manifest.name=command;
  if(schema)manifest.output_schema=schema;
  binding.manifest_digest=digest(binding.manifest);
  let now=Date.now(), deliveries=0, closes=0, closeFailure=failClose;
  const closing=deferred(), closePermit=deferred(), fence=path.join(root,'cleanup-fence.json');
  const driver={
    async create(){if(fs.existsSync(fence))throw Object.assign(new Error('cleanup pending'),{code:'BROWSER_CLEANUP_PENDING'});return {};},
    async updateLease(){},
    async call(_handle,method){assert.equal(method,'deliver');deliveries++;return true;},
    async close(){closes++;closing.resolve();if(pauseClose)await closePermit.promise;
      if(closeFailure){fs.writeFileSync(fence,'{"scope":"page"}');throw Object.assign(new Error('close failed'),{code:'BROWSER_SCRIPT_TIMEOUT'});}},
  };
  const clock=()=>now;
  const host=new BrowserHostPort({authorization,bindings:[binding],driver,stateDirectory:root,clock});
  const client=new BrowserHostClient({authorization,bindings:[binding],transport:request=>host.control(request)});
  const ledger=new Ledger(root,{clock,eventRetention:100});
  const anchor=new MemoryAnchor({clock});
  const handlers={increment:{run:async()=>({data:{value:1}})},watch:{run:async()=>({data:{}})},
    send:{async run(_args,context){await context.releaseDispatch();await context.browser.call('deliver');
      if(result.data?.sent===1)fs.writeFileSync(path.join(root,'sent-journal.json'),JSON.stringify(result.data),{mode:0o600});
      await beforeResult?.({context,advance:ms=>{now+=ms;}});return result;},
      async reconcile(){return fs.existsSync(path.join(root,'sent-journal.json'))?
        {data:JSON.parse(fs.readFileSync(path.join(root,'sent-journal.json')))}:{status:'uncertain',reason:'SEND_OUTCOME_UNKNOWN'};}}};
  const executor=new Executor({ledger,authorization,bindings:[binding],handlers,host:client,anchor,clock,rotationIntervalMs:0,gcIntervalMs:0});
  await executor.start();await client.connect(ledger.epoch);
  t.after(async()=>{closeFailure=false;closePermit.resolve();await executor.close();await host.close();ledger.close();fs.rmSync(root,{recursive:true,force:true});});
  function issue(name='one') {
    const request={protocol_version:'3.0',operation:'prepare',app:'local-fixture',command,
      request_key:'op3.1.1.'+createHash('sha256').update(name).digest('hex').slice(0,32),arguments:{},deadline_ms:now+deadlineMS};
    const grant={principal:'fixture-principal',owner:'fixture-owner',app:request.app,command:request.command,
      request_key:request.request_key,intent_digest:intentDigest(request),side_effect:'remote_mutation',operations:OPERATIONS,
      execution_expires_ms:now+60000,access_expires_ms:now+600000,max_deadline_ms:request.deadline_ms,revision:1};
    request.authorization_ref=authorization.issue(grant,{binding_digest:digest(binding),profile_id:'fixture',credential_generation:1,pool_key:'same-account'});
    return request;
  }
  async function invoke(request) {const admission=await executor.control(request);await executor.control(control(request,'invoke',admission.task.id));return admission.task.id;}
  async function terminal(request,id) {return until(()=>executor.control(control(request,'status',id)),value=>!['prepared','pending','running'].includes(value.task.status));}
  return {root,authorization,binding,handlers,host,client,ledger,anchor,executor,clock,issue,invoke,terminal,closing,closePermit,fence,
    advance:ms=>{now+=ms;},deliveries:()=>deliveries,closes:()=>closes,
    events:id=>ledger.events(ledger.get(id),0,100).events};
}

test('proved output survives cleanup failure while the actual Host slot remains fenced',async t=>{
  const f=await fixture(t);const request=f.issue(),id=await f.invoke(request),result=await f.terminal(request,id);
  assert.equal(result.task.status,'completed');assert.deepEqual(result.data,{sent:1});
  assert.equal(result.effect,true);assert.equal(f.ledger.get(id).dispatch,'sent');assert.equal(f.deliveries(),1);
  assert.equal(f.events(id).filter(e=>e.type==='dispatch_released').length,1);
  assert.deepEqual(f.events(id).find(e=>e.type==='host_cleanup_failed')?.payload,{reason:'BROWSER_SCRIPT_TIMEOUT'});
  assert.ok(fs.existsSync(f.fence));assert.ok([...f.host.resources.values()].some(slot=>slot.fenced));
  const next=f.issue('next'),nextID=await f.invoke(next),blocked=await f.terminal(next,nextID);
  assert.equal(blocked.task.status,'blocked');assert.equal(blocked.reason,'HOST_RESOURCE_BUSY');
  assert.equal(f.deliveries(),1);
  const replay=await f.executor.control(control(request,'invoke',id));
  assert.equal(replay.task.status,'completed');assert.deepEqual(replay.data,{sent:1});
  await assert.rejects(f.executor.control(control(request,'reconcile',id)),{code:'INVALID_TASK_STATE'});
  assert.equal(f.deliveries(),1);
});

test('a validated read observation is retained separately from cleanup failure',async t=>{
  const data={schema_version:1,provider:'qq_mail',target:{provider_message_id:'fixture-message'},
    read_state:'read',observed_at:'2026-01-01T00:00:00Z'};
  const f=await fixture(t,{command:'mark_read',schema:outputSchema('qq_mail','mark_read'),result:{data}});
  const request=f.issue(),id=await f.invoke(request),result=await f.terminal(request,id);
  assert.equal(result.task.status,'completed');assert.deepEqual(result.data,data);
  assert.equal(f.deliveries(),1);assert.ok(fs.existsSync(f.fence));
  assert.equal(f.events(id).filter(e=>e.type==='host_cleanup_failed').length,1);
});

test('completed output is not published or ACKable while cleanup is pending',async t=>{
  const f=await fixture(t,{pauseClose:true});const request=f.issue(),id=await f.invoke(request);
  await f.closing.promise;
  assert.equal(f.ledger.get(id).status,'running');assert.equal(f.ledger.get(id).data,null);
  assert.throws(()=>f.ledger.acknowledge(id,{result_digest:'0'.repeat(64),terminal_revision:1,receiver_id:'owner',receipt_id:'one'}),{code:'INVALID_TASK_STATE'});
  f.closePermit.resolve();const result=await f.terminal(request,id);
  assert.equal(result.task.status,'completed');assert.deepEqual(result.data,{sent:1});
  await f.executor.control(control(request,'ack_result',id,{result_digest:result.result_digest,
    terminal_revision:result.terminal_revision,receiver_id:'owner',receipt_id:'one'}));
  assert.ok(f.ledger.get(id).ack);assert.ok(fs.existsSync(f.fence));
});

for(const stop of ['cancellation','deadline','authorization expiry'])test(`${stop} during cleanup does not erase an already validated result`,async t=>{
  const f=await fixture(t,{pauseClose:true,failClose:false,deadlineMS:stop==='authorization expiry'?120000:20000});const request=f.issue(),id=await f.invoke(request);
  await f.closing.promise;
  if(stop==='cancellation')await f.executor.control(control(request,'cancel',id));else f.advance(stop==='deadline'?30000:70000);
  f.closePermit.resolve();const result=await f.terminal(request,id);
  assert.equal(result.task.status,'completed');assert.deepEqual(result.data,{sent:1});assert.equal(f.deliveries(),1);
});

for(const stop of ['cancellation','deadline','authorization expiry'])test(`${stop} before result validation keeps existing uncertainty`,async t=>{
  const f=await fixture(t,{failClose:false,deadlineMS:stop==='authorization expiry'?120000:20000,beforeResult:async({context,advance})=>{
    if(stop==='cancellation')await f.executor.control(control(request,'cancel',context.task_id));else advance(stop==='deadline'?30000:70000);
  }});const request=f.issue(),id=await f.invoke(request),result=await f.terminal(request,id);
  assert.equal(result.task.status,'uncertain');assert.equal(result.data,undefined);assert.equal(f.deliveries(),1);
  assert.equal(result.reason,{cancellation:'CANCEL_REQUESTED',deadline:'DEADLINE_EXCEEDED','authorization expiry':'AUTHORIZATION_EXPIRED'}[stop]);
});

for(const [name,result]of [['unproved',{status:'uncertain',reason:'SEND_OUTCOME_UNKNOWN'}],['invalid',{data:{sent:'not-an-integer'}}]])test(`${name} output cannot be promoted by cleanup failure`,async t=>{
  const f=await fixture(t,{result});const request=f.issue(),id=await f.invoke(request),out=await f.terminal(request,id);
  assert.equal(out.task.status,'uncertain');assert.equal(out.data,undefined);assert.ok(fs.existsSync(f.fence));
  assert.equal(f.deliveries(),1);assert.equal(f.events(id).some(e=>e.type==='host_cleanup_failed'),false);
});

test('restart preserves the completed receipt and cannot redeliver while cleanup remains fenced',async t=>{
  const f=await fixture(t);const request=f.issue(),id=await f.invoke(request);await f.terminal(request,id);await f.executor.close();
  const next=new Executor({ledger:f.ledger,authorization:f.authorization,bindings:[f.binding],handlers:f.handlers,
    host:f.client,anchor:f.anchor,clock:f.clock,rotationIntervalMs:0,gcIntervalMs:0});
  t.after(()=>next.close());await next.start();
  const found=await next.control(control(request,'lookup',id));assert.equal(found.task.status,'completed');assert.deepEqual(found.data,{sent:1});
  const replay=await next.control(control(request,'invoke',id));assert.equal(replay.task.status,'completed');assert.equal(f.deliveries(),1);
  assert.ok(fs.existsSync(f.fence));
});

test('a crash snapshot during cleanup still requires journal reconciliation without another dispatch',async t=>{
  const f=await fixture(t,{pauseClose:true});const request=f.issue(),id=await f.invoke(request);
  await f.closing.promise;
  assert.equal(f.ledger.get(id).status,'running');assert.equal(f.ledger.get(id).data,null);
  // Freeze the durable state at the crash boundary, before cleanup or finish.
  // The original fixture stays paused until this independent recovery completes.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'app-cli-cleanup-recovery-'));fs.chmodSync(root,0o700);
  const file=path.join(root,'ledger.sqlite');
  f.ledger.db.exec(`VACUUM INTO '${file.replaceAll("'","''")}'`);fs.chmodSync(file,0o600);
  for(const name of ['authority.json','issuer','sent-journal.json'])fs.copyFileSync(path.join(f.root,name),path.join(root,name));
  fs.cpSync(path.join(f.root,'grants'),path.join(root,'grants'),{recursive:true});
  fs.chmodSync(path.join(root,'grants'),0o700);
  const journal=fs.readFileSync(path.join(root,'sent-journal.json'));
  const authorization=new SignedFileAuthorization(path.join(root,'grants'),path.join(root,'issuer'));
  const ledger=new Ledger(root,{clock:f.clock});
  const handlers={...f.handlers,send:{run(){assert.fail('a released action cannot run again');},
    async reconcile(){return {data:JSON.parse(fs.readFileSync(path.join(root,'sent-journal.json')))};}}};
  const executor=new Executor({ledger,authorization,bindings:[f.binding],handlers,anchor:f.anchor,clock:f.clock,
    host:{acquire(){assert.fail('journal reconciliation does not acquire a page');}},rotationIntervalMs:0,gcIntervalMs:0});
  t.after(async()=>{await executor.close();ledger.close();fs.rmSync(root,{recursive:true,force:true});});
  await executor.start();assert.equal(ledger.get(id).status,'uncertain');assert.equal(ledger.get(id).data,null);
  assert.equal((await executor.control(control(request,'invoke',id))).task.status,'uncertain');
  await assert.rejects(executor.control(control(request,'resume',id)),{code:'INVALID_TASK_STATE'});
  await executor.control(control(request,'reconcile',id));
  const result=await until(()=>executor.control(control(request,'status',id)),value=>value.task.status==='completed');
  assert.deepEqual(result.data,{sent:1});assert.equal(result.attempt,1);assert.equal(f.deliveries(),1);
  assert.equal(ledger.events(ledger.get(id),0,100).events.filter(e=>e.type==='dispatch_released').length,1);
  assert.deepEqual(fs.readFileSync(path.join(root,'sent-journal.json')),journal);
});
