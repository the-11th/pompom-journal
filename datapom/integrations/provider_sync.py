"""Provider fetches over snapshots, with pure reconciliation into current stores.

No Flask or filesystem access. HTTP adapters own transaction boundaries;
provider clients retain their injectable transports for tests.
"""
from copy import deepcopy
from datetime import datetime

from . import google_health
from . import store as integrations
from datapom.domain import journal
from . import rescuetime
from . import spotify


def same_connection(before, current, provider):
    """Reject stale results after disconnecting or replacing credentials."""
    if not integrations.is_connected(current, provider):
        return False
    old = integrations.get_provider(before, provider)
    latest = integrations.get_provider(current, provider)
    keys = ('api_key',) if provider == 'rescuetime' else ('client_id', 'client_secret')
    if any(old.get(key) != latest.get(key) for key in keys):
        return False
    if provider != 'rescuetime':
        def credential(value):
            tokens = value.get('tokens') or {}
            return tokens.get('refresh_token') or tokens.get('access_token')
        if credential(old) != credential(latest):
            return False
    return True


def spotify_analytics(istore, now=None):
    """Fetch a partial snapshot without turning unavailable sections into empties."""
    current = deepcopy(integrations.get_analytics(istore, 'spotify'))
    connected = integrations.is_connected(istore, 'spotify')
    result = {'ok': True, 'connected': connected, 'analytics': current,
              'errors': [], 'updated': []}
    if not connected:
        return result
    provider = integrations.get_provider(istore, 'spotify')
    tokens = provider.get('tokens') or {}
    token_now = now.timestamp() if now is not None else None
    if (spotify.token_expired(tokens, now=token_now) and tokens.get('refresh_token')
            and provider.get('client_id')):
        try:
            tokens = spotify.refresh_tokens(provider['client_id'], provider.get('client_secret'),
                tokens['refresh_token'], prev=tokens, now=token_now)
            integrations.set_tokens(istore, 'spotify', tokens)
        except Exception as exc:  # noqa: BLE001 - keep the last usable snapshot
            return {**result, 'ok': False, 'errors': [f'Connection refresh: {exc}']}

    fields = [
        ('playback', spotify.fetch_playback_state, spotify.parse_playback_state),
        ('queue', spotify.fetch_queue, spotify.parse_queue),
        ('devices', spotify.fetch_devices, spotify.parse_devices),
        ('saved_tracks', spotify.fetch_saved_tracks, spotify.parse_saved_tracks),
        ('saved_albums', spotify.fetch_saved_albums, spotify.parse_saved_albums),
        ('saved_episodes', spotify.fetch_saved_episodes, spotify.parse_saved_episodes),
        ('playlists', spotify.fetch_current_user_playlists, spotify.parse_playlists),
        ('followed_artists', spotify.fetch_followed_artists, spotify.parse_followed_artists),
    ]
    for label, fetch, parse in fields:
        try:
            value = parse(fetch(tokens['access_token']))
        except Exception as exc:  # noqa: BLE001 - other sections can still refresh
            result['errors'].append(f'{label}: {exc}')
        else:
            target = current.setdefault('library', {}) if label.startswith('saved_') else current
            target[label] = value
            result['updated'].append(label)
    result['ok'] = not result['errors']
    if result['ok']:
        current['fetched'] = (now or datetime.now()).replace(microsecond=0).isoformat()
    integrations.set_analytics(istore, 'spotify', current)
    return result


def reconcile_spotify_analytics(initial, fetched, current, result):
    """Apply fetched sections only if their stored baseline is still current."""
    before = integrations.get_analytics(initial, 'spotify')
    latest = deepcopy(integrations.get_analytics(current, 'spotify'))
    values = integrations.get_analytics(fetched, 'spotify')
    errors = list(result['errors'])
    for label in result['updated']:
        old = before.get('library') or {} if label.startswith('saved_') else before
        new = values.get('library') or {} if label.startswith('saved_') else values
        target = latest.setdefault('library', {}) if label.startswith('saved_') else latest
        if target.get(label) not in (old.get(label), new.get(label)):
            errors.append(f'{label}: A newer snapshot is already saved')
        else:
            target[label] = deepcopy(new.get(label))
    if not errors:
        latest['fetched'] = values.get('fetched')
    integrations.set_analytics(current, 'spotify', latest)
    old_provider, fetched_provider, current_provider = [integrations.get_provider(data, 'spotify')
                                                       for data in (initial, fetched, current)]
    if current_provider.get('tokens') == old_provider.get('tokens'):
        current_provider['tokens'] = deepcopy(fetched_provider.get('tokens'))
    return {'ok': not errors, 'connected': True, 'analytics': latest, 'errors': errors}


