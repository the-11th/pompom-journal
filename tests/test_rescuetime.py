import rescuetime

ROW = {
    "date": "2026-06-28",
    "productivity_pulse": 72,
    "total_hours": 5.05,
    "all_productive_hours": 3.57,
    "all_distracting_hours": 0.63,
    "neutral_hours": 0.85,
    "software_development_hours": 2.37,
    "communication_and_scheduling_hours": 1.10,
    "entertainment_hours": 0.40,
    "social_networking_hours": 0.23,
    "business_hours": 0.20,
}


def test_parse_day_core_fields():
    d = rescuetime.parse_day(ROW)
    assert d["date"] == "2026-06-28"
    assert d["pulse"] == 72
    assert d["productive_min"] == round(3.57 * 60)    # 214
    assert d["distracting_min"] == round(0.63 * 60)   # 38
    assert d["neutral_min"] == round(0.85 * 60)       # 51
    assert d["total_min"] == round(5.05 * 60)         # 303
    assert d["source"] == "rescuetime"


def test_parse_day_top_categories_sorted():
    cats = rescuetime.parse_day(ROW)["top_categories"]
    # sorted by minutes desc; software dev (142) first, then communication (66)
    assert cats[0]["name"] == "Software Development" and cats[0]["min"] == round(2.37 * 60)
    assert cats[1]["name"] == "Communication And Scheduling"
    assert len(cats) <= 5


def test_parse_day_missing_fields_default_zero():
    d = rescuetime.parse_day({"date": "2026-06-28", "productivity_pulse": 50})
    assert d["productive_min"] == 0 and d["total_min"] == 0 and d["top_categories"] == []


def test_fetch_daily_summary_calls_feed():
    sink = []
    def t(method, url, headers, body):
        sink.append(url)
        return 200, [ROW]
    out = rescuetime.fetch_daily_summary("KEY123", transport=t)
    assert out == [ROW]
    assert "daily_summary_feed" in sink[0] and "key=KEY123" in sink[0]
