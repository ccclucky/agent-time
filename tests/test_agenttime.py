"""Source-shaped synthetic fixtures, not a claim of six-agent live validation."""
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from agenttime.adapters.codex import parse, timestamp
from agenttime.metrics import bounds, report, union_ms
from agenttime.server import make_server
from agenttime.store import Store
from agenttime.directories import Directories


def meta(id='session-1', **extra):
    return {'type':'session_meta','timestamp':'2026-10-21T09:00:00Z',
            'payload':{'id':id,'cwd':'/private/project','source':'cli','originator':'codex_cli_rs',**extra}}


def event(kind, at, tid='turn-1', **extra):
    return {'timestamp':at,'type':'event_msg','payload':{'type':kind,'turn_id':tid,**extra}}


def rows():
    return [meta(),event('task_started','2026-10-21T09:00:00Z'),
            {'type':'turn_context','timestamp':'2026-10-21T09:00:01Z','payload':
             {'turn_id':'turn-1','model':'test-model','instructions':'PRIVATE_CONTEXT'}},
            event('task_complete','2026-10-21T09:30:00Z',last_agent_message='PRIVATE_REPLY')]


class LocalFixture(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)
        self.store=Store(self.root/'db.sqlite3')
        self.file=self.root/'source.jsonl'
        self.directories=Directories(self.store,home=self.root,environment={})

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, records, path=None):
        path=path or self.file
        path.write_text(''.join(json.dumps(r)+'\n' for r in records),encoding='utf-8')
        return path

    def read_report(self, start='2026-10-21',end='2026-10-21',tz='UTC'):
        return report(self.store.sessions(),start,end,tz)


