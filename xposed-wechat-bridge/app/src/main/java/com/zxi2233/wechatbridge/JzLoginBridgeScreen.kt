package com.zxi2233.wechatbridge

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Error
import androidx.compose.material.icons.rounded.Fingerprint
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.Watch
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import java.text.DateFormat
import java.util.Date

private val BridgeColors = darkColorScheme(
    primary = Color(0xFFBAC3FF),
    onPrimary = Color(0xFF232E62),
    primaryContainer = Color(0xFF333D69),
    onPrimaryContainer = Color(0xFFE1E5FF),
    secondary = Color(0xFFABD9BE),
    onSecondary = Color(0xFF143825),
    secondaryContainer = Color(0xFF283E33),
    onSecondaryContainer = Color(0xFFC7F1D6),
    tertiary = Color(0xFFF0CE86),
    onTertiary = Color(0xFF3D2E08),
    tertiaryContainer = Color(0xFF493B20),
    onTertiaryContainer = Color(0xFFFFDEA0),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF4B2930),
    onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF11131A),
    onBackground = Color(0xFFE9E9F2),
    surface = Color(0xFF171820),
    onSurface = Color(0xFFE9E9F2),
    surfaceVariant = Color(0xFF2B2D39),
    onSurfaceVariant = Color(0xFFB4B6CA),
    outline = Color(0xFF85879B),
    outlineVariant = Color(0xFF3D4051),
)

private val CatBook = FontFamily(Font(R.font.cat_book))
private val BridgeTypography = Typography(
    displaySmall = TextStyle(
        fontFamily = CatBook,
        fontWeight = FontWeight.Normal,
        fontSize = 34.sp,
        lineHeight = 42.sp,
        letterSpacing = (-0.5).sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = CatBook,
        fontWeight = FontWeight.Medium,
        fontSize = 27.sp,
        lineHeight = 34.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = CatBook,
        fontWeight = FontWeight.Medium,
        fontSize = 21.sp,
        lineHeight = 28.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = CatBook,
        fontWeight = FontWeight.Medium,
        fontSize = 17.sp,
        lineHeight = 24.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = CatBook,
        fontSize = 17.sp,
        lineHeight = 26.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = CatBook,
        fontSize = 15.sp,
        lineHeight = 23.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = CatBook,
        fontWeight = FontWeight.Medium,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = CatBook,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        lineHeight = 19.sp,
    ),
)

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun JzLoginBridgeApp(
    onClearSavedIntent: () -> Unit,
) {
    val context = LocalContext.current
    val view = LocalView.current
    val result = JzLoginBridgeState.result
    var detailsOpen by rememberSaveable { mutableStateOf(false) }
    val hostUnavailable = JzLoginBridgeState.hostUnavailable
    val status = when {
        result?.hasSession == true -> BridgeStatus.SUCCESS
        result?.isTerminal == true -> BridgeStatus.ERROR
        else -> BridgeStatus.READY
    }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    LaunchedEffect(view) {
        val window = (view.context as? android.app.Activity)?.window ?: return@LaunchedEffect
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.Transparent.toArgb()
        window.navigationBarColor = Color.Transparent.toArgb()
        WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
    }

    MaterialTheme(colorScheme = BridgeColors, typography = BridgeTypography) {
        Surface(
            modifier = Modifier.fillMaxSize().safeDrawingPadding(),
            color = MaterialTheme.colorScheme.background,
        ) {
            Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            Scaffold(
                containerColor = Color.Transparent,
                topBar = {
                    BridgeTopBar(connected = true, onInfo = { detailsOpen = true })
                },
                bottomBar = {
                    BottomResultBar(
                        result = result,
                        onCopy = { value, label -> copyText(context, value, label) },
                        onClear = {
                            JzLoginBridgeState.clear()
                            onClearSavedIntent()
                        },
                    )
                },
            ) { padding ->
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            Brush.verticalGradient(
                                listOf(
                                    Color(0xFF171A25),
                                    MaterialTheme.colorScheme.background,
                                    Color(0xFF13151C),
                                ),
                            ),
                        ),
                ) {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(
                            start = 20.dp,
                            top = padding.calculateTopPadding() + 14.dp,
                            end = 20.dp,
                            bottom = padding.calculateBottomPadding() + 22.dp,
                        ),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        item {
                            AnimatedContent(
                                targetState = status,
                                transitionSpec = {
                                    (fadeIn(tween(240)) + slideInVertically(tween(260)) { it / 14 })
                                        .togetherWith(fadeOut(tween(150)))
                                },
                                label = "bridge result",
                            ) { current ->
                                StatusHero(
                                    status = current,
                                    result = result,
                                    onDetails = { detailsOpen = true },
                                )
                            }
                        }
                        if (hostUnavailable) item { InlineNotice() }
                    }
                }
            }
            }
        }

        if (detailsOpen) {
            ModalBottomSheet(
                onDismissRequest = { detailsOpen = false },
                sheetState = sheetState,
                containerColor = MaterialTheme.colorScheme.surface,
                contentColor = MaterialTheme.colorScheme.onSurface,
                dragHandle = {
                    Surface(
                        modifier = Modifier
                            .padding(top = 10.dp, bottom = 8.dp)
                            .size(36.dp, 4.dp),
                        shape = CircleShape,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    ) {}
                },
            ) {
                DetailsSheet(result, hostUnavailable)
            }
        }
    }
}

