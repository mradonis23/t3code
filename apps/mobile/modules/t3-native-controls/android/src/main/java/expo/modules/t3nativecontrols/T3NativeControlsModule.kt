package expo.modules.t3nativecontrols

import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3NativeControlsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3NativeControls")

    Function("getShowcasePairingUrl") {
      appContext.currentActivity?.intent?.getStringExtra("showcasePairingUrl")
    }

    Function("getShowcaseScene") {
      val storedScene = appContext.reactContext
        ?.filesDir
        ?.resolve("t3-showcase-scene")
        ?.takeIf { it.isFile }
        ?.readText()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
      storedScene ?: appContext.currentActivity?.intent?.getStringExtra("showcaseScene")
    }

    // The palette is fixed for the whole capture, so it only ever arrives as a
    // launch extra — unlike the scene, which the runner rewrites in place.
    Function("getShowcaseTheme") {
      appContext.currentActivity?.intent?.getStringExtra("showcaseTheme")
    }

    Function("prepareShowcaseCapture") {
      // Android app data is cleared by the host runner before launch.
    }

    Function("markShowcaseReady") { scene: String ->
      appContext.reactContext
        ?.filesDir
        ?.resolve("t3-showcase-ready")
        ?.writeText(scene)
    }

    Function("isPackageInstalled") { packageName: String ->
      val context = appContext.reactContext ?: return@Function false
      try {
        @Suppress("DEPRECATION")
        context.packageManager.getPackageInfo(packageName, 0)
        true
      } catch (_: PackageManager.NameNotFoundException) {
        false
      }
    }

    AsyncFunction("openExternalFile") {
        contentUri: String,
        mimeType: String,
        packageName: String?,
        editable: Boolean,
        forceChooser: Boolean,
        chooserTitle: String ->
      val activity = appContext.currentActivity
        ?: throw IllegalStateException("No foreground activity is available.")
      val uri = Uri.parse(contentUri)
      val intent = Intent(if (editable) Intent.ACTION_EDIT else Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mimeType)
        clipData = ClipData.newRawUri(chooserTitle, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (editable) addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        if (!packageName.isNullOrBlank()) setPackage(packageName)
      }
      activity.startActivity(
        if (forceChooser) Intent.createChooser(intent, chooserTitle) else intent
      )
    }
  }
}
