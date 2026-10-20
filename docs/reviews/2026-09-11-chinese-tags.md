# Chinese tags — 11 September 2026

Task and journal tags accept Unicode letters and numbers, including simplified and traditional Chinese and mixed Chinese/English names. Existing spaces, periods, underscores and hyphens remain available. Validation still excludes controls and markup; normalization still trims and lowercases without transliteration.

Mobile Enter selects the added tag, and archiving/restoring keeps its name and historical selections through sync. Mentions, photo-to-journal sharing, numeric section names and suggested titles use matching Unicode rules. Tag lengths and title clipping count Unicode characters so supplementary Han characters remain intact. Chinese input composition cannot prematurely select analytics suggestions or add photo tags.

Validation: 1,318 Python tests passed; the final complete JavaScript/browser suite passed 416 tests after all composition, mention-boundary and character-count changes. An isolated live Flask/browser pass exercised Chinese form creation, save/reload, permanent/temporary chips, archive/restore, mentions, task filters and tag overviews. Screenshots were inspected at desktop and narrow widths. The running Mac API accepted a Chinese name in a request deliberately rejected for a nonexistent section, without creating a test tag.

Exact Original build sources, test evidence, screenshots, installation receipts and checksums are retained under `data/mobile-builds/2026-09-11-chinese-tags/` after deployment. Pre-update Mac and phone metadata backups are under `data/backups/2026-09-11-chinese-tags/`.

Installed in the original phone app on 11 September 2026 at 14:30 China time, preserving app data. Installed APK SHA-256: `ceec9dd99346b1d009e50053449ef01e4ae5efe48df83713d0283acc3d0970b1`. The package, existing signer, installed checksum and all 22 bundled assets were verified. QA remains unchanged.

Final Android verification: 111 unit tests, the complete isolated storage suite, and actual WebView IME Done, long hold, separate Archive tap, history preservation and temporary re-add passed. Simplified/traditional text renders with the existing theme. The emulator lacks a glyph for rare supplementary U+20000; exact storage/sync checks pass, and fonts were preserved.

The post-install sync pass reached the Mac and retained archive configuration for all seven tag groups. It reports the same preexisting journal conflict, verified unchanged against the private backup, with no unavailable/retry error. This update did not resolve that conflict.
