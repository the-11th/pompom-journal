package com.todopup.usage

import android.Manifest
import android.app.Dialog
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.net.Uri
import android.os.Build
import android.provider.MediaStore as AndroidMediaStore
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import java.util.concurrent.Executors
import java.time.LocalDate

/** A photo grid backed by the user's granted MediaStore images, including partial access.
 * MediaStore URIs let the importer request original EXIF instead of picker-redacted bytes. */
class PhotoGalleryDialog(context: Context, private val chooseMore: () -> Unit,
                         private val systemPicker: () -> Unit, private val result: (List<Uri>) -> Unit,
                         private val day: LocalDate? = null) : Dialog(context) {
    private val io = Executors.newFixedThreadPool(2)
    private val photos = mutableListOf<Uri>()
    private val allPhotos = mutableListOf<Pair<Uri, Long?>>()
    private var showAll = day == null
    private val tabs = LinearLayout(context).apply { isBaselineAligned = false }
    private val selected = linkedSetOf<Uri>()
    private val accent = Color.parseColor(TodoPupUi.ACCENT)
    private val panel = Color.parseColor(TodoPupUi.PANEL)
    private val muted = Color.parseColor(TodoPupUi.MUTED)
    private val border = Color.parseColor(TodoPupUi.BORDER)
    private val body = object : LinearLayout(context) {
        override fun onConfigurationChanged(newConfig: Configuration) {
            super.onConfigurationChanged(newConfig)
            arrangeHeader()
        }
    }.apply {
        orientation = LinearLayout.VERTICAL
        val padding = dp(TodoPupUi.DIALOG_PADDING_DP)
        setPadding(padding, padding, padding, padding)
        background = GradientDrawable().apply {
            setColor(panel); cornerRadius = dp(TodoPupUi.SPACE_MD_DP).toFloat(); setStroke(dp(1), border)
        }
    }
    private val title = label("Photo gallery", Color.parseColor(TodoPupUi.TEXT)).apply {
        textSize = 18f; typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD); minHeight = dp(32)
    }
    private val header = LinearLayout(context).apply { isBaselineAligned = false; gravity = Gravity.CENTER_VERTICAL }
    private val tools = LinearLayout(context).apply { isBaselineAligned = false; gravity = Gravity.CENTER_VERTICAL }
    private val status = label("Loading photos…", muted)
    private val add = action("Add photos") { finish(selected.toList()) }
    private var completed = false
    private var generation = 0
    private val grid = GridView(context).apply {
        numColumns = GridView.AUTO_FIT; columnWidth = dp(96)
        horizontalSpacing = dp(TodoPupUi.SPACE_XS_DP); verticalSpacing = dp(TodoPupUi.SPACE_XS_DP)
        stretchMode = GridView.STRETCH_COLUMN_WIDTH
        setSelector(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
    }
    private val adapter = object : BaseAdapter() {
        override fun getCount() = photos.size
        override fun getItem(position: Int) = photos[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val uri = getItem(position)
            val cell = (convertView as? FrameLayout) ?: FrameLayout(context).apply {
                layoutParams = AbsListView.LayoutParams(-1, dp(114))
                addView(ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP }, FrameLayout.LayoutParams(-1, -1))
                addView(View(context),
                    FrameLayout.LayoutParams(dp(24), dp(24), Gravity.TOP or Gravity.END).apply {
                        topMargin = dp(TodoPupUi.SPACE_XS_DP); marginEnd = dp(TodoPupUi.SPACE_XS_DP)
                    })
            }
            cell.layoutParams.height = grid.columnWidth.takeIf { it > 0 } ?: dp(114)
            cell.tag = uri; cell.contentDescription = "Photo ${position + 1}"; cell.isSelected = uri in selected
            val image = cell.getChildAt(0) as ImageView; image.setImageDrawable(null)
            val check = cell.getChildAt(1)
            val ring = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(panel); setStroke(dp(1), accent) }
            check.background = if (uri in selected) {
                val dot = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(accent) }
                LayerDrawable(arrayOf(ring, dot)).apply { setLayerInset(1, dp(7), dp(7), dp(7), dp(7)) }
            } else ring
            io.execute {
                val bitmap = runCatching {
                    if (Build.VERSION.SDK_INT >= 29) context.contentResolver.loadThumbnail(uri, android.util.Size(320, 320), null)
                    else @Suppress("DEPRECATION") AndroidMediaStore.Images.Thumbnails.getThumbnail(context.contentResolver,
                        ContentUris.parseId(uri), AndroidMediaStore.Images.Thumbnails.MINI_KIND, null)
                }.getOrNull()
                image.post { if (isShowing && cell.tag == uri) image.setImageBitmap(bitmap) }
            }
            return cell
        }
    }
    init {
        window?.requestFeature(android.view.Window.FEATURE_NO_TITLE)
        header.addView(title); header.addView(tools)
        tools.addView(action("Photo access", chooseMore), LinearLayout.LayoutParams(0, -1, 1f))
        tools.addView(action("Other gallery") { completed = true; dismiss(); systemPicker() },
            LinearLayout.LayoutParams(0, -1, 1f).apply { marginStart = dp(TodoPupUi.CONTENT_GAP_DP) })
        body.addView(header, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP) })
        if (day != null) {
            for ((label, all) in listOf("This day" to false, "All photos" to true)) {
                tabs.addView(action(label) { showAll = all; filterPhotos() }, LinearLayout.LayoutParams(0, -2, 1f).apply {
                    if (all) marginStart = dp(TodoPupUi.CONTENT_GAP_DP)
                })
            }
            body.addView(tabs, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP) })
        }
        body.addView(status, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP) })
        arrangeHeader()
        grid.adapter = adapter
        grid.setOnItemClickListener { _, _, position, _ ->
            val uri = photos[position]; if (!selected.add(uri)) selected.remove(uri)
            adapter.notifyDataSetChanged(); updateSelection()
        }
        body.addView(grid, LinearLayout.LayoutParams(-1, 0, 1f))
        val actions = LinearLayout(context).apply { isBaselineAligned = false; gravity = Gravity.CENTER_VERTICAL }
        actions.addView(action("Cancel") { finish(emptyList()) }, LinearLayout.LayoutParams(0, -1, 1f))
        actions.addView(add, LinearLayout.LayoutParams(0, -1, 1f).apply { marginStart = dp(TodoPupUi.CONTENT_GAP_DP) })
        body.addView(actions, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(TodoPupUi.CONTENT_GAP_DP) })
        setContentView(body)
        setOnDismissListener { io.shutdownNow(); if (!completed) result(emptyList()) }
        updateSelection()
    }
    override fun show() {
        super.show()
        window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
        NativeDialogTheme.followWindowSize(this, fillHeight = true)
        reload()
    }
    private fun arrangeHeader() {
        val landscape = context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        header.orientation = if (landscape) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        title.layoutParams = LinearLayout.LayoutParams(if (landscape) 0 else -1, -2, if (landscape) 1f else 0f).apply {
            if (landscape) marginEnd = dp(TodoPupUi.SPACE_MD_DP) else bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP)
        }
        tools.layoutParams = LinearLayout.LayoutParams(if (landscape) 0 else -1, -2, if (landscape) 2f else 0f)
    }
    fun reload() {
        if (!isShowing) return
        val version = ++generation
        io.execute {
            val loaded = runCatching {
                val collection = AndroidMediaStore.Images.Media.EXTERNAL_CONTENT_URI
                val rows = mutableListOf<Pair<Uri, Long?>>()
                context.contentResolver.query(collection, arrayOf(AndroidMediaStore.Images.Media._ID, AndroidMediaStore.Images.Media.DATE_TAKEN), null, null,
                    "${AndroidMediaStore.Images.Media.DATE_TAKEN} DESC, ${AndroidMediaStore.Images.Media._ID} DESC")?.use { cursor ->
                    while (cursor.moveToNext()) rows.add(ContentUris.withAppendedId(collection, cursor.getLong(0)) to
                        if (cursor.isNull(1)) null else cursor.getLong(1))
                }
                rows
            }
            grid.post {
                if (!isShowing || version != generation) return@post
                allPhotos.clear(); allPhotos.addAll(loaded.getOrDefault(emptyList()))
                selected.retainAll(allPhotos.map { it.first }.toSet()); filterPhotos()
                if (loaded.isFailure) { status.text = "Allow photo access to open the gallery."; status.visibility = View.VISIBLE }
            }
        }
    }
    private fun filterPhotos() {
        photos.clear()
        photos.addAll(allPhotos.filter { PhotoGalleryDates.includes(it.second, if (showAll) null else day) }.map { it.first })
        for (i in 0 until tabs.childCount) {
            val tab = tabs.getChildAt(i)
            tab.isSelected = (i == 1) == showAll
            tab.background = GradientDrawable().apply {
                setColor(if (tab.isSelected) Color.parseColor(TodoPupUi.BACKGROUND) else panel)
                cornerRadius = dp(4).toFloat(); setStroke(dp(1), if (tab.isSelected) accent else border)
            }
        }
        adapter.notifyDataSetChanged(); updateSelection()
    }
    private fun updateSelection() {
        add.isEnabled = selected.isNotEmpty(); add.alpha = if (add.isEnabled) 1f else .45f
        add.text = if (selected.isEmpty()) "Add photos" else "Add ${selected.size} photo" + if (selected.size == 1) "" else "s"
        val message = TodoPupUi.galleryMessage(photos.size, hasPhotoAccess(context), hasLocationAccess(context))
        status.text = if (!showAll && day != null) {
            if (photos.isEmpty() && hasPhotoAccess(context)) "No photos taken on $day. Try All photos."
            else listOfNotNull("Taken on $day", message).joinToString(" · ")
        } else message.orEmpty()
        status.visibility = if (status.text.isEmpty()) View.GONE else View.VISIBLE
    }
    private fun finish(uris: List<Uri>) { completed = true; dismiss(); result(uris) }
    private fun dp(value: Int) = (value * context.resources.displayMetrics.density).toInt()
    private fun label(value: String, color: Int) = TextView(context).apply {
        text = value; setTextColor(color); typeface = Typeface.MONOSPACE; textSize = 12f
    }
    private fun action(value: String, click: () -> Unit) = label(value, accent).apply {
        NativeAccessibility.button(this)
        gravity = Gravity.CENTER; includeFontPadding = false; isClickable = true; isFocusable = true
        textSize = 13f; typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
        minHeight = dp(TodoPupUi.CONTROL_HEIGHT_DP)
        background = GradientDrawable().apply { setColor(panel); cornerRadius = dp(4).toFloat(); setStroke(dp(1), border) }
        setPadding(dp(6), dp(TodoPupUi.SPACE_XS_DP), dp(6), dp(TodoPupUi.SPACE_XS_DP)); setOnClickListener { click() }
    }
    companion object {
        fun permissions(): Array<String> = buildList {
            add(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE)
            if (Build.VERSION.SDK_INT >= 34) add(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
            if (Build.VERSION.SDK_INT >= 29) add(Manifest.permission.ACCESS_MEDIA_LOCATION)
        }.toTypedArray()
        fun hasLocationAccess(context: Context) = Build.VERSION.SDK_INT < 29 || context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED
        fun hasPhotoAccess(context: Context): Boolean = context.checkSelfPermission(
            if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
        ) == PackageManager.PERMISSION_GRANTED || (Build.VERSION.SDK_INT >= 34 && context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED)
    }
}
