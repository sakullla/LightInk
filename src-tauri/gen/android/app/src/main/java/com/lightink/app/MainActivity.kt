package com.lightink.app

import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * MainActivity 前端桥（02 D4 系统返回 + 02 D6 SAF 导入）。
 *
 * 系统返回键分层桥（前端契约见 src/ui/back-navigation.ts）：
 * - 不用 `onBackPressed()` 重写：targetSdk 36（Android 16）下预测性返回
 *   强制走 OnBackInvokedCallback，deprecated 的 onBackPressed 重写不会再被
 *   系统调用。改用 `onBackPressedDispatcher.addCallback`——与 wry 自带
 *   `WryActivity.handleBackNavigation` 同一模式（TauriActivity 已将它关闭，
 *   此处接管），全 API 等级可靠。
 * - 转发通道用 `WebView.evaluateJavascript` 同步求值 JS 桥函数
 *   `window.__lightinkAndroidBackPress()`：返回 true = 前端已消费
 *   （关最上层 overlay / 阅读器返回书架），Kotlin 不再动作；false 或
 *   桥函数缺失/抛错（回调拿到 "null"）= 未消费，回落系统默认。
 * - evaluateJavascript 的回调异步返回，但“是否消费”由 JS 同步函数一次
 *   求值完毕，Kotlin 只在“未消费”分支补默认动作，因此不存在等待中的
 *   卡死窗口；桥丢失/无处理器时同样回落系统默认。
 *
 * SAF 本地导入桥（02 D6 / R3，前端契约见 src/file/file-dialog.ts，两侧
 * 注释互相引用）：
 * - 背景：@tauri-apps/plugin-dialog 2.7.2 的 Android showFilePicker
 *   （DialogPlugin.kt）只能回传 content:// URI，不满足
 *   library_import_managed_book 的真实文件路径契约，因此落地本桥。
 * - JS → Kotlin：`addJavascriptInterface` 暴露
 *   `window.LightInkSafBridge.openDocument(requestId, mimeTypesJson)`，
 *   启动 ACTION_OPEN_DOCUMENT（registerForActivityResult，单飞：
 *   pendingSafRequestId 非空时新请求立即以 error 回绝）。
 *   addJavascriptInterface 方法运行在 WebView 私有 Binder 线程，因此一律
 *   runOnUiThread 后再操作 ActivityResultLauncher。
 * - Kotlin → JS：选中的 content:// 流在单线程 executor 上复制到应用私有
 *   缓存目录 cacheDir/import-cache/<requestId>/ 下（每请求一个子目录避免
 *   并发/重名冲突，文件名保持干净的显示名——书架标题直接取自该文件名，
 *   见 src-tauri/src/managed.rs insert_managed_item），随后
 *   evaluateJavascript 调用
 *   `window.__lightinkSafResolve(requestId, result)`；result 形状
 *   `{status:'ok',path}` / `{status:'cancelled'}` / `{status:'error',message}`。
 * - WebView 已销毁时回传丢失，前端 Promise 悬挂；该窗口仅在 Activity
 *   销毁期间出现，下一次选择会重新拉起，不做持久化重投。
 *
 * 系统栏显隐桥（R4 / comic-mobile，前端契约见 src/reader/formats/cbz.ts
 * `syncComicSystemBarsVisible` / `LightInkSystemBars`）：
 * - JS → Kotlin：`addJavascriptInterface` 暴露
 *   `window.LightInkSystemBars.setVisible(visible)`。
 *   `visible=false` 隐藏状态栏与导航条（`WindowInsetsCompat.Type.systemBars()`，
 *   `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`），并
 *   `WindowCompat.setDecorFitsSystemWindows(window, false)` 让画面贴边；
 *   `visible=true` 再显示系统栏。成对显隐由阅读 chrome 调用。
 * - 失败吞掉、不向 JS 抛：invoke 失败仍只藏应用 chrome，阅读不中断。
 * - 桌面不调用该桥。`ReaderTypography.hideStatusBar` 不复用为本桥。
 * - 前端另有 `invoke('set_system_bars_visible')` 回落；本 Activity 只落地 JS 桥。
 *
 * 外部打开桥（文件关联 VIEW intent，前端契约见 src/file/android-view-open.ts）：
 * - 背景：第三方应用（Telegram 等）「用其他应用打开」送达的是 content:// URI。
 *   Tauri 的 RunEvent::Opened 虽会在 Android 触发，但 Rust 侧 std::fs 读不了
 *   content://（cli.rs first_supported_from_urls 刻意只收 file://），因此与
 *   SAF 导入同一做法：Kotlin 把流复制成真实缓存文件后交前端。
 * - onCreate（冷启动）与 onNewIntent（singleTask 已运行）都收 ACTION_VIEW；
 *   content:// 在 safCopyExecutor 上复制到 cacheDir/view-cache/<序号>/<显示名>，
 *   file:// 留给既有 RunEvent::Opened 路径（避免双开）。
 * - Kotlin → JS：完成后写入单槽 pendingExternalOpenPath 并 evaluateJavascript
 *   通知 `window.__lightinkExternalOpenNotify()`；前端经
 *   `window.LightInkExternalOpen.takePendingPath()`（取出即清空）拉取。
 *   前端未就绪时通知丢失无妨——bootstrap 时会主动 drain 一次。
 */