class ImportTests(LocalFixture):
    def test_native_fixture_is_read_only_idempotent_and_private(self):
        records=rows()+[{'type':'response_item','timestamp':'2026-10-21T09:00:00Z',
                         'payload':{'type':'message','content':'PRIVATE_PROMPT'}}]
        self.write(records)
        before=hashlib.sha256(self.file.read_bytes()).digest()
        self.store.import_file(self.file)
        self.store.import_file(self.file)
        self.assertEqual(hashlib.sha256(self.file.read_bytes()).digest(),before)
        s=self.read_report()['summary']
        self.assertEqual(s['processing_ms'],1800000)
        self.assertEqual(s['turns'],1)
        self.assertIsNone(s['work_ms'])
        self.assertIsNone(s['human_ms'])
        self.assertIsNone(s['response_gap_ms'])
        self.assertNotIn('PRIVATE',self.store.path.read_bytes().decode(errors='ignore'))
        encoded=json.dumps(self.store.sessions())
        self.assertNotIn('/private/',encoded)
        self.assertNotIn('PRIVATE',encoded)

    def test_duplicate_file_and_resumed_session_do_not_double_count(self):
        self.store.import_file(self.write(rows()))
        self.store.import_file(self.write(rows(),self.root/'copy.jsonl'))
        extra=[meta(),event('task_started','2026-10-22T09:00:00Z','turn-2'),
               event('task_complete','2026-10-22T09:10:00Z','turn-2')]
        self.store.import_file(self.write(extra,self.root/'resume.jsonl'))
        r=self.read_report('2026-10-21','2026-10-22')
        self.assertEqual(r['summary']['sessions'],1)
        self.assertEqual(r['summary']['turns'],2)
        self.assertEqual(r['summary']['processing_ms'],2400000)

    def test_parallel_triple_union_is_not_pairwise_subtraction(self):
        all_rows=[meta()]
        for tid,a,b in [('a','09:00','09:30'),('b','09:15','09:45'),('c','09:20','09:40')]:
            all_rows.extend([event('task_started',f'2026-10-21T{a}:00Z',tid),
                             event('task_complete',f'2026-10-21T{b}:00Z',tid)])
        self.store.import_file(self.write(all_rows))
        s=self.read_report()['summary']
        self.assertEqual(s['processing_ms'],80*60000)
        self.assertEqual(s['processing_union_ms'],45*60000)
        self.assertEqual(s['overlap_ms'],35*60000)

    def test_cross_midnight_clips_period_without_rewriting_events(self):
        a='2026-10-20T23:30:00Z';b='2026-10-21T00:30:00Z'
        self.store.import_file(self.write([meta(),event('task_started',a),event('task_complete',b)]))
        r=self.read_report()
        self.assertEqual(r['summary']['processing_ms'],30*60000)
        self.assertEqual(r['sessions'][0]['turns'][0]['elapsed_ms'],60*60000)
        self.assertEqual(r['sessions'][0]['turns'][0]['events'][0]['at_ms'],timestamp(a))
        self.assertEqual(self.read_report('2026-10-20','2026-10-20')['summary']['processing_ms'],30*60000)

    def test_failed_completion_counts_cost_without_claiming_success(self):
        records=rows();records[-1]['payload']['error']={'message':'PRIVATE_FAILURE'}
        self.store.import_file(self.write(records))
        result=self.read_report()
        self.assertEqual(result['summary']['statuses']['failed'],1)
        self.assertEqual(result['summary']['statuses']['completed'],0)
        self.assertEqual(result['summary']['processing_ms'],1800000)
        self.assertNotIn('PRIVATE_FAILURE',json.dumps(result))

    def test_missing_finish_is_not_zero_or_assumed_live(self):
        self.store.import_file(self.write(rows()[:-1]))
        s=self.read_report()['summary']
        self.assertEqual(s['statuses']['open'],1)
        self.assertIsNone(s['processing_ms'])
        self.assertEqual(s['measured_turns'],0)

    def test_missing_start_and_invalid_order_are_not_measured(self):
        for records,status in [([meta(),rows()[-1]],'incomplete'),
            ([meta(),event('task_started','2026-10-21T10:00:00Z'),rows()[-1]],'invalid')]:
            self.store.import_file(self.write(records))
            s=self.read_report()['summary']
            self.assertEqual(s['statuses'][status],1)
            self.assertIsNone(s['processing_ms'])

    def test_conflicting_boundaries_are_excluded(self):
        self.store.import_file(self.write(rows()+[event('task_started','2026-10-21T09:01:00Z')]))
        r=self.read_report()
        self.assertEqual(r['summary']['statuses']['invalid'],1)
        self.assertIsNone(r['summary']['processing_ms'])

    def test_abort_alias_and_refresh_updates_snapshot(self):
        records=[meta(),event('turn_started','2026-10-21T09:00:00Z')]
        self.store.import_file(self.write(records))
        records.append(event('turn_aborted','2026-10-21T09:05:00Z'))
        self.write(records)
        self.assertEqual(self.store.refresh()['updated'],1)
        s=self.read_report()['summary']
        self.assertEqual(s['statuses']['aborted'],1)
        self.assertEqual(s['processing_ms'],300000)

    def test_unreadable_refresh_retains_snapshot(self):
        self.store.import_file(self.write(rows()))
        self.file.unlink()
        self.assertEqual(self.store.refresh()['failed'],1)
        self.assertEqual(self.read_report()['summary']['processing_ms'],1800000)
        self.assertTrue(any('上次成功' in issue for issue in self.store.sessions()[0]['issues']))
        self.write(rows());self.store.refresh()
        self.assertFalse(self.store.sessions()[0]['issues'])

    def test_unsupported_provenance_rejected(self):
        for change in [{'source':'cloud'},{'source':{'subagent':{}}},
                       {'source':'cli','originator':'codex_cloud'},
                       {'forked_from_id':'parent'},{'parent_thread_id':'parent'},
                       {'history_base':{'thread_id':'parent'}},{'thread_source':'subagent'}]:
            with self.subTest(change=change):
                with self.assertRaises(ValueError):
                    self.store.import_file(self.write([meta(**change),*rows()[1:]]))
        self.assertEqual(self.store.sessions(),[])

    def test_rollback_rejected_not_flattened(self):
        records=rows()+[event('thread_rolled_back','2026-10-21T10:00:00Z')]
        with self.assertRaises(ValueError):
            self.store.import_file(self.write(records))

    def test_corrupt_line_marks_warning_and_does_not_store_contents(self):
        self.write(rows())
        with self.file.open('a') as f:f.write('{broken PRIVATE_PROMPT')
        self.store.import_file(self.file)
        self.assertTrue(self.store.sessions()[0]['issues'])
        self.assertNotIn('PRIVATE_PROMPT',json.dumps(self.store.sessions()))

    def test_multiple_models_retained_without_duplicate_time(self):
        records=rows()
        records.insert(3,{'type':'turn_context','timestamp':'2026-10-21T09:01:00Z',
                         'payload':{'turn_id':'turn-1','model':'second-model'}})
        self.store.import_file(self.write(records))
        r=self.read_report()
        self.assertEqual(len(r['sessions'][0]['turns'][0]['models']),2)
        self.assertEqual(r['summary']['processing_ms'],1800000)

    def test_unknown_id_not_invented_and_naive_time_rejected(self):
        records=rows();del records[1]['payload']['turn_id']
        self.store.import_file(self.write(records))
        self.assertIsNone(self.read_report()['summary']['processing_ms'])
        self.assertTrue(self.store.sessions()[0]['issues'])
        with self.assertRaises(ValueError):timestamp('2026-10-21T10:00:00')