def reconcile(provider, initial_integrations, fetched_integrations, current_integrations,
              initial_journal, fetched_journal, current_journal, result, now=None):
    """Apply only this provider's fields to the latest local entry and credentials."""
    field, setter = {'google': ('sleep', journal.set_entry_sleep),
                     'rescuetime': ('rescuetime', journal.set_entry_rescuetime),
                     'spotify': ('music', journal.set_entry_music)}[provider]
    def provider_value(row):
        if provider == 'spotify' and (row or {}).get('music_history'):
            return (row or {}).get('music_live')
        return (row or {}).get(field)

    skipped = set()
    for entry in fetched_journal.get('entries', []):
        day = entry['date']; value = provider_value(entry)
        before = journal.get_entry_by_date(initial_journal, day)
        if value == provider_value(before):
            continue
        current = journal.get_entry_by_date(current_journal, day)
        current_value = provider_value(current)
        if (provider == 'spotify' and not (before or {}).get('music_history')
                and (current or {}).get('music_history') and current_value is None
                and current.get('music_legacy') == (before or {}).get('music')):
            # A concurrent first receipt-backed import moved the old displayed
            # summary into music_legacy. The API baseline did not change.
            current_value = provider_value(before)
        if before is not None and current is None:
            skipped.add(day)  # Preserve a deletion made while the request waited.
        elif current_value not in (value, provider_value(before)):
            skipped.add(day)  # A newer provider result already reached this date.
        elif current_value != value:
            setter(current_journal, day, deepcopy(value), now=now)
    if provider == 'google':
        for entry in current_journal.get('entries', []):
            if entry.get('sleep'):
                journal.apply_sleep_metrics(current_journal, entry['date'], entry['sleep'], now=now)

    before = integrations.get_provider(initial_integrations, provider)
    fetched = integrations.get_provider(fetched_integrations, provider)
    current = integrations.get_provider(current_integrations, provider)
    for key in ('tokens', 'last_sync', 'taste', 'plays_buffer'):
        if fetched.get(key) == before.get(key):
            continue
        if key == 'plays_buffer' and current.get(key) != before.get(key):
            plays = [play for day in (fetched.get(key) or {}).values() for play in day.values()]
            current[key] = spotify.merge_plays(current.get(key) or {}, plays, now=now)
        elif current.get(key) == before.get(key):
            if key in fetched:
                current[key] = deepcopy(fetched[key])
            else:
                current.pop(key, None)
    return {**result, 'synced': [day for day in result['synced'] if day not in skipped]}


def google_sync(istore, jdata, days=7, force=False, focus_date=None, now=None):
    token_now = now.timestamp() if now is not None else None
    if not integrations.is_connected(istore, "google"):
        return {"connected": False, "synced": [], "errors": []}
    gh = integrations.get_provider(istore, "google")
    tokens = gh["tokens"]
    cid, csecret = gh.get("client_id"), gh.get("client_secret")

    if google_health.token_expired(tokens, now=token_now) and tokens.get("refresh_token") and cid:
        try:
            tokens = google_health.refresh_tokens(cid, csecret, tokens["refresh_token"], prev=tokens, now=token_now)
            integrations.set_tokens(istore, "google", tokens)
        except Exception:  # noqa: BLE001
            pass

    # Backfill managed sleep-metric numeric sections from already-synced days
    # (the per-date `entry.sleep` guard below skips them). Idempotent — no
    # timestamp churn on repeated syncs. The single save at the end persists it.
    for entry in jdata.get("entries", []):
        if entry.get("sleep"):
            journal.apply_sleep_metrics(jdata, entry["date"], entry["sleep"], now=now)
    synced, errors = [], []
    today = (now or datetime.now()).date().isoformat()
    for date in integrations.sync_dates(days, focus_date=focus_date, now=now):
        existing = journal.get_entry_by_date(jdata, date)
        if not force and date != today and existing is not None and existing.get("sleep"):
            continue
        try:
            try:
                raw = google_health.fetch_sleep(tokens["access_token"], date)
            except PermissionError:
                if cid and tokens.get("refresh_token"):
                    tokens = google_health.refresh_tokens(cid, csecret, tokens["refresh_token"], prev=tokens, now=token_now)
                    integrations.set_tokens(istore, "google", tokens)
                    raw = google_health.fetch_sleep(tokens["access_token"], date)
                else:
                    raise
            sleep = google_health.parse_sleep(raw, now=now)
            if sleep:
                journal.set_entry_sleep(jdata, date, sleep, now=now)
                journal.apply_sleep_metrics(jdata, date, sleep, now=now)
                synced.append(date)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{date}: {exc}")

    if not errors:
        integrations.set_last_sync(istore, "google",
                                   (now or datetime.now()).replace(microsecond=0).isoformat())
    return {"connected": True, "synced": synced, "errors": errors}


