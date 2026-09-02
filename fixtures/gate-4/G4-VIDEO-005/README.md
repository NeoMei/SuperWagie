# G4-VIDEO-005 — 照片动态视频

固定目标：30 秒代表照片序列、原图不变、派生裁切、主体安全区、运动路径、
旁白/音乐/字幕、局部返工和媒体 QA。

当前 macOS PoC 验证了派生视频、运动、TTS、SRT、取消恢复与确定性媒体输出；
真实多人照片安全裁切、随包 Chromium 的产品级独立 `render_worker`、人工视觉门和 Windows golden
render 尚未通过，不能签 GO。