class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  /** 进行中的 SAF 请求 id（单飞）；null 表示空闲。 */
  private var pendingSafRequestId: String? = null
  private val safCopyExecutor = Executors.newSingleThreadExecutor()

  /**
   * 待打开的外部文件路径（单槽，后到覆盖先到；取出即清空）。
   * takePendingPath 运行在 WebView 私有 Binder 线程，复制完成回写在
   * executor 线程，用 AtomicReference 保证两侧线程安全。
   */
  private val pendingExternalOpenPath =
    java.util.concurrent.atomic.AtomicReference<String?>(null)
  private var externalOpenCounter = 0L

  /**
   * 阅读 chrome 期望的系统栏可见性。false 时 pushSafeArea 只保留 displayCutout，
   * 不把 16dp 手势底垫或已隐藏的 systemBars 写回 CSS，画面才能贴边。
   */
  private var systemBarsWanted = true

  private val safOpenDocument =
    registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
      val requestId = pendingSafRequestId
      pendingSafRequestId = null
      if (requestId == null) {
        return@registerForActivityResult
      }
      if (uri == null) {
        resolveSaf(requestId, JSONObject().put("status", "cancelled"))
        return@registerForActivityResult
      }
      // 大文件（漫画归档可达数百 MB）复制放后台线程，完成后回 UI 线程回传。
      safCopyExecutor.execute {
        val payload = try {
          val path = copyToImportCache(uri, requestId)
          JSONObject().put("status", "ok").put("path", path)
        } catch (ex: Exception) {
          JSONObject().put("status", "error")
            .put("message", ex.message ?: "Failed to copy selected file")
        }
        runOnUiThread { resolveSaf(requestId, payload) }
      }
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_USER
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val view = webView
        if (view == null) {
          // WebView 尚未创建：无前端可消费，直接系统默认。
          runSystemDefaultBack()
          return
        }
        view.evaluateJavascript(JS_BACK_BRIDGE) { result ->
          if (result?.trim() != "true") {
            runSystemDefaultBack()
          }
        }
      }

      /** 未消费时回放系统默认返回（本回调临时禁用避免递归）。 */
      private fun runSystemDefaultBack() {
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }
    })
    handleViewIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleViewIntent(intent)
  }

  /**
   * 文件关联打开（ACTION_VIEW）：content:// 复制成真实缓存文件后经外部打开桥
   * 交前端；file:// 留给 Tauri RunEvent::Opened 既有路径，避免双开。
   */
  private fun handleViewIntent(intent: Intent?) {
    if (intent?.action != Intent.ACTION_VIEW) {
      return
    }
    val uri = intent.data ?: return
    if (!uri.scheme.equals("content", ignoreCase = true)) {
      return
    }
    val mimeType = intent.type
    safCopyExecutor.execute {
      try {
        val path = copyToViewCache(uri, mimeType)
        pendingExternalOpenPath.set(path)
        runOnUiThread { notifyExternalOpen() }
      } catch (_: Exception) {
        // 流打开/复制失败（源应用撤权、磁盘满等）：无法读取即无书可开；
        // 冷启动此刻多半没有前端上下文可提示，静默放弃。
      }
    }
  }

  /** 前端桥就绪时提醒拉取；未就绪（冷启动）由 bootstrap 主动 drain。 */
  private fun notifyExternalOpen() {
    webView?.evaluateJavascript(
      "window.__lightinkExternalOpenNotify && window.__lightinkExternalOpenNotify()",
      null,
    )
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    // 前端契约见 src/file/file-dialog.ts（SAF 桥通道）。
    webView.addJavascriptInterface(SafBridgeJsInterface(), "LightInkSafBridge")
    // 前端契约见 src/reader/formats/cbz.ts `LightInkSystemBars.setVisible`。
    webView.addJavascriptInterface(SystemBarsJsInterface(), "LightInkSystemBars")
    // 前端契约见 src/file/android-view-open.ts（外部打开桥通道）。
    webView.addJavascriptInterface(ExternalOpenJsInterface(), "LightInkExternalOpen")
    // Older WebViews report env(safe-area-inset-*) as 0. Push system-bar
    // and IME insets as CSS pixels so chrome sits below the status bar and
    // note dialogs stay above the keyboard (edge-to-edge does not resize).
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
      pushSafeArea(view as WebView, windowInsets)
      windowInsets
    }
    ViewCompat.setWindowInsetsAnimationCallback(
      webView,
      object : WindowInsetsAnimationCompat.Callback(
        WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE,
      ) {
        override fun onProgress(
          insets: WindowInsetsCompat,
          runningAnimations: MutableList<WindowInsetsAnimationCompat>,
        ): WindowInsetsCompat {
          val live = this@MainActivity.webView
          if (live != null) {
            pushSafeArea(live, insets)
          }
          return insets
        }
      },
    )
    ViewCompat.requestApplyInsets(webView)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // 失焦后系统常把栏拉回来；阅读仍要藏栏时成对再藏一次。
    if (hasFocus && !systemBarsWanted) {
      applySystemBarsVisible(false)
    }
  }

  override fun onDestroy() {
    // 离开前恢复系统栏，避免 Activity 销毁时窗口停在 immersive hide。
    applySystemBarsVisible(true)
    // 清空 webView 引用：销毁后完成的后台复制会走 resolveSaf 的 null-guard
    // 直接 no-op，避免对已销毁 WebView 调 evaluateJavascript。
    webView = null
    safCopyExecutor.shutdown()
    super.onDestroy()
  }

  /** JS 可见的系统栏桥入口（运行在 WebView 私有线程，必须切回 UI 线程）。 */
  private inner class SystemBarsJsInterface {
    @JavascriptInterface
    fun setVisible(visible: Boolean) {
      runOnUiThread { applySystemBarsVisible(visible) }
    }
  }

  /**
   * 与阅读 chrome 成对显隐系统栏。失败吞掉，不向 JS 抛。
   * 全屏阅读时才强制 decor 不 fit system windows，使画面贴边。
   */
  private fun applySystemBarsVisible(visible: Boolean) {
    try {
      val controller = WindowCompat.getInsetsController(window, window.decorView)
      if (visible) {
        controller.show(WindowInsetsCompat.Type.systemBars())
      } else {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        controller.systemBarsBehavior =
          WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
      }
      systemBarsWanted = visible
      val view = webView
      if (view != null) {
        ViewCompat.requestApplyInsets(view)
      }
    } catch (_: Exception) {
      // invoke 失败不阻断阅读：前端仍只藏应用 chrome。
    }
  }

  /**
   * JS 可见的外部打开桥入口。取出即清空，保证一次打开只消费一次；
   * 无待打开文件返回 null（JS 侧收到 null）。
   */
  private inner class ExternalOpenJsInterface {
    @JavascriptInterface
    fun takePendingPath(): String? = pendingExternalOpenPath.getAndSet(null)
  }

  /** JS 可见的 SAF 桥入口（运行在 WebView 私有线程，必须切回 UI 线程）。 */
  private inner class SafBridgeJsInterface {
    @JavascriptInterface
    fun openDocument(requestId: String, mimeTypesJson: String) {
      runOnUiThread {
        if (pendingSafRequestId != null) {
          resolveSaf(
            requestId,
            JSONObject().put("status", "error")
              .put("message", "Another file pick is already in progress"),
          )
          return@runOnUiThread
        }
        val mimeTypes = try {
          val array = JSONArray(mimeTypesJson)
          Array(array.length()) { index -> array.getString(index) }
        } catch (ex: Exception) {
          resolveSaf(
            requestId,
            JSONObject().put("status", "error")
              .put("message", "Invalid MIME types payload"),
          )
          return@runOnUiThread
        }
        pendingSafRequestId = requestId
        try {
          safOpenDocument.launch(mimeTypes)
        } catch (ex: Exception) {
          pendingSafRequestId = null
          resolveSaf(
            requestId,
            JSONObject().put("status", "error")
              .put("message", ex.message ?: "Failed to launch file picker"),
          )
        }
      }
    }
  }

  /**
   * 把系统栏 / 手势条 / IME 高度写成 CSS 像素。safe-bottom 不含键盘，
   * 键盘单独走 --lightink-keyboard-inset，避免底栏与弹层重复抬高。
   */
  private fun pushSafeArea(view: WebView, windowInsets: WindowInsetsCompat) {
    val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
    val density = view.resources.displayMetrics.density.coerceAtLeast(0.01f)
    val keyboard = maxOf(0, ime.bottom) / density
    val top: Float
    val right: Float
    val bottom: Float
    val left: Float
    if (!systemBarsWanted) {
      // 阅读全屏：只避开物理挖孔。忽略 transient swipe 带回的 systemBars，
      // 也不再垫 16dp 手势底，否则画面无法贴边。
      val cutout = windowInsets.getInsets(WindowInsetsCompat.Type.displayCutout())
      top = cutout.top / density
      right = cutout.right / density
      bottom = cutout.bottom / density
      left = cutout.left / density
    } else {
      val bars = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val tappable = windowInsets.getInsets(WindowInsetsCompat.Type.tappableElement())
      val gestures = windowInsets.getInsets(WindowInsetsCompat.Type.mandatorySystemGestures())
      top = maxOf(bars.top, tappable.top) / density
      right = maxOf(bars.right, tappable.right) / density
      // Gesture nav often reports systemBars().bottom = 0 while the home
      // indicator still covers the last 16–48 dp. Floor matches tokens.css.
      bottom = maxOf(bars.bottom, tappable.bottom, gestures.bottom, (16 * density).toInt()) / density
      left = maxOf(bars.left, tappable.left) / density
    }
    val script =
      "(function(){" +
        "var r=document.documentElement;" +
        "r.style.setProperty('--lightink-safe-top','${top}px');" +
        "r.style.setProperty('--lightink-safe-right','${right}px');" +
        "r.style.setProperty('--lightink-safe-bottom','${bottom}px');" +
        "r.style.setProperty('--lightink-safe-left','${left}px');" +
        "r.style.setProperty('--lightink-keyboard-inset','${keyboard}px');" +
        "window.__lightinkSafeArea={top:$top,right:$right,bottom:$bottom,left:$left};" +
        "window.__lightinkKeyboardInset=$keyboard;" +
        // 藏栏时只写 CSS 变量。__lightinkApplySafeArea 会把 bottom=0 垫回 16px，
        // 破坏阅读贴边；显栏时仍走该回调以复用前端手势底垫。
        (if (systemBarsWanted) {
          "if(window.__lightinkApplySafeArea){" +
            "window.__lightinkApplySafeArea(window.__lightinkSafeArea);" +
            "}"
        } else {
          ""
        }) +
        "if(window.__lightinkApplyKeyboardInset){" +
        "window.__lightinkApplyKeyboardInset($keyboard);" +
        "}" +
        "})()"
    view.post {
      val live = this.webView
      if (live != null && live === view) {
        live.evaluateJavascript(script, null)
      }
    }
  }

  /** 经 evaluateJavascript 回传选择结果（前端全局函数名两侧保持同步）。 */
  private fun resolveSaf(requestId: String, payload: JSONObject) {
    val view = webView ?: return
    val script = "window.__lightinkSafResolve && window.__lightinkSafResolve(" +
      JSONObject.quote(requestId) + ", " + payload.toString() + ")"
    view.evaluateJavascript(script, null)
  }

  /**
   * 把 content:// 流复制到应用私有缓存目录，返回真实文件路径。
   * 每请求一个子目录（import-cache/<requestId>/<displayName>）：文件名保持
   * 干净的显示名——library_import_managed_book 的书架标题直接取自源文件名
   * （src-tauri/src/managed.rs insert_managed_item），不能用 requestId 前缀
   * 污染；子目录本身承担并发/重名隔离。
   */
  private fun copyToImportCache(uri: Uri, requestId: String): String {
    val displayName = sanitizeFileName(queryDisplayName(uri)) ?: "import.bin"
    val dir = File(File(cacheDir, "import-cache"), requestId)
    if (!dir.exists() && !dir.mkdirs()) {
      throw java.io.IOException("Failed to create import cache directory")
    }
    val target = File(dir, displayName)
    contentResolver.openInputStream(uri)?.use { input ->
      target.outputStream().use { output -> input.copyTo(output) }
    } ?: throw java.io.IOException("Failed to open selected document stream")
    return target.absolutePath
  }

  /**
   * 外部打开（VIEW intent）：把 content:// 流复制到 cacheDir/view-cache/<序号>/
   * 下，返回真实文件路径。与 copyToImportCache 同理由分子目录、保留干净显示名
   * （reader 标签标题/书架标题取自文件名）；序号仅在单线程 executor 上自增。
   */
  private fun copyToViewCache(uri: Uri, mimeType: String?): String {
    val rawName = sanitizeFileName(queryDisplayName(uri))
      ?: sanitizeFileName(uri.lastPathSegment?.substringAfterLast('/'))
      ?: "external-open"
    // 前端按扩展名路由（reader/编辑器）；显示名没有扩展名时按 intent MIME 兜底，
    // 否则打开会以「不支持的文件」失败。application/zip 视作 cbz（本应用只在
    // 漫画语境下声明 zip 关联）。
    val displayName = if (rawName.contains('.')) {
      rawName
    } else {
      val ext = when (mimeType?.lowercase()) {
        "application/pdf" -> "pdf"
        "application/epub+zip" -> "epub"
        "application/x-mobipocket-ebook" -> "mobi"
        "application/x-fictionbook+xml", "text/fb2+xml" -> "fb2"
        "application/vnd.comicbook+zip", "application/x-cbz", "application/zip" -> "cbz"
        "application/vnd.comicbook-rar", "application/x-cbr" -> "cbr"
        "application/x-cb7" -> "cb7"
        "application/vnd.rar", "application/x-rar-compressed" -> "rar"
        "application/x-7z-compressed" -> "7z"
        "text/plain" -> "txt"
        "text/markdown" -> "md"
        else -> null
      }
      if (ext != null) "$rawName.$ext" else rawName
    }
    externalOpenCounter += 1
    val dir = File(File(cacheDir, "view-cache"), externalOpenCounter.toString())
    if (!dir.exists() && !dir.mkdirs()) {
      throw java.io.IOException("Failed to create view cache directory")
    }
    val target = File(dir, displayName)
    contentResolver.openInputStream(uri)?.use { input ->
      target.outputStream().use { output -> input.copyTo(output) }
    } ?: throw java.io.IOException("Failed to open external document stream")
    return target.absolutePath
  }

  private fun queryDisplayName(uri: Uri): String? {
    return contentResolver.query(uri, null, null, null, null)?.use { cursor ->
      val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
      if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
    }
  }

  private fun sanitizeFileName(name: String?): String? {
    if (name.isNullOrBlank()) {
      return null
    }
    // 保留 Unicode 书名（含空格与常见标点）：书架标题直接取自该文件名。
    // 只替换路径分隔符、Windows 保留符和控制符，避免把「三体 01」抹成乱码式下划线。
    val sanitized = name.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_")
    // 拒绝仅由点组成的名字（"." / ".." 路径穿越风险），回落默认名。
    if (sanitized.all { it == '.' }) {
      return null
    }
    return sanitized.ifBlank { null }
  }

  companion object {
    // 同步表达式：桥函数缺失 → false；JS 抛错 → 回调结果为 "null"，同样按未消费处理。
    private const val JS_BACK_BRIDGE =
      "(window.__lightinkAndroidBackPress ? window.__lightinkAndroidBackPress() === true : false)"
  }
}
