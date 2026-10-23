import test from 'node:test';
import assert from 'node:assert/strict';
import {mailHandlers} from '../../applications/mail/handlers.mjs';
import {ProviderScriptRegistry} from '../../applications/mail/runtime/provider-scripts.mjs';
import {ControllerError} from '../../applications/mail/runtime/errors.mjs';

for(const phase of ['prepare','handler','park'])test(`collect failure retains its original behavior and safely identifies ${phase}`,async t=>{
 const lines=[],calls=[];let effects=0,handled=0,resets=0;
 t.mock.method(process.stderr,'write',line=>{lines.push(String(line));return true;});
 const failure=phase==='park'?new ControllerError('browser_script_timeout','private message owner@example.invalid',{diagnosticReason:'process_exit_action_timeout'}):phase==='handler'?new SyntaxError('private body'):new TypeError('private URL');
 t.mock.method(ProviderScriptRegistry.prototype,'prepare',async function(){this.entries=new Map([['fixture',{provider:'outlook',operation:'collect_page',validate(){},async handler(){handled++;if(phase==='handler')throw failure;return {status:'empty'};}}]]);});
 const handlers=await mailHandlers();
 await assert.rejects(handlers['outlook.collect_page'].run({}, {resource:{account_address:'owner@example.invalid'},beforeEffect(){effects++;},browser:{reused:true,async call(method){
  calls.push(method);if(method==='prepareBackgroundPage'&&phase==='prepare')throw failure;
  if(method==='runReadCode'){if(++resets===2&&phase==='park')throw failure;return {provider:'outlook',account_address:'owner@example.invalid'};}
 }}}),{code:phase==='park'?'BROWSER_SCRIPT_TIMEOUT':'PROVIDER_SCRIPT_FAILED'});
 assert.equal(effects,phase==='prepare'?0:1);assert.equal(handled,phase==='prepare'?0:1);
 assert.deepEqual(calls,phase==='prepare'?['prepareBackgroundPage']:phase==='handler'?['prepareBackgroundPage','runReadCode']:['prepareBackgroundPage','runReadCode','runReadCode']);
 assert.equal(lines.length,1);assert.doesNotMatch(lines[0],/private|example\.invalid|URL|body/);
 const record=JSON.parse(lines[0]);assert.equal(record.event,'mail_capture_phase_failed');assert.equal(record.phase,phase);
 assert.equal(record.exception_name,failure.name);assert.equal(record.exception_code,phase==='park'?'browser_script_timeout':'unavailable');
 assert.equal(record.host_method,phase==='prepare'?'prepareBackgroundPage':phase==='park'?'runReadCode':undefined);
 assert.equal(record.host_reason,phase==='park'?'process_exit_action_timeout':undefined);
 assert.deepEqual(Object.keys(record.milliseconds),phase==='prepare'?['prepare']:phase==='handler'?['prepare','handler']:['prepare','handler','park']);
 for(const duration of Object.values(record.milliseconds))assert.ok(Number.isInteger(duration)&&duration>=0&&duration<=86_400_000);
});

test('collect diagnostic refuses arbitrary exception fields and cannot replace the original error',async t=>{
 const lines=[];t.mock.method(process.stderr,'write',line=>{lines.push(String(line));return true;});
 const failure=Object.assign(new Error('secret body'),{name:'secret account',code:'SECRET_BODY',diagnosticReason:'secret URL',diagnosticCommand:'secret query'});
 t.mock.method(ProviderScriptRegistry.prototype,'prepare',async function(){this.entries=new Map([['fixture',{provider:'outlook',operation:'collect_page',validate(){},handler(){throw failure;}}]]);});
 const handlers=await mailHandlers(),context={resource:{},beforeEffect(){},browser:{reused:true,async call(){}}};
 await assert.rejects(handlers['outlook.collect_page'].run({},context),{code:'SECRET_BODY'});
 assert.equal(lines.length,1);assert.doesNotMatch(lines[0],/secret|SECRET|account|query|body/);
 const record=JSON.parse(lines[0]);assert.equal(record.exception_name,'unavailable');assert.equal(record.exception_code,'unavailable');assert.equal(record.host_method,undefined);assert.equal(record.host_reason,undefined);
 t.mock.method(process.stderr,'write',()=>{throw Error('diagnostic output failed');});
 await assert.rejects(handlers['outlook.collect_page'].run({},context),{code:'SECRET_BODY'});
});

test('fixed diagnostic codes recognize MailPage lowercasing without accepting unknown codes',async t=>{
 const lines=[];t.mock.method(process.stderr,'write',line=>{lines.push(String(line));return true;});
 t.mock.method(ProviderScriptRegistry.prototype,'prepare',async function(){this.entries=new Map([['fixture',{provider:'outlook',operation:'collect_page',validate(){},handler(){assert.fail('must not reach handler');}}]]);});
 const handlers=await mailHandlers();
 for(const code of ['HOST_TIMEOUT','ENOENT','HOST_UNAVAILABLE']){
  await assert.rejects(handlers['outlook.collect_page'].run({}, {resource:{},browser:{reused:true,async call(){throw Object.assign(new Error('private host text'),{code});}}}),{code});
  const record=JSON.parse(lines.at(-1));assert.equal(record.exception_code,code.toLowerCase());assert.equal(record.host_method,'prepareBackgroundPage');
 }
 assert.doesNotMatch(lines.join(''),/private host text/);
});
