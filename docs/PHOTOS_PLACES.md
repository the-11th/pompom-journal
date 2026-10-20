# Photos, places, and messages

Open a journal day and choose **＋ Photos** to add pictures where you are writing.
Photos are initially ordered by capture time. Choose the current entry or their
capture dates, then arrange them using the move controls or drag handles. Moving
them does not change their capture metadata.

Photo selection opens a gallery. The web gallery shows already imported pictures;
**Add photos from device** opens the browser's image chooser for new ones. The
browser decides which system picker appears. Android shows a grid of the photos
you allow it to access, including limited photo access on Android 14 and later.

Tap a picture to open its preview, then choose **Edit photo** for drawings and
image changes or **Photo details** for captions, tags, and location display.
**Details** remains available beside each picture in the entry. Captions can
remain visible below the picture or appear only when it is opened.

Select a passage while writing to reveal **Link photo** beside that paragraph.
Choose one or more pictures, then tap the highlighted passage in the formatted
entry to see them. The action stays available when moving to it with the keyboard.

The photo editor supports pen strokes, text, stickers, rotation, and cropping.
Make a sticker by tracing a subject, then use the Keep and Erase brushes to
refine the suggested cutout. Originals are retained separately from edits.
Samsung S Pen input uses pressure when available.

Changed text saves every ten seconds, including while you continue typing.
Adding a photo triggers an immediate save. **Save entry** also commits complete
`[]` task commands; automatic draft saves leave unfinished commands alone.
The phone saves locally before attempting USB synchronization.

## Tags and locations

In **Manage → Photos & places**, configure photo tag groups and whether each
group also contributes ordinary entry tags. People are shared by default.
The **Photos** analytics page counts unique photos, including text links, and
combines their grouped tags. Reused photos show the latest entry date and the
latest available photo details within the selected range.
On Android, open **Connect → Photos & places settings**. Entry, Photos, and
Places remain together above the journal; Settings lives inside Connect.

Photo details use the same circle taps as journal tags, with multiple selections.
**Permanent** tags stay available on every photo; **temporary** tags stay on the
photos where they are used. Permanent choices and tags selected for the current
photo share one row. Past temporary photo tags and matching journal tags appear
only as suggestions while typing, without a separate Temporary section.
Choose the kind when adding a tag, or use ↑ / ↓ to promote or demote it.
**Manage tags** edits a group's permanent choices without removing tags from
existing photos. These choices sync between the web and Android app.

Photo GPS coordinates are imported when present. The day's map also places a
photo without GPS when its capture time falls inside a recorded route interval.
These inferred pins are labelled as estimates; original GPS metadata remains
unchanged. Photos in recording gaps stay unplaced. A photo time without a
timezone uses the recorded day's local clock only when the match is unambiguous.
Android requests photo-location access and reads the original selected image to
avoid GPS redaction. A denied permission or a provider that strips metadata can
leave GPS unavailable; granting the permission and choosing the original from
the app gallery allows it to be imported. No current-device position is used as
a substitute. See Android's [media-location access documentation](https://developer.android.com/training/data-storage/shared/media#media-location-permission).
Location display labels and colors are independent of the actual coordinate:
rename a display label freely, or use the separate location correction control
to move the pin. Original GPS metadata remains available.

Save common cities and places on the map, give them familiar names, and set
their radii. Cities provide context; they do not make a whole city count as one
stationary visit. The **Places** analytics page combines photo locations,
recorded routes, visits, and estimated time at each place. Its all-history
control includes visits outside the selected journal date range.

Choose **My location** to show a fresh current-position marker and accuracy
circle. When location access is already allowed, opening the map requests a
position automatically. **Star here** opens a named-place editor at that position;
adjust the name and radius, then save. Starred places appear first and use stars
on the map. An existing nearby place can be starred without duplicating it.
Current-position lookup is separate from continuous tracking. Stale positions
clear after 30 seconds; use **My location** to refresh.

On Android, enable tracking in **Photos & places → Tracking** and complete the
system permission flow. While enabled, Datapom requests precise location every
five seconds, including in the background, and records available speed, bearing,
and accuracy measurements. Collection has a visible notification and a pause
control. Android needs **Allow all the time** to resume after a reboot. Accuracy
and delivery still depend on GPS reception and Android; a powered-off or
force-stopped app cannot provide a continuous record.

