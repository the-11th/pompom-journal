"""Thin HTTP adapters for journal media, offline maps, and location history."""
from pathlib import Path
from flask import request, jsonify, send_file, abort, render_template
from datapom.domain import journal
from datapom.domain import journal_commands
from datapom.domain import todo
from datapom.domain import journal_media as media
from datapom.domain import places
from datapom.domain import map_packs
from datapom.integrations import discord_journal
from datapom.paths import ROOT


def register(app, journal_file, mobile_authenticated, lock, data_file):
    def root():
        return Path(journal_file()).parent

    def store_path():
        return root() / "media.json"

    def json_payload():
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            raise ValueError("A JSON object is required")
        return value

    @app.route("/journal/<date>/commit", methods=["POST"])
    @app.route("/journal/<date>/autosave", methods=["POST"])
    def journal_autosave(date):
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify(ok=False, error="A journal document is required"), 400
        with lock:
            data = journal.load(journal_file())
            previous = journal.get_entry_by_date(data, date)
            previous_updated = previous.get("updated") if previous else None
            try:
                if request.path.endswith('/commit'):
                    tasks = todo.load(data_file())
                    entry = journal_commands.commit(data, tasks, date, payload, media.load(store_path()))
                    todo.save(data_file(), tasks)
                else:
                    entry = journal.autosave_entry(data, date, payload, media.load(store_path()))
                if request.path.endswith("/commit") or (entry and entry.get("updated") != previous_updated):
                    journal.save(journal_file(), data)
                task_ids = journal.linked_task_ids((entry or {}).get("body", ""))
                task_refs = todo.task_ref_index(todo.load(data_file()), task_ids) if task_ids else {}
                return jsonify(ok=True, entry=journal.entry_view(data, entry), sections=journal.active_sections(data),
                               calendar_entry=bool(journal.has_calendar_content(entry)), task_ref_index=task_refs)
            except journal.EntryConflictError as exc:
                return jsonify(ok=False, error="Entry changed elsewhere. Your draft is safe.", current=journal.entry_view(data, exc.current)), 409
            except (ValueError, TypeError, KeyError) as exc:
                return jsonify(ok=False, error=str(exc)), 400

    def state(device=None):
        with lock:
            data = media.load(store_path())
            if request.method == "POST":
                try:
                    result = media.apply_changes(data, json_payload().get("changes", []))
                    jdata = journal.load(journal_file())
                    journal.reconcile_photo_groups(jdata, data)
                    journal.save(journal_file(), jdata)
                    media.save(store_path(), data)
                except (ValueError, TypeError, KeyError) as exc:
                    return jsonify(ok=False, error=str(exc)), 400
            else:
                result = {"accepted": [], "conflicts": []}
            return jsonify({**data, "receipts": {}, **result})

    def upload(device=None):
        file = request.files.get("file")
        content = file.read(media.MAX_IMAGE_BYTES + 1) if file else request.stream.read(media.MAX_IMAGE_BYTES + 1)
        with lock:
            try:
                asset = media.import_image(root() / "media", content, file.filename if file else "phone photo")
                data = media.load(store_path())
                data["assets"].setdefault(asset["id"], asset)
                media.save(store_path(), data)
                return jsonify(ok=True, asset=data["assets"][asset["id"]]), 201
            except ValueError as exc:
                return jsonify(ok=False, error=str(exc)), 400

    def file(identity, variant, device=None):
        if not media.BLOB.fullmatch(identity) or variant not in ("original", "preview.webp", "thumb.webp"):
            abort(404)
        path = root() / "media" / identity / variant
        if not path.is_file():
            abort(404)
        asset = media.load(store_path())["assets"].get(identity, {})
        return send_file(path, mimetype=asset.get("mime") if variant == "original" else "image/webp",
                         conditional=True, etag=True, max_age=31536000)

    def tracking(device=None):
        with lock:
            try:
                if request.method == "POST":
                    accepted = places.append_samples(root() / "tracking", json_payload().get("samples", []))
                    return jsonify(ok=True, accepted=accepted)
                if request.args.get("manifest") == "1":
                    return jsonify(days=places.manifest(root() / "tracking"))
                start, end = request.args.get("from") or None, request.args.get("to") or None
                if any(value and not journal._valid_date(value) for value in (start, end)):
                    raise ValueError("Choose valid dates for location history")
                if start and end and start > end:
                    raise ValueError("The start date must come before the end date")
                data = media.load(store_path())
                if request.args.get("summary") == "1":
                    return jsonify(places.history_analytics(root() / "tracking", list(data["places"].values()), start, end))
                rows = places.load_samples(root() / "tracking", start, end)
                return jsonify(samples=rows, visits=places.visits(rows, list(data["places"].values())))
            except (ValueError, TypeError, KeyError) as exc:
                return jsonify(ok=False, error=str(exc)), 400

    @app.route("/journal/media/analytics")
    def media_analytics():
        data = journal.load(journal_file())
        return jsonify(media.photo_analytics(data["entries"], request.args.get("from"), request.args.get("to")))

    @app.route("/journal/media/entry/<date>")
    def media_entry(date):
        if not journal._valid_date(date):
            abort(400)
        data = journal.load(journal_file())
        return jsonify(entry=journal.entry_view(data, journal.get_entry_by_date(data, date)))

    @app.route("/journal/media/settings")
    def media_settings():
        return render_template("journal_media_settings.html")

    @app.get('/journal/media/discord/setup')
    def discord_setup():
        return render_template('journal_discord_setup.html')

    @app.get('/journal/media/discord/setup.md')
    def discord_setup_download():
        return send_file(ROOT / 'docs' / 'DISCORD_INBOX.md', mimetype='text/plain')

    @app.get('/journal/media/discord/status')
    def discord_status():
        return jsonify(discord_journal.status(discord_journal.load(root() / 'discord.json')))

    @app.post('/journal/media/discord/config')
    def discord_config():
        with lock:
            try:
                value = json_payload()
                data = discord_journal.load(root() / 'discord.json')
                discord_journal.configure(data, value.get('receiver_url', ''), value.get('receiver_token') or data.get('receiver_token'), value.get('application_id', ''))
                media.save(root() / 'discord.json', data)
                return jsonify(discord_journal.status(data))
            except (TypeError, ValueError) as exc:
                return jsonify(error=str(exc)), 400

    @app.post('/journal/media/discord/pull')
    def discord_pull():
        try:
            config = discord_journal.load(root() / 'discord.json')
            added = discord_journal.pull(root(), config, store_lock=lock)
            with lock:
                current = discord_journal.load(root() / 'discord.json')
                if all(current.get(field) == config.get(field) for field in ('receiver_url', 'receiver_token', 'application_id')):
                    current['last_sync'] = config['last_sync']
                    media.save(root() / 'discord.json', current)
            return jsonify(ok=True, added=added)
        except Exception as exc:
            return jsonify(error='Could not sync the Discord inbox: ' + str(exc)), 400

    def maps(device=None):
        try:
            if request.method == "POST":
                payload = json_payload()
                if payload.get("action") not in ("add", "download", "estimate"):
                    raise ValueError("Choose a valid map action")
                if payload.get("action") == "add":
                    map_packs.add_region(root() / "maps", payload.get("name"), payload.get("bounds"), identity=payload.get("id"))
                else:
                    map_packs.download(root() / "maps", payload.get("id"), estimate=payload.get("action") == "estimate")
            return jsonify(packs=map_packs.manifest(root() / "maps"))
        except (ValueError, TypeError) as exc:
            return jsonify(ok=False, error=str(exc)), 400

    def map_file(identity, device=None):
        try:
            with map_packs.readable_pack(root() / "maps", identity, request.args.get('v')) as path:
                return send_file(path, mimetype="application/octet-stream", conditional=True)
        except FileNotFoundError:
            abort(404)
        except map_packs.MapVersionChanged as exc:
            response = jsonify(ok=False, error={'code': 'map_version_changed', 'message': str(exc)})
            response.status_code = 409
            response.headers['X-Datapom-Error'] = 'map_version_changed'
            response.headers['Cache-Control'] = 'no-store'
            return response

    @app.route("/api/mobile/media/maps/file/<identity>")
    @mobile_authenticated
    def mobile_map_file(device, identity):
        return map_file(identity, device)

    app.add_url_rule("/journal/media/maps/file/<identity>", "media_map_file", map_file)

    for prefix, mobile in (("/journal/media", False), ("/api/mobile/media", True)):
        suffix = "_mobile" if mobile else "_web"
        app.add_url_rule(prefix + "/state", "media_state" + suffix,
                         mobile_authenticated(state) if mobile else state, methods=["GET", "POST"])
        app.add_url_rule(prefix + "/upload", "media_upload" + suffix,
                         mobile_authenticated(upload) if mobile else upload, methods=["POST"])
        if mobile:
            @mobile_authenticated
            def mobile_file(device, identity, variant):
                return file(identity, variant, device)
            view = mobile_file
        else:
            view = file
        app.add_url_rule(prefix + "/file/<identity>/<variant>", "media_file" + suffix, view)
        app.add_url_rule(prefix + "/tracking", "media_tracking" + suffix,
                         mobile_authenticated(tracking) if mobile else tracking, methods=["GET", "POST"])
        app.add_url_rule(prefix + "/maps", "media_maps" + suffix,
                         mobile_authenticated(maps) if mobile else maps, methods=["GET", "POST"])
