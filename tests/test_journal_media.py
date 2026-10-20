"""Media contracts: durable metadata, document integrity, and conflict safety."""
from datetime import datetime
import copy
import io
import pytest
import journal_media as media

NOW = datetime(2026, 9, 8, 12)


@pytest.mark.parametrize("kind,field,bad", [
    ("places", "archived", "false"), ("places", "is_city", 0),
    ("groups", "share_entry", "false"), ("groups", "archived", []),
    ("assets", "is_sticker", "true"),
    ("messages", "hidden", "false"), ("messages", "imported", 1),
    ("messages", "caption", {"body": "text"}),
    ("messages", "date", "2026-02-30"), ("messages", "date", "2026-9-08"),
    ("messages", "date", None),
])
def test_malformed_metadata_field_rejects_whole_batch(kind, field, bad):
    data = media._empty()
    data[kind]["target"] = {"id": "target", "rev": 0, "name": "Kept", "lat": 1, "lon": 2}
    before = copy.deepcopy(data)
    with pytest.raises(ValueError):
        media.apply_changes(data, [
            {"op_id": "first", "kind": "groups", "id": "new", "base_rev": None,
             "patch": {"name": "Should not be saved"}},
            {"op_id": "bad", "kind": kind, "id": "target", "base_rev": 0, "patch": {field: bad}},
        ], now=NOW)
    assert data == before


def test_photo_tag_groups_migrate_and_keep_permanent_tags(tmp_path):
    path = tmp_path / "media.json"
    data = media._empty()
    del data["groups"]["people"]["tags"]
    media.save(path, data)
    data = media.load(path)
    assert data["groups"]["people"]["tags"] == []
    media.apply_changes(data, [{"op_id": "tags", "kind": "groups", "id": "people",
                               "base_rev": 0, "patch": {"tags": [" Alex ", "alex", "小李"]}}], now=NOW)
    media.save(path, data)
    assert media.load(path)["groups"]["people"]["tags"] == ["alex", "小李"]
    media.apply_changes(data, [{"op_id": "demote", "kind": "groups", "id": "people",
                               "base_rev": 1, "patch": {"tags": ["小李"]}}], now=NOW)
    assert data["groups"]["people"]["tags"] == ["小李"]


@pytest.mark.parametrize("names", ["alex", [12], ["x" * 101]])
def test_invalid_permanent_photo_tags_do_not_change_store(names):
    data = media._empty()
    before = copy.deepcopy(data)
    with pytest.raises(ValueError):
        media.apply_changes(data, [{"op_id": "tags", "kind": "groups", "id": "people",
                                   "base_rev": 0, "patch": {"tags": names}}], now=NOW)
    assert data == before


@pytest.mark.parametrize("format", ["JPEG", "PNG", "WEBP"])
@pytest.mark.parametrize("lat_ref,lon_ref,sign", [("N", "E", 1), ("S", "W", -1)])
def test_upload_automatically_extracts_photo_gps(tmp_path, format, lat_ref, lon_ref, sign):
    from PIL import Image
    from PIL.TiffImagePlugin import IFDRational
    exif = Image.Exif()
    exif[34853] = {1: lat_ref, 2: tuple(map(IFDRational, [31, 12, 30])),
                   3: lon_ref, 4: tuple(map(IFDRational, [121, 30, 15]))}
    buf = io.BytesIO()
    Image.new("RGB", (24, 12)).save(buf, format=format, exif=exif)
    asset = media.import_image(tmp_path, buf.getvalue(), now=NOW)
    assert asset["location"]["lat"] == pytest.approx(sign * (31 + 12 / 60 + 30 / 3600))
    assert asset["location"]["lon"] == pytest.approx(sign * (121 + 30 / 60 + 15 / 3600))
    assert asset["original_location"] == asset["location"]
    assert (tmp_path / asset["original"]).read_bytes() == buf.getvalue()


def test_forgiving_store_and_atomic_round_trip(tmp_path):
    path = tmp_path / "media.json"
    data = media.load(path)
    assert next(g for g in data["groups"].values() if g["name"] == "people")["share_entry"]
    media.save(path, data)
    assert media.load(path) == data
    path.write_text('{"assets":{}}')
    assert media.load(path)["places"] == {}
    path.write_text("broken")
    assert media.load(path)["assets"] == {}
    assert path.with_suffix(".json.bak").exists()


def test_image_import_preserves_original_and_is_content_addressed(tmp_path):
    from PIL import Image
    buf = io.BytesIO()
    exif = Image.Exif()
    exif[36867] = "2026:09:07 23:14:05"
    Image.new("RGB", (320, 160)).save(buf, format="JPEG", exif=exif)
    original = buf.getvalue()
    first = media.import_image(tmp_path, original, "test.jpg", now=NOW)
    second = media.import_image(tmp_path, original, "renamed.jpg", now=NOW)
    assert first["id"] == second["id"]
    assert first["captured_at"] == "2026-09-07T23:14:05"
    assert first["location"] is None
    assert (tmp_path / first["original"]).read_bytes() == original
    assert (tmp_path / first["preview"]).exists()