def spotify_sync(istore, jdata, force=False, focus_date=None, now=None):
    token_now = now.timestamp() if now is not None else None
    if not integrations.is_connected(istore, "spotify"):
        return {"connected": False, "synced": [], "errors": []}
    sp = integrations.get_provider(istore, "spotify")
    tokens = sp["tokens"]
    cid, csecret = sp.get("client_id"), sp.get("client_secret")
    errors = []

    if spotify.token_expired(tokens, now=token_now) and tokens.get("refresh_token") and cid:
        try:
            tokens = spotify.refresh_tokens(cid, csecret, tokens["refresh_token"], prev=tokens, now=token_now)
            integrations.set_tokens(istore, "spotify", tokens)
        except Exception:  # noqa: BLE001
            pass

    def _recent():
        try:
            return spotify.fetch_recently_played(tokens["access_token"])
        except PermissionError:
            if cid and tokens.get("refresh_token"):
                new = spotify.refresh_tokens(cid, csecret, tokens["refresh_token"], prev=tokens, now=token_now)
                tokens.update(new)
                integrations.set_tokens(istore, "spotify", tokens)
                return spotify.fetch_recently_played(tokens["access_token"])
            raise

    synced = []
    try:
        plays = spotify.parse_recently_played(_recent())
        buffer = spotify.merge_plays(
            integrations.get_plays_buffer(istore, "spotify"), plays, now=now)
        integrations.set_plays_buffer(istore, "spotify", buffer)
        for date, by_ts in buffer.items():
            day_plays = list(by_ts.values())
            ids = [p["track_id"] for p in day_plays if p.get("track_id")]
            try:
                feats = spotify.fetch_audio_features(tokens["access_token"], ids)
            except Exception as exc:  # noqa: BLE001
                feats, _ = None, errors.append(f"features {date}: {exc}")
            journal.set_entry_music(jdata, date, spotify.summarize_day(day_plays, feats, now=now), now=now)
            synced.append(date)
    except Exception as exc:  # noqa: BLE001
        errors.append(str(exc))

    # Taste snapshot (best-effort).
    try:
        terms = ("short_term", "medium_term", "long_term")
        tops = {"tracks": {}, "artists": {}}
        for kind in ("tracks", "artists"):
            for term in terms:
                tops[kind][term] = spotify.fetch_top(tokens["access_token"], kind, term)
        integrations.set_taste(istore, "spotify", spotify.build_taste(tops, now=now))
    except Exception as exc:  # noqa: BLE001
        errors.append(f"taste: {exc}")

    if not errors:
        integrations.set_last_sync(istore, "spotify",
                                   (now or datetime.now()).replace(microsecond=0).isoformat())
    return {"connected": True, "synced": synced, "errors": errors}


