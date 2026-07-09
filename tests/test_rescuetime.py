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


# --- Per-activity (website/app) breakdown via the Analytic Data API --------- #

ACTIVITY_PAYLOAD = {
    "row_headers": ["Rank", "Time Spent (seconds)", "Number of People",
                    "Activity", "Category", "Productivity"],
    "rows": [
        [1, 5400, 1, "github.com", "General Software Development", 2],
        [2, 3600, 1, "mail.google.com", "Email", 0],
        [3, 1800, 1, "youtube.com", "Video", -2],
        [4, 20,   1, "blip.example", "Uncategorized", 0],  # <30s -> 0 min, dropped
    ],
}


def test_fetch_activities_calls_analytic_endpoint():
    sink = []
    def t(method, url, headers, body):
        sink.append(url)
        return 200, ACTIVITY_PAYLOAD
    out = rescuetime.fetch_activities("KEY123", "2026-06-28", transport=t)
    assert out == ACTIVITY_PAYLOAD
    assert "anapi/data" in sink[0]
    assert "restrict_kind=activity" in sink[0]
    assert "restrict_begin=2026-06-28" in sink[0] and "restrict_end=2026-06-28" in sink[0]


def test_parse_activities_shape_sort_and_cap():
    acts = rescuetime.parse_activities(ACTIVITY_PAYLOAD)
    # sorted by minutes desc; sub-minute activity dropped
    assert [a["name"] for a in acts] == ["github.com", "mail.google.com", "youtube.com"]
    assert acts[0] == {"name": "github.com", "min": 90,
                       "category": "General Software Development", "productivity": 2}
    assert acts[2]["productivity"] == -2


def test_parse_activities_respects_cap():
    payload = {"row_headers": ACTIVITY_PAYLOAD["row_headers"],
               "rows": [[i, (10 - i) * 600, 1, f"a{i}.com", "Cat", 0] for i in range(6)]}
    assert len(rescuetime.parse_activities(payload, cap=3)) == 3


def test_parse_activities_defensive_on_junk():
    assert rescuetime.parse_activities(None) == []
    assert rescuetime.parse_activities({}) == []
    assert rescuetime.parse_activities({"rows": "nope"}) == []
    # short/garbage rows are skipped, not fatal
    payload = {"row_headers": ACTIVITY_PAYLOAD["row_headers"],
               "rows": [[1, 600, 1, "ok.com", "Cat", 1], "junk", [], [2, "x", 1, "bad.com", "Cat", 0]]}
    acts = rescuetime.parse_activities(payload)
    assert [a["name"] for a in acts] == ["ok.com"]


def test_parse_activities_falls_back_to_fixed_columns_without_headers():
    payload = {"rows": [[1, 1200, 1, "slack.com", "Communication", 1]]}
    acts = rescuetime.parse_activities(payload)
    assert acts == [{"name": "slack.com", "min": 20,
                     "category": "Communication", "productivity": 1}]