private enum class BridgeStatus { READY, SUCCESS, ERROR }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BridgeTopBar(connected: Boolean, onInfo: () -> Unit) {
    Surface(color = Color(0xED171820), tonalElevation = 0.dp) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    start = 20.dp,
                    top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding() + 10.dp,
                    end = 12.dp,
                    bottom = 10.dp,
                ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BrandMark()
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "JzLoginBridge",
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "小天才微信登录桥",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
            AssistChip(
                onClick = onInfo,
                label = {
                    Text(
                        if (connected) "已连接" else "未连接",
                        maxLines = 1,
                        overflow = TextOverflow.Clip,
                    )
                },
                leadingIcon = {
                    Icon(Icons.Rounded.Wifi, contentDescription = null, modifier = Modifier.size(17.dp))
                },
                modifier = Modifier.semantics {
                    contentDescription =
                        "连接状态：${if (connected) "已连接" else "未连接"}，点击查看登录信息"
                },
            )
            IconButton(onClick = onInfo) {
                Icon(
                    Icons.Rounded.Shield,
                    contentDescription = "Login 信息",
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}

@Composable
private fun BrandMark() {
    Box(
        modifier = Modifier
            .size(48.dp)
            .shadow(
                10.dp,
                RoundedCornerShape(16.dp),
                ambientColor = Color.Black.copy(alpha = .35f),
                spotColor = Color.Black.copy(alpha = .35f),
            )
            .clip(RoundedCornerShape(16.dp))
            .background(Brush.linearGradient(listOf(Color(0xFFC9D0FF), Color(0xFF8EA1EA)))),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Icons.Rounded.Watch,
            contentDescription = null,
            tint = Color(0xFF202B60),
            modifier = Modifier.size(27.dp),
        )
    }
}

@Composable
private fun StatusHero(
    status: BridgeStatus,
    result: BridgeResultUi?,
    onDetails: () -> Unit,
) {
    val success = status == BridgeStatus.SUCCESS
    val error = status == BridgeStatus.ERROR
    val icon = when {
        success -> Icons.Rounded.CheckCircle
        error -> Icons.Rounded.Error
        else -> Icons.Rounded.Fingerprint
    }
    val title = when (status) {
        BridgeStatus.SUCCESS -> "授权已完成"
        BridgeStatus.ERROR -> "这次授权未完成"
        BridgeStatus.READY -> "请从网站发起登录"
    }
    val body = when (status) {
        BridgeStatus.SUCCESS -> "请返回网页继续操作！"
        BridgeStatus.ERROR -> result?.wechatError?.takeIf { it.isNotBlank() }
            ?: "请返回网页重新发起登录。"
        BridgeStatus.READY -> "打开 JZ 网页，在账号页面点击“使用微信登录”。"
    }
    val accent = when {
        success -> MaterialTheme.colorScheme.secondary
        error -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.primary
    }
    val container = when {
        success -> MaterialTheme.colorScheme.secondaryContainer
        error -> MaterialTheme.colorScheme.errorContainer
        else -> MaterialTheme.colorScheme.primaryContainer
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(28.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    Brush.linearGradient(
                        listOf(container, MaterialTheme.colorScheme.surface, Color(0xFF20232E)),
                    ),
                )
                .padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(
                    modifier = Modifier.size(56.dp),
                    shape = RoundedCornerShape(18.dp),
                    color = accent.copy(alpha = .18f),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(icon, contentDescription = null, tint = accent, modifier = Modifier.size(30.dp))
                    }
                }
                Spacer(Modifier.width(14.dp))
                Column {
                    Text(title, style = MaterialTheme.typography.headlineMedium)
                    Text(
                        if (result?.hasSession == true) "Login 状态：已完成" else "Login 状态：等待网页发起",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Text(
                body,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (status != BridgeStatus.READY) {
                FilledTonalButton(
                    onClick = onDetails,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(18.dp),
                ) {
                    Icon(Icons.Rounded.Shield, contentDescription = null, modifier = Modifier.size(19.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("查看 Login 信息")
                }
            }
        }
    }
}

@Composable
private fun InlineNotice() {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.errorContainer,
    ) {
        Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.Error, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
            Spacer(Modifier.width(10.dp))
            Text(
                "找不到小天才家长端。请先安装并打开 com.xtc.watch，再回到这里重试。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
        }
    }
}

@Composable
private fun DetailsSheet(
    result: BridgeResultUi?,
    hostUnavailable: Boolean,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(
                start = 24.dp,
                end = 24.dp,
                bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 24.dp,
            ),
    ) {
        Text("Login 信息", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(5.dp))
        Text(
            "本次登录的来源和结果。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(20.dp))
        DetailLine("运行状态", if (hostUnavailable) "小天才不可用" else if (result?.hasSession == true) "登录已完成" else "等待登录结果")
        DetailLine("来源", result?.origin?.takeIf { it.isNotBlank() } ?: "—")
        DetailLine(
            "微信错误",
            if ((result?.wechatErrorCode ?: 0) == 0) {
                "无"
            } else {
                "${result?.wechatErrorCode} · ${result?.wechatError.orEmpty()}"
            },
        )
        DetailLine(
            "捕获时间",
            result?.capturedAt?.takeIf { it > 0 }?.let {
                DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.MEDIUM).format(Date(it))
            } ?: "—",
        )
        DetailLine("版本", result?.hostVersion?.takeIf { it.isNotBlank() } ?: "—")
    }
}

@Composable
private fun DetailLine(label: String, value: String) {
    Column(modifier = Modifier.padding(vertical = 10.dp)) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(3.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun BottomResultBar(
    result: BridgeResultUi?,
    onCopy: (String?, String) -> Unit,
    onClear: () -> Unit,
) {
    if (result == null) return
    Surface(
        color = MaterialTheme.colorScheme.surface.copy(alpha = .97f),
        shadowElevation = 4.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    start = 20.dp,
                    top = 10.dp,
                    end = 20.dp,
                    bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 10.dp,
                ),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            FilledTonalButton(
                onClick = { onCopy(result.state, "授权状态已复制") },
                enabled = result.state.isNotBlank(),
                modifier = Modifier.weight(1f),
            ) {
                Icon(Icons.Rounded.ContentCopy, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(7.dp))
                Text("复制状态")
            }
            FilledTonalButton(onClick = onClear, modifier = Modifier.weight(1f)) {
                Text("清空结果")
            }
        }
    }
}

private fun copyText(context: Context, value: String?, label: String) {
    if (value.isNullOrBlank()) return
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText(label, value))
}
