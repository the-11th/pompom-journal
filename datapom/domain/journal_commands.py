"""Explicit journal saves, including idempotent inline task creation."""
import hashlib
from datetime import datetime
import json
from datapom.domain import journal
from datapom.domain import journal_media
from datapom.domain import todo


def commit(data, task_data, date, payload, media_data, now=None):
    entry = journal.autosave_entry(data, date, payload, media_data, now=now)
    if entry is None:
        return None
    new_tags = payload.get('new_tags', [])
    if not isinstance(new_tags, list) or any(not isinstance(tag, dict) for tag in new_tags):
        raise ValueError('Invalid new tags')
    for tag in new_tags:
        name = journal_media._text(tag.get('name', ''), 200)
        if tag.get('kind') == 'permanent' and name.strip():
            journal.add_section_tag(data, tag.get('section_id'), tag['name'])
    previous_body = entry['body']
    index = journal.tag_section_index(data)
    blocks = entry.get('document')
    text_blocks = [b for b in blocks if b['type'] == 'text'] if blocks is not None else [{'text': entry['body']}]
    for block in text_blocks:
        before = block['text']
        lines = journal.extract_task_lines(before, index, todo.parse_due_token, now=now)
        raw_lines = [m.group(0) for m in journal._TASK_FRESH_RE.finditer(before) if journal.extract_task_lines(m.group(0), index, todo.parse_due_token, now=now)]
        ids = []
        for number, line in enumerate(lines):
            fingerprint = hashlib.sha256(json.dumps([date, payload.get('base_updated'), block.get('id', 'body'), number, raw_lines[number]], sort_keys=True, default=str).encode()).hexdigest()
            existing = next((task for area in ('active', 'archive', 'expired') for task in task_data.get(area, []) if task.get('journal_source') == fingerprint), None)
            if existing:
                ids.append(existing['id'])
                continue
            try:
                todo.add_task(task_data, line['title'], due=line['due'], tags=line['tags'], now=now)
                task_data['active'][-1]['journal_source'] = fingerprint
                ids.append(task_data['active'][-1]['id'])
            except ValueError:
                ids.append(None)
        block['text'] = journal.rewrite_task_lines(before, ids)
        if block.get('links') and before != block['text']:
            block['links'] = journal_media.rebase_links(before, block['text'], block['links'])
    entry['body'] = journal_media.document_body(blocks) if blocks is not None else text_blocks[0]['text']
    if entry['body'] != previous_body:
        entry['updated'] = (now or datetime.now()).isoformat()
    return entry