class DirectoryTests(LocalFixture):
    def create_logs(self, root, sid='session-1', name='session.jsonl'):
        logs=root/'sessions';logs.mkdir(parents=True,exist_ok=True)
        records=rows();records[0]=meta(sid)
        return self.write(records,logs/name)

    def test_defaults_and_checks_do_not_read_agent_files(self):
        self.create_logs(self.root/'.codex')
        (self.root/'.codex'/'auth.json').write_text('PRIVATE_CREDENTIAL')
        settings={x['agent']:x for x in self.directories.list()}
        self.assertEqual(settings['codex']['path'],'~/.codex')
        self.assertEqual(settings['claude']['path'],'~/.claude')
        self.assertEqual(settings['omp']['path'],'~/.omp/agent')
        self.assertEqual(settings['pi']['path'],'~/.pi/agent')
        self.assertEqual(settings['opencode']['path'],'~/.local/share/opencode')
        self.assertIsNone(settings['antigravity']['path'])
        self.assertEqual(settings['codex']['status'],'directory')
        self.assertFalse(settings['codex']['enabled'])
        self.assertEqual(self.store.refresh(self.directories)['updated'],0)
        self.assertEqual(self.store.sessions(),[])

    def test_save_enable_discovery_and_new_files(self):
        root=self.root/'custom';self.create_logs(root)
        saved=self.directories.save('codex',str(root),False)
        self.assertEqual(saved['source'],'custom')
        self.assertEqual(self.store.refresh(self.directories)['updated'],0)
        self.directories.save('codex',str(root),True)
        self.assertEqual(self.store.refresh(self.directories)['updated'],1)
        self.create_logs(root,'session-2','new.jsonl')
        result=self.store.refresh(self.directories)
        self.assertEqual(result['discovered'],2)
        self.assertEqual(len(self.store.sessions()),2)
        self.assertEqual(self.read_report()['summary']['processing_ms'],3600000)
        self.assertNotIn('PRIVATE_CREDENTIAL',self.store.path.read_bytes().decode(errors='ignore'))

    def test_archived_move_retires_only_redundant_snapshot(self):
        root=self.root/'tool';file=self.create_logs(root)
        self.directories.save('codex',str(root),True)
        self.store.refresh(self.directories)
        archive=root/'archived_sessions';archive.mkdir()
        file.rename(archive/file.name)
        result=self.store.refresh(self.directories)
        self.assertEqual(result['failed'],0)
        self.assertEqual(result['relocated'],1)
        self.assertEqual(self.read_report()['summary']['processing_ms'],1800000)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM source').fetchone()[0],1)

    def test_archive_partial_copy_keeps_unique_old_events(self):
        root=self.root/'tool';file=self.create_logs(root)
        self.directories.save('codex',str(root),True)
        self.store.refresh(self.directories)
        file.unlink()
        archive=root/'archived_sessions';archive.mkdir()
        self.write(rows()[:-1],archive/'partial.jsonl')
        result=self.store.refresh(self.directories)
        self.assertEqual(result['failed'],1)
        self.assertEqual(result['relocated'],0)
        self.assertEqual(self.read_report()['summary']['processing_ms'],1800000)
        self.assertTrue(self.store.sessions()[0]['issues'])
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM source').fetchone()[0],2)

    def test_directory_preferences_persist_and_reset(self):
        default_root=self.root/'.codex';self.create_logs(default_root)
        self.directories.save('codex','~/custom',False)
        reopened=Directories(Store(self.store.path),home=self.root,environment={})
        self.assertEqual(reopened.get('codex')['path'],'~/custom')
        restored=reopened.save('codex',None,False)
        self.assertEqual(restored['path'],'~/.codex')
        self.assertEqual(restored['source'],'default')
        self.assertEqual(restored['resolved_path'],str(default_root))

    def test_tool_environment_default_and_custom_override(self):
        envroot=self.root/'env-tool'
        d=Directories(self.store,home=self.root,environment={'CODEX_HOME':str(envroot),'XDG_DATA_HOME':str(self.root/'xdg')})
        self.assertEqual(d.get('codex')['resolved_path'],str(envroot))
        self.assertEqual(d.get('codex')['source'],'environment')
        self.assertEqual(d.get('opencode')['resolved_path'],str(self.root/'xdg'/'opencode'))
        d.save('codex','~/manual',False)
        self.assertEqual(d.get('codex')['resolved_path'],str(self.root/'manual'))
        d.save('codex',None,False)
        self.assertEqual(d.get('codex')['resolved_path'],str(envroot))

    def test_verified_rules_include_actual_history_locations_and_evidence(self):
        settings={x['agent']:x for x in self.directories.list()}
        self.assertEqual(settings['codex']['history_locations'],[str(self.root/'.codex'/'sessions'),str(self.root/'.codex'/'archived_sessions')])
        self.assertEqual(settings['claude']['history_locations'],[str(self.root/'.claude'/'projects')])
        self.assertEqual(settings['omp']['history_locations'],[str(self.root/'.omp'/'agent'/'sessions')])
        self.assertEqual(settings['pi']['history_locations'],[str(self.root/'.pi'/'agent'/'sessions')])
        for agent in ['codex','claude','omp','pi','opencode']:
            self.assertTrue(settings[agent]['default_verified'])
            self.assertTrue(settings[agent]['evidence_url'].startswith('https://github.com/'))
        self.assertFalse(settings['antigravity']['default_verified'])
        self.assertIsNone(settings['antigravity']['evidence_url'])

    def test_omp_profile_uses_its_own_agent_directory(self):
        d=Directories(self.store,home=self.root,environment={'OMP_PROFILE':'work','PI_CODING_AGENT_DIR':str(self.root/'ignored')},platform='linux')
        self.assertEqual(d.get('omp')['resolved_path'],str(self.root/'.omp'/'profiles'/'work'/'agent'))
        d=Directories(self.store,home=self.root,environment={'PI_PROFILE':'legacy'},platform='linux')
        self.assertEqual(d.get('omp')['resolved_path'],str(self.root/'.omp'/'profiles'/'legacy'/'agent'))

    def test_omp_explicit_default_does_not_inherit_legacy_profile_dir(self):
        inherited=str(self.root/'.omp'/'profiles'/'legacy'/'agent')
        env={'OMP_PROFILE':'default','PI_PROFILE':'legacy','PI_CODING_AGENT_DIR':inherited}
        d=Directories(self.store,home=self.root,environment=env,platform='linux')
        self.assertEqual(d.get('omp')['path'],'~/.omp/agent')
        env['OMP_PROFILE']=''
        self.assertEqual(d.get('omp')['path'],'~/.omp/agent')

    def test_omp_xdg_requires_migrated_app_or_named_profile_path(self):
        xdg=self.root/'xdg';app=xdg/'omp'
        env={'XDG_DATA_HOME':str(xdg)}
        d=Directories(self.store,home=self.root,environment=env,platform='linux')
        self.assertEqual(d.get('omp')['path'],'~/.omp/agent')
        app.mkdir(parents=True)
        self.assertEqual(d.get('omp')['resolved_path'],str(app))
        env['OMP_PROFILE']='work'
        self.assertEqual(d.get('omp')['resolved_path'],str(self.root/'.omp'/'profiles'/'work'/'agent'))
        profile=app/'profiles'/'work';profile.mkdir(parents=True)
        self.assertEqual(d.get('omp')['resolved_path'],str(profile))
        self.assertEqual(d.get('omp')['history_locations'],[str(profile/'sessions')])

    def test_omp_custom_agent_dir_and_platform_control_xdg(self):
        xdg=self.root/'xdg';(xdg/'omp').mkdir(parents=True)
        env={'XDG_DATA_HOME':str(xdg),'PI_CODING_AGENT_DIR':str(self.root/'agent-custom')}
        d=Directories(self.store,home=self.root,environment=env,platform='darwin')
        self.assertEqual(d.get('omp')['resolved_path'],str(self.root/'agent-custom'))
        env.pop('PI_CODING_AGENT_DIR')
        d=Directories(self.store,home=self.root,environment=env,platform='win32')
        self.assertEqual(d.get('omp')['path'],'~/.omp/agent')
        env['PI_CONFIG_DIR']='.omp-alternative'
        self.assertEqual(d.get('omp')['resolved_path'],str(self.root/'.omp-alternative'/'agent'))

    def test_ambiguous_upstream_overrides_do_not_guess_default_paths(self):
        for agent,env in [('omp',{'OMP_PROFILE':'../bad'}),('omp',{'PI_CODING_AGENT_DIR':'relative'}),
                          ('pi',{'PI_CODING_AGENT_SESSION_DIR':'/custom/sessions'}),
                          ('codex',{'CODEX_HOME':'relative'}),('claude',{'CLAUDE_CONFIG_DIR':'relative'})]:
            with self.subTest(agent=agent,env=env):
                d=Directories(self.store,home=self.root,environment=env)
                self.assertIsNone(d.get(agent)['default_path'])
                self.assertEqual(d.get(agent)['source'],'unresolved')
                self.assertFalse(d.get(agent)['default_verified'])
                d.save(agent,str(self.root/'selected'),False)
                self.assertEqual(d.get(agent)['source'],'custom')
                d.save(agent,None,False)

    def test_opencode_db_override_controls_data_parent_not_config_directory(self):
        env={'XDG_DATA_HOME':str(self.root/'xdg'),'OPENCODE_CONFIG_DIR':str(self.root/'config')}
        d=Directories(self.store,home=self.root,environment=env)
        self.assertEqual(d.get('opencode')['resolved_path'],str(self.root/'xdg'/'opencode'))
        env['OPENCODE_DB']='alternate/records.db'
        self.assertEqual(d.get('opencode')['resolved_path'],str(self.root/'xdg'/'opencode'/'alternate'))
        env['OPENCODE_DB']=str(self.root/'other'/'records.db')
        self.assertEqual(d.get('opencode')['resolved_path'],str(self.root/'other'))
        env['OPENCODE_DB']=':memory:'
        self.assertIsNone(d.get('opencode')['default_path'])
        self.assertFalse(d.get('opencode')['default_verified'])

    def test_disabling_and_changing_roots_preserve_old_history_without_reading_it(self):
        old=self.root/'old';file=self.create_logs(old)
        self.directories.save('codex',str(old),True);self.store.refresh(self.directories)
        self.directories.save('codex',str(old),False)
        file.write_text('PRIVATE_CHANGED_NO_LONGER_READ')
        self.assertEqual(self.store.refresh(self.directories)['updated'],0)
        self.assertEqual(self.read_report()['summary']['processing_ms'],1800000)
        self.assertFalse(self.store.sessions()[0]['issues'])
        new=self.root/'new';self.create_logs(new,'session-2')
        self.directories.save('codex',str(new),True)
        result=self.store.refresh(self.directories)
        self.assertEqual(result['updated'],1)
        self.assertEqual(result['failed'],0)
        self.assertEqual(len(self.store.sessions()),2)

    def test_only_known_log_folders_and_no_symlink_escape(self):
        root=self.root/'tool';self.create_logs(root)
        self.write([meta('not-logs'),*rows()[1:]],root/'auth.jsonl')
        other=self.root/'outside';other.mkdir()
        self.write([meta('outside'),*rows()[1:]],other/'private.jsonl')
        (root/'sessions'/'link').symlink_to(other,target_is_directory=True)
        (root/'sessions'/'escape.jsonl').symlink_to(other/'private.jsonl')
        (root/'archived_sessions').symlink_to(other,target_is_directory=True)
        self.directories.save('codex',str(root),True)
        result=self.store.refresh(self.directories)
        self.assertEqual(result['updated'],1)
        self.assertEqual(len(self.store.sessions()),1)
        self.assertTrue(result['notices'])
        self.assertEqual(self.store.sessions()[0]['id'],'session-1')

    def test_missing_directory_is_explicit_and_does_not_create_tool_folders(self):
        missing=self.root/'missing'
        self.directories.save('codex',str(missing),True)
        self.assertEqual(self.directories.get('codex')['status'],'missing')
        self.assertFalse(missing.exists())
        r=self.store.refresh(self.directories)
        self.assertEqual(r['updated'],0)
        self.assertTrue(r['notices'])

    def test_unsupported_adapters_cannot_be_enabled(self):
        for agent in ['claude','omp','pi','opencode','antigravity']:
            self.directories.save(agent,'~/future',False)
            with self.assertRaises(ValueError):self.directories.save(agent,'~/future',True)
        self.assertEqual(self.store.refresh(self.directories)['updated'],0)

    def test_path_validation_and_file_rejection(self):
        file=self.root/'not-a-directory';file.write_text('PRIVATE')
        for path in ['relative','~other/tool','/',str(self.root),str(file),'bad\x00path',[],False]:
            with self.subTest(path=path),self.assertRaises(ValueError):
                self.directories.save('codex',path,False)


