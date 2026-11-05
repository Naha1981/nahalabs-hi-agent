"""Private per-job transport. No public listener, no credentials cross the pipe."""
import sys, os, json, tempfile, threading, shutil
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'vendor'))
from swarmchat import config
from swarmchat.server import make_server
from swarmchat.client import Client

data = tempfile.mkdtemp(prefix='nl-team-')
httpd = store = None
clients = {}
try:
    for line in sys.stdin:
        try:
            p = json.loads(line)
            if p['op'] == 'init':
                httpd, store = make_server(config.load(data=data, port=0, max_connections=24, max_requests=4, max_text=20000, min_free=16000000, max_attachment=1000000))
                threading.Thread(target=httpd.serve_forever, kwargs={'poll_interval': .05}, daemon=True).start()
                url = 'http://127.0.0.1:' + str(httpd.server_address[1])
                with open(os.path.join(data, 'admin.token')) as f: admin = Client(url, f.read().strip())
                labels = p['actors']
                for actor, name in labels.items():
                    clients[actor] = Client(url, admin.user_add(id=actor, name=name)['token'])
                admin.policy_set(rules={'admins': [], 'channel_creators': ['lead'], 'history': 'while_member', 'allow': {'add_members':['superadmin'], 'make_public':['superadmin']}})
                room = clients['lead'].channel_create(name='job', members=','.join(a for a in labels if a != 'lead'))['chat']['id']
                admin.close()
                result = {'ready': True, 'transport': 'private-room'}
            elif p['op'] == 'send':
                m = clients[p['actor']].send(chat=room, text=p['text'], reply_to=p.get('replyTo'))['message']
                result = {'id': m['id']}
            elif p['op'] == 'read':
                messages = clients[p['actor']].read(chat=room, last=100, peek=True)['messages']
                result = {'messages': [{'id':m['id'], 'actor':m['from'], 'from': labels[m['from']], 'text':m['text'], 'replyTo':m.get('reply_to')} for m in messages]}
            elif p['op'] == 'close':
                print(json.dumps({'ok':True}), flush=True)
                break
            else: raise ValueError('Unknown operation')
            print(json.dumps(result), flush=True)
        except Exception:
            print(json.dumps({'error':'Team coordination failed'}), flush=True)
finally:
    for c in clients.values(): c.close()
    if httpd:
        httpd.shutdown(); httpd.server_close(); store.close()
    shutil.rmtree(data, ignore_errors=True)
