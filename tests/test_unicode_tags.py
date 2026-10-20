"""Unicode names round-trip through the same task, journal and media model."""
from datetime import datetime

import pytest

from datapom.domain import journal
from datapom.domain import journal_media
from datapom.domain import todo


NOW = datetime(2026, 9, 11, 12)


@pytest.mark.parametrize("name", ["中文", "小李", "北京.办公室", "团队 工作_２-Ⅳ", "Café", "𠀀朋友"])
def test_unicode_tag_names_survive_task_and_journal_round_trip(tmp_path, name):
    normalized = name.lower()
    tasks = todo._empty()
    todo.set_tag_color(tasks, f" {name} ", "#123456")
    todo.add_task(tasks, "Call", tags=[name], now=NOW)
    todo.save(str(tmp_path / "tasks.json"), tasks)
    loaded_tasks = todo.load(str(tmp_path / "tasks.json"))
    assert loaded_tasks["tags"] == {normalized: "#123456"}
    assert loaded_tasks["active"][0]["tags"] == [normalized]

    data = journal._empty()
    section = journal.add_section(data, "人物", "tag", "#123456")
    journal.add_section_tag(data, section["id"], f" {name} ")
    journal.upsert_entry(data, "2026-09-11", "Today", "",
                         tags={section["id"]: [name]}, now=NOW)
    journal.save(str(tmp_path / "journal.json"), data)
    loaded = journal.load(str(tmp_path / "journal.json"))
    assert loaded["sections"][0]["tags"] == [normalized]
    assert loaded["entries"][0]["tags"][section["id"]] == [normalized]


@pytest.mark.parametrize("bad", [
    "x\ny", "x\ty", "x\x00y", "x\u200by", "x\u202ey", "x\u00a0y",
    "<中文>", "中文;", "中文/朋友", "中文，朋友", "中文💛", "cafe\u0301",
])
def test_unicode_tag_policy_rejects_other_characters(bad):
    assert todo._TAG_NAME_RE.fullmatch(bad) is None
    data = todo._empty()
    with pytest.raises(ValueError):
        todo.set_tag_color(data, bad, "#123456")
    assert data == todo._empty()
    journal_data = journal._empty()
    section = journal.add_section(journal_data, "people", "tag", "#123456")
    with pytest.raises(ValueError):
        journal.add_section_tag(journal_data, section["id"], bad)
    assert section["tags"] == []


def test_normalized_tag_validator_requires_full_match():
    assert not journal._valid_name("work\n")
    assert todo._TAG_NAME_RE.fullmatch("work\n") is None


@pytest.mark.parametrize("body,expected", [
    ("和 @小李 去 @北京.办公室。", {"s": ["小李", "北京.办公室"]}),
    ("@团队_工作 @小李 @小李", {"s": ["团队 工作", "小李"]}),
    ("中文@小李 a@北京.办公室", {}),
    ("@work中文 @小李同学", {}),
    ("__@小李__ @__中文__", {"s": ["小李", "__中文__"]}),
    ("@CAFÉ @𠀀朋友", {"s": ["café", "𠀀朋友"]}),
])
def test_unicode_mentions_capture_whole_names_and_preserve_boundaries(body, expected):
    index = {name: "s" for name in ["小李", "北京.办公室", "团队 工作", "work", "__中文__", "café", "𠀀朋友"]}
    assert journal.extract_mentions(body, index) == expected


def test_unicode_numeric_capture_and_task_inheritance():
    assert journal.extract_numbers("__#体重 65__ #睡眠_时长 8", {"体重": "w", "睡眠 时长": "s"}) == {"w": 65, "s": 8}
    tasks = journal.extract_task_lines("[] 联系 @小李 >tomorrow", {"小李": "people"}, todo.parse_due_token, now=NOW)
    assert tasks[0]["tags"] == ["小李"]
    assert tasks[0]["due"] == "2026-09-12T23:59:00"


def test_unicode_title_cleanup_uses_complete_inline_tokens():
    assert journal.suggest_entry_title("和 @小李 在 @北京.办公室 #体重 65") == "和 小李 在 北京.办公室 体重 65"
    assert journal.suggest_entry_title("Email a@例子.com and @小李") == "Email a@例子.com and 小李"


def test_chinese_photo_tags_share_to_journal_without_loss(tmp_path):
    data = journal_media._empty()
    journal_media.apply_changes(data, [{"op_id": "chinese-tags", "kind": "groups", "id": "people", "base_rev": 0,
                                       "patch": {"tags": ["小李", "团队 工作"]}}], now=NOW)
    document = journal_media.validate_document([{"id": "photo", "type": "photo", "asset_id": "a" * 64,
                                                 "tags": {"people": ["小李", "团队 工作"]}}])
    journal_media.save(tmp_path / "media.json", data)
    loaded = journal_media.load(tmp_path / "media.json")
    assert loaded["groups"]["people"]["tags"] == ["小李", "团队 工作"]
    assert journal_media.shared_tags(document, loaded, [{"id": "s", "name": "people", "type": "tag"}]) == {
        "s": ["团队 工作", "小李"]}


def test_explicit_suggestion_occurrences_respect_unicode_word_boundaries():
    data = journal._empty()
    for day, body in [("2026-09-11", "小李 来了"), ("2026-09-10", "小李同学 来了"),
                      ("2026-09-09", "中文work中文"), ("2026-09-08", "_work_")]:
        journal.upsert_entry(data, day, "Entry", body, now=NOW)
    assert [row["date"] for row in journal.suggestion_occurrences(data, "小李", now=NOW)] == ["2026-09-11"]
    # Preserve existing ASCII delimiter behavior; only surrounding letters and
    # numbers become Unicode-aware, not the automatic word tokenizer.
    assert [row["date"] for row in journal.suggestion_occurrences(data, "work", now=NOW)] == ["2026-09-08"]