class MetricTests(unittest.TestCase):
    def test_dst_days_are_not_assumed_24_hours(self):
        a,b=bounds('2026-03-08','2026-03-08','America/New_York')
        self.assertEqual(b-a,23*3600000)
        a,b=bounds('2026-11-01','2026-11-01','America/New_York')
        self.assertEqual(b-a,25*3600000)

    def test_union_nested_touching_and_empty(self):
        self.assertEqual(union_ms([(10,20),(12,15),(20,30)]),20)
        self.assertEqual(union_ms([]),0)
        with self.assertRaises(ValueError):union_ms([(3,2)])

    def test_invalid_date_range(self):
        with self.assertRaises(ValueError):bounds('2026-10-22','2026-10-21','UTC')
        with self.assertRaises(ValueError):bounds('2020-01-01','2026-10-21','UTC')


class HTTPTests(LocalFixture):
    def setUp(self):
        super().setUp()
        self.store.import_file(self.write(rows()))
        self.server=make_server(self.store,0,directories=self.directories)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.base='http://127.0.0.1:'+str(self.server.server_address[1])

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join()
        super().tearDown()

    def test_functional_report_and_security_headers(self):
        with urlopen(self.base+'/api/report?start=2026-10-21&end=2026-10-21&timezone=UTC') as r:
            data=json.load(r)
            self.assertEqual(data['summary']['processing_ms'],1800000)
            self.assertNotIn('PRIVATE',json.dumps(data))
            self.assertIn("frame-ancestors 'none'",r.headers['Content-Security-Policy'])
        with urlopen(self.base) as r:self.assertIn('AgentTime',r.read().decode())

    def test_rebinding_cross_origin_and_path_apis_denied(self):
        for headers,path in [({'Host':'evil.example'},'/api/report'),
                             ({'Origin':'https://evil.example'},'/api/sources'),
                             ({},'/../../etc/passwd')]:
            with self.subTest(path=path),self.assertRaises(HTTPError) as caught:
                urlopen(Request(self.base+path,headers=headers))
            self.assertIn(caught.exception.code,(403,404))

    def test_post_only_refreshes_registered_files(self):
        headers={'Content-Type':'application/json','X-AgentTime':'1','Origin':self.base}
        req=Request(self.base+'/api/refresh',data=b'{}',headers=headers)
        with urlopen(req) as r:self.assertEqual(json.load(r)['updated'],1)
        for data,expected in [(b'{"path":"/etc/passwd"}',400),(b'x'*1025,400)]:
            with self.assertRaises(HTTPError) as caught:urlopen(Request(self.base+'/api/refresh',data=data,headers=headers))
            self.assertEqual(caught.exception.code,expected)
        with self.assertRaises(HTTPError) as caught:
            urlopen(Request(self.base+'/api/refresh',data=b'{}'))
        self.assertEqual(caught.exception.code,403)

    def test_settings_api_requires_same_origin_and_persists_without_import(self):
        headers={'Content-Type':'application/json','X-AgentTime':'1','Origin':self.base}
        payload={'agent':'codex','path':str(self.root/'selected'),'enabled':False}
        with urlopen(Request(self.base+'/api/directories',data=json.dumps(payload).encode(),headers=headers)) as r:
            self.assertEqual(json.load(r)['directory']['path'],payload['path'])
        with urlopen(self.base+'/api/directories') as r:
            settings=json.load(r)['directories']
        self.assertEqual(len(settings),6)
        self.assertEqual(next(x for x in settings if x['agent']=='codex')['path'],payload['path'])
        headers['Origin']='https://evil.example'
        with self.assertRaises(HTTPError) as caught:
            urlopen(Request(self.base+'/api/directories',data=json.dumps(payload).encode(),headers=headers))
        self.assertEqual(caught.exception.code,403)
        headers['Origin']=self.base
        payload['extra']='unexpected'
        with self.assertRaises(HTTPError) as caught:
            urlopen(Request(self.base+'/api/directories',data=json.dumps(payload).encode(),headers=headers))
        self.assertEqual(caught.exception.code,400)

    def test_bad_date_and_timezone_return_client_error(self):
        for q in ['start=bad','timezone=Not/AZone','start=2026-10-22&end=2026-10-21']:
            with self.assertRaises(HTTPError) as caught:urlopen(self.base+'/api/report?'+q)
            self.assertEqual(caught.exception.code,400)


if __name__=='__main__':
    unittest.main()
