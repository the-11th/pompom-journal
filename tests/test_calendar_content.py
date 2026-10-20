from datetime import datetime

import pytest
import journal
import places


@pytest.mark.parametrize('content', [
    {'body': 'A walk'}, {'title': 'Good day'}, {'audio_transcript': 'A voice note'},
    {'tags': {'people': ['alex']}},
    {'document': [{'type': 'photo', 'asset_id': 'photo'}]},
    {'document': [{'type': 'message', 'message_id': 'note'}]},
])
def test_calendar_dot_requires_written_tagged_or_attached_content(content):
    entry = {'date': '2026-09-10', 'title': '2026-09-10', 'body': '', **content}
    assert journal.has_calendar_content(entry)


@pytest.mark.parametrize('content', [
    {}, {'body': ' \n', 'tags': {'people': [' ']}}, {'mood': 5},
    {'numbers': {'weight': 70}}, {'location': {'lat': 31, 'lon': 121}},
    {'usage': {'total_seconds': 300}}, {'document': [{'type': 'text', 'text': ''}]},
])
def test_automatic_data_and_other_metrics_do_not_mark_calendar(content):
    entry = {'date': '2026-09-10', 'title': '2026-09-10', 'body': '', **content}
    assert not journal.has_calendar_content(entry)


def test_calendar_dates_do_not_change_syncable_or_stored_dates(tmp_path):
    data = journal._empty()
    now = datetime(2026, 9, 12, 13)
    section = journal.add_section(data, 'weight', 'numeric', '#123456')
    journal.upsert_entry(data, '2026-09-08', '2026-09-08', '', mood=5, now=now)
    journal.upsert_entry(data, '2026-09-09', '2026-09-09', '', numbers={section['id']: 70}, now=now)
    journal.upsert_entry(data, '2026-09-10', '2026-09-10', 'A walk', now=now)
    journal.upsert_entry(data, '2026-09-11', '2026-09-11', '', now=now)
    places.append_samples(tmp_path/'tracking', [{'id': 'gps', 'at': '2026-09-12T12:00:00+08:00', 'lat': 31, 'lon': 121}], now=now)
    assert journal.calendar_dates(data) == ['2026-09-10']
    assert journal.entry_dates(data) == ['2026-09-08', '2026-09-09', '2026-09-10']
    assert journal.stored_entry_dates(data) == ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']
    assert len(places.load_samples(tmp_path/'tracking')) == 1
