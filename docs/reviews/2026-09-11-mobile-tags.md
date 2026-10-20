# Mobile journal tags — 11 September 2026

Enter now explicitly adds the typed journal tag and selects its chip. Android displays the Done key. Input composition does not submit a tag. Save replies preserve newer typing and checkbox changes; retrying a failed save respects later deselection.

Holding a journal tag opens Tag options. A separate Archive tap hides it from mobile choices while preserving selections already recorded on entries. Scrolling cancels the hold, and releasing even a long hold cannot activate the new menu's buttons. Failed archiving keeps the tag and offers retry. Re-adding an archived tag restores it with the selected temporary/permanent behavior.

Archive and temporary restore are durable offline operations. Dedicated authenticated Mac endpoints avoid older servers mistaking archive requests for additions. Strict acknowledgements, retained operation identities, and local registry projection prevent stale replies or old pending additions from resurrecting archived choices. Web restoration remains available.

Validation includes the complete Python and JavaScript suites, Android unit and isolated storage checks, actual Android keyboard Done, touch holds, separate Archive taps, history preservation, temporary restoration, composition, and delayed/failed save regressions. Deployment details and exact build evidence are retained under `data/mobile-builds/2026-09-11-mobile-tags/`.

Installed in the original phone app with data preserved. Installed APK SHA-256: `9664a36aa5f24b0984864db81d2b7c88711b42cbaf6106b95a19c00371d10bdb`. Its signer and all 15 bundled journal text assets were verified before installation. The QA app checksum is unchanged.

The running Mac backend advertises journal tag archive support. After ordinary USB sync, all seven active tag sections in the original phone cache contain archive state. No production tag was created or archived for testing.

Final checks passed: 1,288 Python tests, 406 JavaScript/browser tests, 104 Android unit tests, the complete isolated Android storage suite, and actual Android WebView keyboard/touch flows. UI evidence comes from the disposable emulator; physical-phone installation and configuration sync were verified separately.
