package com.luker.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

object LukerEndpointStatusNotification {
    private const val CHANNEL_ID = "luker_endpoint_status_v1"
    private const val NOTIFICATION_ID = 1003

    fun sync(context: Context, selection: LukerEndpointConfig.Selection = LukerEndpointConfig.load(context)) {
        if (selection.usesDefaultLocalRuntime || !notificationsEnabled(context)) {
            clear(context)
            return
        }

        ensureChannel(context)

        val openEndpointSettingsIntent = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).apply {
                action = MainActivity.ACTION_OPEN_ENDPOINT_SETTINGS
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val reloadIntent = PendingIntent.getActivity(
            context,
            1,
            Intent(context, MainActivity::class.java).apply {
                action = MainActivity.ACTION_RELOAD_WEBVIEW
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val endpointText = context.getString(
            R.string.endpoint_status_notification_text,
            selection.resolveBaseUrl(),
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_runtime)
            .setContentTitle(context.getString(R.string.endpoint_status_notification_title))
            .setContentText(endpointText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(endpointText))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setAutoCancel(false)
            .setContentIntent(openEndpointSettingsIntent)
            .addAction(
                android.R.drawable.ic_menu_manage,
                context.getString(R.string.runtime_notification_endpoint),
                openEndpointSettingsIntent,
            )
            .addAction(
                android.R.drawable.ic_menu_rotate,
                context.getString(R.string.runtime_notification_reload),
                reloadIntent,
            )
            .build()

        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
    }

    fun clear(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }

    private fun notificationsEnabled(context: Context): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
    }

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.endpoint_status_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.endpoint_status_notification_channel_description)
            setShowBadge(false)
            enableVibration(false)
            enableLights(false)
        }
        manager.createNotificationChannel(channel)
    }
}
