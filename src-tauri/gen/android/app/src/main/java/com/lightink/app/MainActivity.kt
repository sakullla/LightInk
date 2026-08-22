package com.lightink.app

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

/**
 * 系统返回键分层桥（02 D4 / R5，前端契约见 src/ui/back-navigation.ts）。
 *
 * 通道选择（文档化）：
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
 */
class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
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
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
  }

  companion object {
    // 同步表达式：桥函数缺失 → false；JS 抛错 → 回调结果为 "null"，同样按未消费处理。
    private const val JS_BACK_BRIDGE =
      "(window.__lightinkAndroidBackPress ? window.__lightinkAndroidBackPress() === true : false)"
  }
}
