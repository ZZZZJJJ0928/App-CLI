"""Lifecycle conformance: real local effects, durable replay and failure boundaries."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from dataclasses import replace
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from app_cli.cli import main
from app_cli.core import AppCLIError, Registry
from app_cli.lifecycle import AuthorizationGrant, LifecycleRegistration
from app_cli import lifecycle_protocol as wire
from app_cli.adapters.runtime import RuntimeAdapter
from app_cli.runtime_transport import exchange
from app_cli.tasks import TASK_STATUSES
from lifecycle_fixture import CounterAdapter, GrantProvider, manifest, write_grants

ROOT = Path(__file__).resolve().parents[1]


class LifecycleCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.now = time.time()
        self.request = {"protocol_version": "2.0", "operation": "invoke", "app": "fixture-counter", "command": "increment",
                        "arguments": {"amount": 2}, "request_key": "example-intent", "authorization_ref": "example-grant",
                        "deadline_ms": int(self.now * 1000) + 60000}
        self.grant = AuthorizationGrant("example-principal", "example-owner", "fixture-counter", "increment",
            self.request["request_key"], wire.intent_digest(self.request), "local_mutation", wire.BASE_OPERATIONS,
            int(self.now * 1000) + 120000, int(self.now * 1000) + 60000, self.request["deadline_ms"])
        self.provider = GrantProvider({"example-grant": self.grant})
        self.adapter = CounterAdapter(self.path / 'counter.sqlite', self.provider, clock=lambda: self.now)
        self.registration = self.review(self.adapter)
        self.registry = self.registry_for(self.adapter)

    def review(self, adapter):
        return LifecycleRegistration(adapter.manifest['id'], wire.digest(adapter.manifest),
                                     "example-implementation", "example-conformance")

    def registry_for(self, adapter, **options):
        return Registry([adapter], lifecycle=[self.review(adapter)], authorization=self.provider,
                        clock=lambda: self.now, **options)

    def control(self, operation, task_id=None, **fields):
        request = {key: self.request[key] for key in ('protocol_version','app','command','authorization_ref')}
        request.update(operation=operation, **fields)
        if operation == 'lookup':
            request['request_key'] = self.request['request_key']
        else:
            request['task_id'] = task_id
        return request

    def fails(self, code, call, *args):
        with self.assertRaises(AppCLIError) as caught:
            call(*args)
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn('PRIVATE_VALUE', str(caught.exception))
        return caught.exception


class LifecycleTests(LifecycleCase):
    def test_native_mutation_is_durable_and_duplicate_does_not_repeat(self):
        first = self.registry.control(self.request)
        restarted = self.registry_for(CounterAdapter(self.path/'counter.sqlite', self.provider))
        self.assertEqual(restarted.control(self.request), first)
        for operation in ['lookup','status','reconcile']:
            result = restarted.control(self.control(operation, first['task']['id']))
            self.assertEqual(result['task'], first['task'])
            self.assertEqual(result['data'], {'value':2})
        cancel = restarted.control(self.control('cancel', first['task']['id']))
        self.assertEqual(cancel['kind'], 'ack')
        self.assertEqual(cancel['task']['status'], 'completed')
        self.fails('TASK_TERMINAL', restarted.control, self.control('resume', first['task']['id']))

    def test_concurrent_original_intent_changes_counter_once(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.registry.control(self.request), range(16)))
        self.assertEqual({result['task']['id'] for result in results}, {results[0]['task']['id']})
        self.assertEqual({result['data']['value'] for result in results}, {2})

    def test_no_registration_no_provider_and_legacy_mutation_denied(self):
        self.fails('CAPABILITY_NOT_SUPPORTED', Registry([self.adapter]).control, self.request)
        registry = Registry([self.adapter], lifecycle=[self.registration])
        self.fails('AUTHORIZATION_REQUIRED', registry.control, self.request)
        self.fails('CAPABILITY_NOT_SUPPORTED', self.registry.execute, 'fixture-counter', 'increment', {'amount':2})
        self.assertFalse((self.path/'counter.sqlite').exists())

    def test_registration_is_explicit_and_bound_to_manifest(self):
        self.fails('MANIFEST_INVALID', lambda: Registry([self.adapter], lifecycle=[replace(self.registration, manifest_digest='0'*64)]))
        self.fails('MANIFEST_INVALID', lambda: Registry([self.adapter], lifecycle=[self.registration,self.registration]))
        self.fails('MANIFEST_INVALID', lambda: Registry([self.adapter], lifecycle=[replace(self.registration, operations=frozenset({'invoke'}))]))
        self.registry.list_apps()
        self.registry.describe('fixture-counter')
        self.assertFalse((self.path/'counter.sqlite').exists())

    def test_invalid_input_and_self_approved_arguments_do_not_reach_backend(self):
        for fields in [{'arguments':{'amount':True}}, {'approved':True}, {'arguments':{'amount':2,'approved':True}},
                       {'arguments':{'amount':0}}, {'operation':'shell'}, {'deadline_ms':True}]:
            self.fails('INPUT_VALIDATION_FAILED', self.registry.control, {**self.request,**fields})
        self.assertFalse((self.path/'counter.sqlite').exists())

    def test_scope_expiry_deadline_effect_and_intent_are_checked(self):
        for changes in [dict(app='other'),dict(command='other'),dict(request_key='other'),dict(side_effect='read_only'),
                        dict(intent_digest='0'*64),dict(execution_expires_ms=int(self.now*1000)),dict(operations=frozenset({'status'})),
                        dict(max_deadline_ms=self.request['deadline_ms']-1)]:
            self.provider.grants['example-grant'] = replace(self.grant, **changes)
            self.fails('AUTHORIZATION_DENIED', self.registry.control, self.request)
        self.assertFalse((self.path/'counter.sqlite').exists())

    def test_expired_execution_grant_still_allows_task_access(self):
        first = self.registry.control(self.request)
        self.provider.grants['example-grant'] = replace(self.grant,execution_expires_ms=int(self.now*1000))
        for operation in ['lookup','status','cancel']:
            self.registry.control(self.control(operation,first['task']['id']))
        self.fails('AUTHORIZATION_DENIED',self.registry.control,self.request)
        self.fails('AUTHORIZATION_DENIED',self.registry.control,self.control('reconcile',first['task']['id']))
        self.provider.grants['example-grant'] = replace(self.grant,execution_expires_ms=int(self.now*1000),access_expires_ms=int(self.now*1000))
        self.fails('AUTHORIZATION_DENIED',self.registry.control,self.control('status',first['task']['id']))

    def test_parameter_drift_needs_new_authority_and_conflicts_with_old_key(self):
        self.registry.control(self.request)
        changed = {**self.request,'arguments':{'amount':3}}
        self.fails('AUTHORIZATION_DENIED',self.registry.control,changed)
        self.provider.grants['example-grant'] = replace(self.grant,intent_digest=wire.intent_digest(changed))
        self.fails('REQUEST_KEY_CONFLICT',self.registry.control,changed)

    def test_task_access_is_scoped_to_owner_and_original_intent(self):
        first=self.registry.control(self.request)
        for changes in [dict(owner='other-owner'),dict(principal='other-principal'),dict(request_key='other-intent')]:
            self.provider.grants['example-grant'] = replace(self.grant,**changes)
            self.fails('TASK_NOT_FOUND',self.registry.control,self.control('status',first['task']['id']))
        self.provider.grants['example-grant'] = replace(self.grant,task_id='other-task')
        self.fails('AUTHORIZATION_DENIED',self.registry.control,self.control('status',first['task']['id']))

    def test_missing_deadline_and_unregistered_renew_are_denied(self):
        request={k:v for k,v in self.request.items() if k!='deadline_ms'}
        self.provider.grants['example-grant']=replace(self.grant,intent_digest=wire.intent_digest(request),max_deadline_ms=None)
        self.fails('AUTHORIZATION_DENIED',self.registry.control,request)
        self.fails('CAPABILITY_NOT_SUPPORTED',self.registry.control,self.control('renew','task-example'))

    def test_backend_rechecks_authority_after_admission(self):
        original=self.adapter.invoke_lifecycle
        def invoke(request,context):
            self.now+=61
            return original(request,context)
        self.adapter.invoke_lifecycle=invoke
        registry=self.registry_for(self.adapter)
        self.fails('AUTHORIZATION_DENIED',registry.control,self.request)

    def test_machine_cli_never_reports_ack_as_business_data(self):
        def run(request,argv=['--machine']):
            output=io.StringIO()
            with patch('sys.stdin',io.StringIO(json.dumps(request))),redirect_stdout(output):
                code=main(argv,registry=self.registry)
            return code,json.loads(output.getvalue())
        code,first=run(self.request)
        self.assertEqual(code,0)
        self.assertEqual(first['kind'],'task')
        code,result=run(self.control('cancel',first['task']['id']))
        self.assertEqual(code,0)
        self.assertEqual(result['kind'],'ack')
        self.assertNotIn('data',result)
        code,result=run(self.request,['--machine','apps'])
        self.assertEqual(code,2)
        self.assertEqual(result['error']['code'],'INVALID_ARGUMENT')

    def test_bad_outputs_and_adapter_exceptions_are_sanitized(self):
        original=self.adapter.invoke_lifecycle
        def invalid(request,context):
            result=original(request,context)
            result['data']={'value':'PRIVATE_VALUE'}
            return result
        self.adapter.invoke_lifecycle=invalid
        registry=self.registry_for(self.adapter)
        error=self.fails('OUTPUT_VALIDATION_FAILED',registry.control,self.request)
        self.assertEqual(error.task['status'],'completed')
        def exploding(request,context): raise RuntimeError('PRIVATE_VALUE')
        self.adapter.invoke_lifecycle=exploding
        self.fails('ADAPTER_EXECUTION_FAILED',self.registry_for(self.adapter).control,self.request)

    def test_protocol_identity_and_noncompleted_data_are_rejected(self):
        response=self.registry.control(self.request)
        for changes in [{'app':'other'},{'operation':'status'},{'kind':'ack'},{'request_key':'other-key'},
                        {'task':{'id':response['task']['id'],'status':'running'}}, {'extra':True}]:
            self.fails('BACKEND_PROTOCOL_INVALID',wire.validate_response,self.request,{**response,**changes})

    def test_machine_preserves_incomplete_outcomes_as_successful_rpc(self):
        for status in ['pending','running','waiting_confirmation','uncertain','failed','cancelled','blocked']:
            def invoke(request,context):
                result={key:request[key] for key in ('protocol_version','operation','app','command','request_key')}
                return {**result,'kind':'task','task':{'id':'task-example','status':status}}
            self.adapter.invoke_lifecycle=invoke
            registry=self.registry_for(self.adapter)
            output=io.StringIO()
            with patch('sys.stdin',io.StringIO(json.dumps(self.request))),redirect_stdout(output):
                self.assertEqual(main(['--machine'],registry=registry),0)
            result=json.loads(output.getvalue())
            self.assertEqual(result['task']['status'],status)
            self.assertNotIn('data',result)

    def test_backend_error_messages_do_not_cross_public_boundary(self):
        def invoke(request,context):
            result={key:request[key] for key in ('protocol_version','operation','app','command','request_key')}
            return {**result,'kind':'error','error':{'code':'REQUEST_KEY_CONFLICT','message':'PRIVATE_VALUE'}}
        self.adapter.invoke_lifecycle=invoke
        self.fails('REQUEST_KEY_CONFLICT',self.registry_for(self.adapter).control,self.request)


class WireTests(unittest.TestCase):
    def test_frozen_cross_language_intent_vectors(self):
        vectors=json.loads((ROOT/'tests/fixtures/intent-vectors.json').read_text())
        self.assertEqual([wire.digest(v['value']) for v in vectors],[v['sha256'] for v in vectors])

    @unittest.skipUnless(shutil.which('node'), 'Optional JavaScript conformance check requires Node')
    def test_javascript_and_python_intent_digests_match(self):
        vectors=json.loads((ROOT/'tests/fixtures/intent-vectors.json').read_text())
        raw=json.dumps([v['value'] for v in vectors],ensure_ascii=False).encode()
        result=subprocess.run([shutil.which('node'),str(ROOT/'tests/fixtures/canonical.mjs')],input=raw,
                              capture_output=True,timeout=10,check=True)
        self.assertEqual(json.loads(result.stdout),[wire.digest(v['value']) for v in vectors])

    def test_schema_copies_are_identical(self):
        self.assertEqual((ROOT/'schemas/lifecycle-v2.schema.json').read_bytes(),(ROOT/'src/app_cli/manifests/lifecycle-v2.schema.json').read_bytes())
        schema=json.loads((ROOT/'schemas/lifecycle-v2.schema.json').read_text())
        task=schema['$defs']['response']['oneOf'][0]['properties']['task']
        self.assertEqual(frozenset(task['properties']['status']['enum']),TASK_STATUSES)

    def test_strict_json_cross_language_profile(self):
        for raw in [b'{"x":1,"x":2}',b'{"x":NaN}',b'{"x":1e1000}',b'{"x":9007199254740992}',
                    b'{"x":"\\ud800"}',b'['*66+b'0'+b']'*66,b' '* (wire.MAX_REQUEST_BYTES+1)]:
            with self.subTest(raw=raw[:60]),self.assertRaises(AppCLIError): wire.decode(raw)
        self.assertEqual(wire.digest({'x':1,'y':-0.0}),wire.digest({'y':0,'x':1.0}))
        self.assertNotEqual(wire.digest({'x':True}),wire.digest({'x':1}))
        self.assertEqual(wire.decode(wire.encode({'x':0.125,'text':'邮箱'})),{'x':0.125,'text':'邮箱'})
        self.assertIs(type(wire.decode(b'{"sequence":1.0}')['sequence']),int)

    def test_large_body_budget_includes_json_escaping(self):
        body='a'+'\x01'*(200*1024-1)
        wire.encode({'content':body},wire.MAX_ARGUMENT_BYTES)
        with self.assertRaises(AppCLIError): wire.encode({'content':'x'*wire.MAX_ARGUMENT_BYTES},wire.MAX_ARGUMENT_BYTES)

    def test_events_require_order_and_requested_page_bounds(self):
        request={'protocol_version':'2.0','operation':'events','app':'example','command':'watch','authorization_ref':'example-grant','task_id':'task-example','cursor':2,'limit':1}
        response={k:request[k] for k in ['protocol_version','operation','app','command']}
        response.update(kind='events',task={'id':'task-example','status':'running'},cursor=3,gap=False,events=[{'sequence':3,'type':'hint','payload':{}}])
        wire.validate_response(request,response)
        for changes in [{'cursor':1},{'events':[{'sequence':2,'type':'hint','payload':{}}]}, {'events':response['events']*2}, {'task':{'id':'wrong','status':'running'}}]:
            with self.assertRaises(AppCLIError): wire.validate_response(request,{**response,**changes})


@unittest.skipUnless(os.name=='posix','Runtime 2.0 process cleanup currently requires POSIX')
class RuntimeV2Tests(LifecycleCase):
    def setUp(self):
        super().setUp()
        self.grants_path=self.path/'grants.json'
        write_grants(self.grants_path,self.provider.grants)
        self.argv=[sys.executable,'-I',str(ROOT/'tests/fixtures/runtime_v2.py'),str(self.path/'runtime.sqlite'),str(self.grants_path)]

    def runtime(self,*options):
        return RuntimeAdapter(manifest('runtime'),[*self.argv,*options],protocol_version='2.0',timeout_seconds=5)

    def test_actual_runtime_and_native_share_contract_without_importing_sparkclaw(self):
        adapter=self.runtime()
        registry=self.registry_for(adapter)
        first=registry.control(self.request)
        self.assertEqual(first['data'],{'value':2})
        self.assertEqual(registry.control(self.request),first)
        result=registry.control(self.control('lookup'))
        self.assertEqual(result['task'],first['task'])
        self.fails('CAPABILITY_NOT_SUPPORTED',adapter.invoke,'increment',{'amount':2})

    def test_lost_response_is_recovered_by_lookup_without_another_effect(self):
        self.fails('BACKEND_EXECUTION_FAILED',self.registry_for(self.runtime('lose-response')).control,self.request)
        registry=self.registry_for(self.runtime())
        result=registry.control(self.control('lookup'))
        self.assertEqual(result['data'],{'value':2})
        self.assertEqual(registry.control(self.request)['data'],{'value':2})

    def test_bounded_stdout_and_timeout_leave_no_client(self):
        for program,code in [("import sys;sys.stdout.write('x'*1048578)",'BACKEND_PROTOCOL_INVALID'),
                              ('import time;time.sleep(30)','BACKEND_TIMEOUT')]:
            started=time.monotonic()
            self.fails(code,lambda:exchange([sys.executable,'-I','-c',program],b'{}',timeout=0.3,max_response=1048576))
            self.assertLess(time.monotonic()-started,3)

    def test_runtime_v1_still_refuses_lifecycle_calls(self):
        adapter=RuntimeAdapter(manifest('runtime'),self.argv)
        self.fails('CAPABILITY_NOT_SUPPORTED',self.registry_for(adapter).control,self.request)


if __name__=='__main__': unittest.main()
