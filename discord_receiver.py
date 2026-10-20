"""Deployable private Discord inbox. Exposes selected messages, never the journal."""
from pathlib import Path
from datetime import datetime, timezone
import hmac
import json
import os
import threading
from flask import Flask, request, jsonify
import discord_journal
import journal_media


def create_app(root, public_key, allowed_user, inbox_token, now=None):
    discord_journal.validate_receiver_config(public_key, allowed_user, inbox_token)
    app = Flask(__name__)
    app.config['MAX_CONTENT_LENGTH'] = 1024 * 1024
    root = Path(root); lock = threading.RLock()
    def instant():
        return now() if now else datetime.now(timezone.utc)
    def read(at=None):
        return discord_journal.load_inbox(root / 'inbox.json', now=at or instant())
    def authenticated():
        return hmac.compare_digest(request.headers.get('Authorization', '').encode(), ('Bearer ' + inbox_token).encode())
    @app.after_request
    def private_response(response):
        response.headers['Cache-Control'] = 'no-store'
        return response
    @app.post('/interactions')
    def interactions():
        content = request.get_data()
        at = instant()
        if not discord_journal.verify(content, request.headers.get('X-Signature-Ed25519', ''),
                                      request.headers.get('X-Signature-Timestamp', ''), public_key,
                                      now=at):
            return jsonify(error='Invalid signature'), 401
        try:
            value = json.loads(content)
            if not isinstance(value, dict):
                raise ValueError('Expected an interaction object')
            if type(value.get('type')) is int and value['type'] == 1:
                return jsonify(type=1)
            message = discord_journal.selected_message(value, allowed_user, now=at)
            identity = discord_journal.snowflake(value.get('id'))
            with lock:
                data = read(at)
                result = discord_journal.queue_message(data, identity, message, now=at)
                journal_media.save(root / 'inbox.json', data)
            messages = {
                'full': 'Inbox is full. Sync Datapom on your Mac, then try again.',
                'duplicate': 'Already in your Datapom inbox. Sync your Mac to add it to a journal day.',
                'saved': 'Saved to your Datapom inbox. Add it to a journal day when you are ready.',
            }
            return jsonify(type=4, data={'content': messages[result], 'flags': 64})
        except (ValueError, TypeError, KeyError):
            return jsonify(error='This message action is not allowed for this inbox'), 403
    @app.get('/inbox')
    def inbox():
        if not authenticated():
            return jsonify(error='Unauthorized'), 401
        with lock:
            return jsonify(messages=list(read()['messages'].values()))
    @app.post('/inbox/ack')
    def ack():
        if not authenticated():
            return jsonify(error='Unauthorized'), 401
        try:
            with lock:
                data = discord_journal.acknowledge_inbox(read(), request.get_json(silent=True))
                journal_media.save(root / 'inbox.json', data)
        except (ValueError, TypeError):
            return jsonify(error='Invalid acknowledgement'), 400
        return jsonify(ok=True)
    return app


if __name__ == '__main__':
    from waitress import serve
    app = create_app(**discord_journal.receiver_environment(os.environ))
    serve(app, host='0.0.0.0', port=int(os.environ.get('PORT', '8080')), threads=4)