def test_non_image_upload_rejected(tmp_path):
    with pytest.raises(ValueError):
        media.import_image(tmp_path, b"<script>alert(1)</script>", "photo.jpg", now=NOW)
    assert not list(tmp_path.rglob("*.jpg"))


def test_heic_import_keeps_original_and_capture_metadata(tmp_path):
    from PIL import Image
    import pillow_heif
    photo = Image.new("RGB", (96, 64), "orange")
    exif = Image.Exif()
    exif[36867] = "2026:09:07 13:14:05"
    photo.info["exif"] = exif.tobytes()
    encoded = io.BytesIO()
    pillow_heif.from_pillow(photo).save(encoded, quality=90)
    original = encoded.getvalue()

    asset = media.import_image(tmp_path, original, "Samsung.heic", now=NOW)

    assert asset["captured_at"] == "2026-09-07T13:14:05"
    assert (asset["width"], asset["height"]) == (96, 64)
    assert (tmp_path / asset["original"]).read_bytes() == original
    assert Image.open(tmp_path / asset["preview"]).size == (96, 64)


def test_document_projection_keeps_quotes_and_captions_out_of_authored_body():
    doc = [{"id": "text-1", "type": "text", "text": "My day @alex"},
           {"id": "photo-1", "type": "photo", "asset_id": "a" * 64,
            "caption": "@sam", "tags": {"people": ["sam"]}},
           {"id": "message-1", "type": "message", "message_id": "123", "caption": "[] not a task"}]
    clean = media.validate_document(doc)
    assert media.document_body(clean) == "My day @alex"
    assert clean[1]["caption_visible"] is True


@pytest.mark.parametrize("doc", [
    [{"id": "x", "type": "text", "text": "a"}, {"id": "x", "type": "text", "text": "b"}],
    [{"id": "x", "type": "iframe", "src": "https://example.com"}],
    [{"id": "x", "type": "photo", "asset_id": "../../private"}],
    [{"id": "x", "type": "text", "text": "abc", "links": [{"start": 0, "end": 8, "photos": ["x"]}]}],
])
def test_invalid_document_rejected(doc):
    with pytest.raises(ValueError):
        media.validate_document(doc)


def test_alias_change_does_not_move_photo():
    data = media._empty()
    identity = "a" * 64
    data["assets"][identity] = {"id": identity, "rev": 0, "location": {"lat": 31.2, "lon": 121.5}}
    media.apply_changes(data, [{"op_id": "label", "kind": "assets", "id": identity,
                               "base_rev": 0, "patch": {"location_label": "my favourite café"}}], now=NOW)
    assert data["assets"][identity]["location"] == {"lat": 31.2, "lon": 121.5}
    assert data["assets"][identity]["location_label"] == "my favourite café"


def test_mutations_are_idempotent_and_conflicts_preserve_both_versions():
    data = media._empty()
    change = {"op_id": "p1", "kind": "places", "id": "home", "base_rev": None,
              "patch": {"name": "Home", "lat": 31.2, "lon": 121.5, "radius_m": 100}}
    result = media.apply_changes(data, [change], now=NOW)
    again = media.apply_changes(data, [change], now=NOW)
    assert result["accepted"] == again["accepted"] == ["p1"]
    before = copy.deepcopy(data)
    stale = {**change, "op_id": "p2", "patch": {**change["patch"], "name": "Stale"}}
    conflict = media.apply_changes(data, [stale], now=NOW)
    assert conflict["conflicts"][0]["current"]["name"] == "Home"
    assert data == before


def test_invalid_coordinate_is_not_saved():
    data = media._empty()
    with pytest.raises(ValueError):
        media.apply_changes(data, [{"op_id": "p", "kind": "places", "id": "bad", "base_rev": None,
                                   "patch": {"name": "bad", "lat": float("nan"), "lon": 0}}], now=NOW)
    assert data["places"] == {}


def test_starred_places_default_and_survive_edits_and_round_trip(tmp_path):
    path = tmp_path / "media.json"
    data = media._empty()
    media.apply_changes(data, [{"op_id": "new", "kind": "places", "id": "cafe", "base_rev": None,
                               "patch": {"name": "Café", "lat": 31.2, "lon": 121.5}}], now=NOW)
    assert data["places"]["cafe"]["starred"] is False
    media.apply_changes(data, [{"op_id": "star", "kind": "places", "id": "cafe", "base_rev": data["places"]["cafe"]["rev"],
                               "patch": {"starred": True}}], now=NOW)
    media.apply_changes(data, [{"op_id": "rename", "kind": "places", "id": "cafe", "base_rev": data["places"]["cafe"]["rev"],
                               "patch": {"name": "Favourite café"}}], now=NOW)
    media.save(path, data)
    assert media.load(path)["places"]["cafe"]["starred"] is True
    del data["places"]["cafe"]["starred"]
    media.save(path, data)
    assert media.load(path)["places"]["cafe"]["starred"] is False