def rescuetime_sync(istore, jdata, force=False, focus_date=None, now=None):
    """Full daily activity snapshots, including today and an opened older day."""
    if not integrations.is_connected(istore, "rescuetime"):
        return {"connected": False, "synced": [], "errors": []}
    key = integrations.get_provider(istore, "rescuetime").get("api_key")
    synced, errors = [], []
    stamp = now or datetime.now()
    today = stamp.date().isoformat()
    feed = {}
    try:
        for row in rescuetime.fetch_daily_summary(key):
            if isinstance(row, dict) and journal._valid_date(row.get("date")):
                feed[row["date"]] = row
    except Exception as exc:
        errors.append(f"Daily summaries: {exc}")
    dates = list(feed)
    for date in (today, focus_date):
        if date and date <= today and date not in dates:
            dates.append(date)
    for date in dates:
        previous = (journal.get_entry_by_date(jdata, date) or {}).get("rescuetime") or {}
        # Revisit yesterday to finalize a previously partial current-day snapshot.
        recent = (stamp.date() - datetime.fromisoformat(date).date()).days <= 1
        refresh_summary = force or recent or not previous or previous.get("summary_source") == "activities"
        refresh_activities = force or recent or date == focus_date or previous.get("activity_version") != 2
        value = deepcopy(previous)
        if date in feed and refresh_summary:
            value.update(rescuetime.parse_day(feed[date], now=stamp))
            value["summary_source"] = "daily_feed"
        if refresh_activities:
            try:
                activities = rescuetime.parse_activities(rescuetime.fetch_activities(key, date))
                if date not in feed:
                    # Empty newly requested days do not create phantom journal entries.
                    if not activities and not previous:
                        continue
                    if not previous or previous.get("summary_source") == "activities" or date == today:
                        value.update(rescuetime.activity_summary(date, activities, now=stamp))
                value.update(top_activities=activities, activity_version=2,
                             activities_fetched=stamp.replace(microsecond=0).isoformat())
            except Exception as exc:
                errors.append(f"{date} activities: {exc}")
        if value and value != previous:
            journal.set_entry_rescuetime(jdata, date, value, now=stamp)
            synced.append(date)
    if not errors:
        integrations.set_last_sync(istore, "rescuetime", stamp.replace(microsecond=0).isoformat())
    return {"connected": True, "synced": synced, "errors": errors}


def rescuetime_detail(istore, date, force=False, now=None):
    """Independent report snapshots; failed sections retain their last usable rows."""
    if not journal._valid_date(date):
        raise ValueError("Choose a valid report date")
    if not integrations.is_connected(istore, "rescuetime"):
        return {"ok": True, "connected": False, "date": date, "reports": {}}
    stamp = (now or datetime.now()).replace(microsecond=0)
    current = deepcopy(integrations.get_analytics(istore, "rescuetime"))
    days = current.get("days") if isinstance(current.get("days"), dict) else {}
    saved = days.get(date) or {}
    try:
        age = (stamp - datetime.fromisoformat(saved.get("checked", ""))).total_seconds()
    except (TypeError, ValueError):
        age = -1
    if not force and 0 <= age < 3600:
        return {"ok": True, "connected": True, "date": date, "reports": saved.get("reports", {})}
    reports = deepcopy(saved.get("reports") or {})
    key = integrations.get_provider(istore, "rescuetime")["api_key"]
    for name, fetch, parse in [("activities", rescuetime.fetch_activities, rescuetime.parse_activities),
                               ("hourly", rescuetime.fetch_hourly, rescuetime.parse_hourly),
                               ("documents", rescuetime.fetch_documents, rescuetime.parse_documents)]:
        previous = reports.get(name) or {}
        try:
            raw = fetch(key, date)
            rescuetime.validate_report(raw)
            rows = parse(raw)
            if name == "hourly":
                rows = [row for row in rows if row["date"] == date]
            reports[name] = {"status": "ok", "rows": rows, "fetched": stamp.isoformat()}
        except Exception as exc:
            unavailable = isinstance(exc, rescuetime.RescueTimeError) and exc.status == 403
            reports[name] = {**previous, "rows": previous.get("rows", []),
                             "status": "unavailable" if unavailable else "error",
                             "message": str(exc) if isinstance(exc, (rescuetime.RescueTimeError, ValueError))
                                        else "Could not refresh this report. Try again."}
    days[date] = {"checked": stamp.isoformat(), "reports": reports}
    # Bounded detail cache: full historical daily totals stay in the journal.
    current["days"] = dict(sorted(days.items(), key=lambda pair: pair[1].get("checked", ""))[-31:])
    integrations.set_analytics(istore, "rescuetime", current)
    return {"ok": True, "connected": True, "date": date, "reports": reports}