Every journal date has **Your day in places** below the entry. It shows the day's
route and photo pins, distance travelled, moving time, recorded time, and stops
lasting at least ten minutes. Drag the hour slider, step by an hour, or turn on
**Follow dot** to explore the recorded position. Tap a numbered stop on the map
or its itinerary row for arrival, departure, and observed duration. The dot is
the position at the selected time, and disappears when the selected time has no
reliable observations. **Fit this day** brings the whole day's route back into
view. Photo thumbnails open the existing journal photo viewer.

Daily maps distinguish **Phone** (solid amber) and **Laptop** (dashed blue).
Choose **Phone**, **Laptop**, or **Both** below the map to filter routes, playback
dots, and stops. Photo pins remain visible. Both devices share the hour slider,
but their routes never connect to each other. Daily totals follow the selected
device; Both uses the phone when it has reliable fixes, otherwise the laptop.
Higher-level analytics use that same preference per day to avoid counting the
same journey twice. Older recordings are treated as phone observations because
Android was the only previous route recorder.

On the Mac, **Manage → Photos & places → Tracking → Record this laptop** enables
optional laptop recording while Datapom is open in that browser. Recording starts
automatically on opening the app when location permission is already granted;
an explicit pause is remembered. The recorder requests a fresh location every
30 seconds; one tab records at a time. Each fix saves to the browser immediately,
then to Datapom automatically. Pending saves retry after reopening or reconnecting,
even when a new position is unavailable or recording is paused. The last-saved
status confirms a server acknowledgement. **Pause laptop recording** stops new
observations. Laptop accuracy depends on Wi-Fi and macOS Location Services, and
closing Datapom or sleeping the laptop leaves a recording gap.

The phone also starts automatically on opening Datapom when precise location
permission is already granted, unless recording was explicitly paused. Every
accepted fix is flushed directly to phone storage without needing **Save entry**
or a USB connection. Tracking settings show the last save time and update it
automatically. Saving location history never creates or modifies journal text.

Calendar entry dots require text, a tag, or an attached photo/message. Location
history, imported activity, mood-only days, and number-only days keep their data
without adding an entry dot. Clearing the last journal content removes the dot;
the date's location history remains available in Places.

**Places** above the phone journal shows only the selected entry's day. Its
date picker stays visible above the interactive map, followed by the hour
slider, daily totals, stops, photos, and that day's movement details. Changing
the date keeps Places open for the new day.

**Analytics → Memories → Places** on the Mac shows the higher-level analysis:
range totals, time and repeat visits at familiar places, travel trends,
transport estimates, movement by local hour and weekday, then recording
coverage. **Explore a day** at the bottom opens a daily map on demand; selecting
a place's visit opens that date directly. The Analytics date filter applies to
the whole page.
Tracking days are included even when no journal text was written. Days without
recordings do not count as zero-distance days. Walking, cycling, and vehicle
labels are estimates from speed; GPS alone cannot distinguish a car, bus, or
train reliably. Weak fixes, session boundaries, and gaps over ten minutes break
routes and dwell estimates.

## Offline maps and USB

The world overview and regional detail are stored on the Mac and phone. Settings
shows coverage, estimated download sizes, and installed file sizes. The initial
packs cover Shanghai, Beijing, and all nine Bay Area counties, including Fremont.
Select another region on the Mac before a trip and download it there.

Connect the authorized Android phone by USB to synchronize journal documents,
original photos, edits, metadata, tracking history, and installed map packs.
The Mac's USB watcher starts the sync on connection; manual sync remains
available. Interrupted map transfers resume, and a pack is enabled only after
its checksum matches. Previously installed maps remain usable during an update.

Downloaded maps and saved journal content work without internet. New map
downloads and new Discord message captures need a connection.

Past tracking days are archived as compressed `.json.gz` observation files on
both devices. Compression is lossless: timestamps and precise coordinates stay
available for replay and photo placement. The phone appends live fixes to a
daily `.jsonl` log and consolidates it when the day finishes; it does not rewrite
the full day for every GPS update. All dates reuse the same installed
PMTiles basemap files and content-addressed photos; no whole map or duplicate
photo is saved with each day. USB receipts describe observation content, so
compression alone does not force old history to be transferred again. Existing
uncompressed tracking files remain readable and migrate automatically.

## Discord

The optional **Add to Datapom** action captures a message you select in Discord,
including its text and original timestamp. It uses a private HTTPS inbox; setup
is described in [Discord inbox setup](DISCORD_INBOX.md). The receiver must be
hosted and connected to your own Discord application before live import works.

Sync the inbox on the Mac, then insert a message into its original day or the
current entry and add your own caption. Saved inserts work offline and transfer
to the phone over USB. A private message link by itself cannot fetch its text.
Attachments are listed by name; add their photos separately.