@pytest.mark.parametrize("starred", ["false", "true", 0, 1, None, []])
def test_place_star_must_be_a_boolean(starred):
    data = media._empty()
    with pytest.raises(ValueError, match="star"):
        media.apply_changes(data, [{"op_id": "star", "kind": "places", "id": "cafe", "base_rev": None,
                                   "patch": {"name": "Café", "lat": 31.2, "lon": 121.5, "starred": starred}}], now=NOW)
    assert data["places"] == {}


def test_nonfinite_edit_layers_are_rejected_before_mutating_metadata():
    data = media._empty()
    data['assets']['a'*64] = {'id':'a'*64, 'rev':0}
    before = copy.deepcopy(data)
    with pytest.raises(ValueError):
        media.apply_changes(data, [{'op_id':'edit', 'kind':'assets', 'id':'a'*64,
                                    'base_rev':0, 'patch':{'edit_layers':{'x':float('nan')}}}], now=NOW)
    assert data == before


def test_shared_photo_tags_are_derived_without_destroying_manual_tags():
    data = media._empty()
    sections = [{"id": "jpeople", "name": "people", "type": "tag"}]
    doc = [{"id": "photo", "type": "photo", "asset_id": "a" * 64,
            "tags": {"people": ["Alex"], "foods": ["noodles"]}}]
    assert media.shared_tags(doc, data, sections) == {"jpeople": ["alex"]}
    assert media.shared_tags([], data, sections) == {}


def test_photo_references_resolve_block_ids_without_phantom_photos():
    photo = {"id": "photo-block", "type": "photo", "asset_id": "a" * 64}
    linked = {"id": "text", "type": "text", "text": "Photo", "links": [
        {"start": 0, "end": 5, "photos": ["photo-block"]}]}
    assert media.photo_references([linked, photo]) == [photo]


def test_photo_analytics_deduplicates_references_and_filters_dates():
    photo = {"id": "p", "type": "photo", "asset_id": "a" * 64, "tags": {"people": ["alex"]}}
    entries = [{"date": "2026-09-08", "document": [photo, {**photo, "id": "p2"}]},
               {"date": "2026-09-09", "document": [{**photo, "asset_id": "b" * 64}]}]
    result = media.photo_analytics(entries, "2026-09-08", "2026-09-08")
    assert result["photos"] == 1
    assert result["tags"]["people"] == {"alex": 1}


def test_photo_gallery_includes_linked_references_and_uses_latest_display_details():
    from itertools import permutations
    old = {"id": "old", "type": "photo", "asset_id": "a", "caption": "Old caption",
           "edited_asset_id": "old-edit", "tags": {"people": ["sam"]}}
    recent = {**old, "id": "new", "caption": "Recent caption", "edited_asset_id": "new-edit", "tags": {"people": ["alex"]}}
    linked = {"id": "text", "type": "text", "text": "A memory", "links": [
        {"start": 0, "end": 8, "photos": ["a", "b", "a"]}]}
    entries = [{"date": "2026-09-08", "document": [old]}, {"date": "2026-09-10", "document": [recent]},
               {"date": "2026-09-11", "document": [linked]}]
    before = copy.deepcopy(entries)
    expected = None
    for ordered in permutations(entries):
        result = media.photo_analytics(ordered)
        assert result["photos"] == 2
        photos = {row["asset_id"]: row for row in result["gallery"]}
        assert photos["a"]["date"] == "2026-09-11"
        assert photos["a"]["details_date"] == "2026-09-10"
        assert photos["a"]["caption"] == "Recent caption"
        assert photos["a"]["edited_asset_id"] == "new-edit"
        assert photos["a"]["tags"]["people"] == ["alex", "sam"]
        assert result["series"] == {"2026-09-11": 2}
        assert expected is None or result == expected
        expected = result
    assert entries == before
    older = media.photo_analytics(entries, "2026-09-08", "2026-09-08")
    assert older["photos"] == 1 and older["gallery"][0]["caption"] == "Old caption"



def test_plain_body_edit_preserves_existing_photos_and_links():
    import journal
    data = journal._empty()
    doc = [{'id':'p','type':'text','text':'Hello river', 'links':[{'start':6,'end':11,'photos':['image']}]},
           {'id':'image','type':'photo','asset_id':'a'*64}, {'id':'tail','type':'text','text':'Good evening'}]
    entry = journal.upsert_entry(data,'2026-09-08','Day','',document=doc,now=NOW)
    journal.upsert_entry(data,'2026-09-08','Day','Hello blue river\nGood evening',now=NOW)
    assert entry['document'][1]['asset_id'] == 'a'*64
    assert media.document_body(entry['document']) == entry['body']
    assert entry['document'][0]['links'][0]['start'] == 11
