// ffmpeg / ffprobe 可执行文件的路径
//
// 桌面版：不设环境变量，直接用 PATH 里的 `ffmpeg`（行为和以前完全一样）。
// 安卓 App：内置的二进制被塞进 APK 的 native 库目录（文件名 libffmpeg.so，
//   但其实是可执行文件），那个目录不在 PATH 上，所以由 App 通过
//   JZ_FFMPEG / JZ_FFPROBE 把绝对路径传进来。
//
// 集中在这里而不是每个文件写一遍 spawn('ffmpeg')：以后要支持「用户在设置里
// 指定自己的 ffmpeg」只需要改这一个地方。
'use strict';

function pick(envKey) {
  const v = String(process.env[envKey] || '').trim();
  return v || null;
}

// 不做「从 ffmpeg 路径推导 ffprobe 路径」这种自作聪明的事：
// 安卓上两个二进制分别叫 libffmpeg.so / libffprobe.so，猜名字只会猜错。
// App 那边直接把两个路径都传进来。
const FFMPEG = pick('JZ_FFMPEG') || 'ffmpeg';
const FFPROBE = pick('JZ_FFPROBE') || 'ffprobe';

module.exports = { FFMPEG, FFPROBE };
