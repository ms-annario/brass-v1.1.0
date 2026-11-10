"""BRASS dev server: serves the app and proxies chat to the Claude API so the key stays off the page.

Run:  ANTHROPIC_API_KEY=sk-... python3 server.py [port]
The key may also live in a .env file next to this script (ANTHROPIC_API_KEY=...).
"""
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get('BRASS_CHAT_MODEL', 'claude-sonnet-5-5')
SYSTEM = (
    "You are the assistant inside BRASS, an interactive bus route map editor for Singapore. "
    "Help the user plan and edit bus routes, stops, road closures and affected areas. "
    "Toolbar: Move (M), New Bus Stop (S), Create Bus, Affected Area (A), Road Closure (C). "
    "Use the map summary the user message includes for facts; never invent data. "
    "Answer in a few short plain sentences, no markdown. "
    "You can also change the map. When the user asks you to do something to the map, say briefly what you will do, then add one line per action "
    "in exactly this form: ACTION: {json}. Actions: "
    '{"type":"close_road","road":"exact road name","between_stops":["stop code","stop code"]}, {"type":"open_road","road":"name"}, '
    '{"type":"add_area","near":"stop code or road name","radius_m":300}, {"type":"stop_off","stop":"stop code"}, {"type":"stop_on","stop":"stop code"}, '
    '{"type":"reroute","bus":"number"}, {"type":"focus_bus","bus":"number"}, {"type":"show_all"}, {"type":"goto_stop","stop":"stop code"}, {"type":"undo"}. '
    "Only use road names and stop codes the user gave you or the map summary lists. Never claim a change was made unless you emit its ACTION line. "
    "When documents are attached, carry out the user's command on them, using road names and stop codes from them too."
)


def api_key():
    key = os.environ.get('ANTHROPIC_API_KEY')
    if key:
        return key.strip()
    try:
        with open(os.path.join(ROOT, '.env')) as f:
            for line in f:
                if line.startswith('ANTHROPIC_API_KEY='):
                    return line.split('=', 1)[1].strip().strip('"\'')
    except OSError:
        pass
    return None


ANALYZE_SYSTEM = (
    "You read a document about a bus network (road works notice, service change memo, incident report, event plan) "
    "and list the map changes it requires for a bus route map editor. Reply with ONLY a JSON object, no prose, shaped: "
    '{"summary": "one sentence", "changes": [ ... ]}. Each change is one of: '
    '{"type":"closure","title":"short","road":"exact road name","between_stops":["stop code","stop code"] (optional),"reason":"short","source":"quote or section from the document"} ; '
    '{"type":"area","title":"short","name":"area name","near_stop":"stop code" (or "road":"road name"),"radius_m":number,"source":"..."} ; '
    '{"type":"stop_closed","title":"short","stop":"stop code","source":"..."} ; '
    '{"type":"detour","title":"short","bus":"bus number","source":"..."} ; '
    '{"type":"new_bus","title":"short","bus":"the new service number, e.g. 12B","stops":["stop code", ...] (its stops in order, if the document lists them),"source":"..."} . '
    "Use stop codes and road names exactly as written in the document. Only include changes the document states or clearly requires. "
    "A document may instead be a JSON area drawing ({\"kind\":\"brass-area-drawing\",\"polygon\":[{x,y}...],\"roads\":[...],\"stops\":[...]}). "
    "For it return {\"type\":\"area\",\"title\":\"short\",\"name\":\"its name\",\"polygon\":<the same polygon copied exactly>,\"source\":\"short\"}; "
    "when a drawing exists, do not also add a round area for the same zone. "
    "Order: closures, areas, stops, new buses, detours."
)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    # The browser checks for a newer copy every time (and reuses its own when nothing changed), so edits show on reload
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _document_blocks(self, documents):
        blocks = []
        for d in documents[:5]:
            name = str(d.get('name', 'document'))[:200]
            if d.get('pdf'):
                blocks.append({'type': 'document', 'source': {'type': 'base64', 'media_type': 'application/pdf', 'data': d['pdf']}})
            else:
                blocks.append({'type': 'text', 'text': 'Document "%s":\n%s' % (name, str(d.get('text', ''))[:30000])})
        return blocks

    def _claude(self, key, system, messages, max_tokens):
        req = urllib.request.Request(
            'https://api.anthropic.com/v1/messages',
            data=json.dumps({'model': MODEL, 'max_tokens': max_tokens, 'system': system, 'messages': messages}).encode(),
            headers={'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
        )
        with urllib.request.urlopen(req, timeout=90) as r:
            out = json.load(r)
        return ''.join(b.get('text', '') for b in out.get('content', []) if b.get('type') == 'text')

    def _analyze(self):
        key = api_key()
        if not key:
            return self._json(503, {'error': 'no_key'})
        try:
            n = int(self.headers.get('Content-Length', 0))
            data = json.loads(self.rfile.read(n))
            blocks = self._document_blocks(data['documents'])
            blocks.append({'type': 'text', 'text': 'List the required map changes as JSON.'})
        except (ValueError, KeyError, TypeError):
            return self._json(400, {'error': 'bad request'})
        try:
            text = self._claude(key, ANALYZE_SYSTEM, [{'role': 'user', 'content': blocks}], 2500)
            a, b = text.find('{'), text.rfind('}')
            self._json(200, json.loads(text[a:b + 1]))
        except urllib.error.HTTPError as e:
            self._json(502, {'error': 'api_%d' % e.code})
        except ValueError:
            self._json(502, {'error': 'unreadable'})
        except Exception:
            self._json(502, {'error': 'unreachable'})

    def do_POST(self):
        if self.path == '/api/analyze':
            return self._analyze()
        if self.path != '/api/chat':
            return self._json(404, {'error': 'not found'})
        key = api_key()
        if not key:
            return self._json(503, {'error': 'no_key'})
        try:
            n = int(self.headers.get('Content-Length', 0))
            data = json.loads(self.rfile.read(n))
            msgs = [{'role': m['role'], 'content': str(m['content'])[:8000]}
                    for m in data['messages'][-20:] if m.get('role') in ('user', 'assistant')]
            system = SYSTEM + ('\n\nMap summary:\n' + str(data.get('context', ''))[:4000])
            docs = self._document_blocks(data.get('documents') or [])
            if docs and msgs and msgs[-1]['role'] == 'user':
                msgs[-1]['content'] = docs + [{'type': 'text', 'text': msgs[-1]['content']}]
        except (ValueError, KeyError, TypeError, AttributeError):
            return self._json(400, {'error': 'bad request'})
        req = urllib.request.Request(
            'https://api.anthropic.com/v1/messages',
            data=json.dumps({'model': MODEL, 'max_tokens': 1000 if docs else 500, 'system': system, 'messages': msgs}).encode(),
            headers={'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                out = json.load(r)
            text = ''.join(b.get('text', '') for b in out.get('content', []) if b.get('type') == 'text')
            self._json(200, {'reply': text})
        except urllib.error.HTTPError as e:
            self._json(502, {'error': 'api_%d' % e.code})
        except Exception:
            self._json(502, {'error': 'unreachable'})


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print('BRASS on http://localhost:%d  (chat AI: %s)' % (port, 'on' if api_key() else 'no key'))
    ThreadingHTTPServer(('', port), Handler).serve_forever()
