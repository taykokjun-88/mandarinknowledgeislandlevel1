# Mandarin 1的知识群岛 · Mandarin 1 Knowledge Isles

一个南洋风格的 3D 中文学习游戏：9 座岛 = 9 个单元。

- 所有汉字上方都有拼音；“拼音”和“英文”可以分别开关
- 探索：生词、句型、常见错误，点击听发音（语速 0.7），每个知识点都有英文解释
- 闯关：每次 10 题（M9 为 15 题），从每岛 100+ 题的题库真随机抽题；题型有选择、听力、拼音、声调、对错、填空、排句子、配对；题目附英文
- 游戏：句子积木、翻牌配对、打地鼠、笔顺描红（都从题库随机出题）
- 声音与动作：声调冲浪（麦克风，声调在本机分析）、跟读过关（浏览器语音识别）、抓抓泡泡（摄像头 AR：答案在镜头四角漂浮，用手捏住或握拳抓正确答案；MediaPipe 在本机分析）；每个都先显示隐私说明，可以跳过
- 背景音乐：每座岛一种东南亚风格（婆罗洲弹拨琴、竹管乐、甘美兰、文莱铜锣乐、马来舞曲、沙宾舞曲、南洋民谣等），由浏览器即时合成
- 建设：16 种南洋摆设，拖到 1–6 号空地，可以随时移动、交换
- 海洋养殖：解锁 4 座岛后开放，12 种海洋生物在岛的周围游动
- 我的成绩：昵称、每岛进度、继续上次；换设备用“进度码”

## 文件

| 文件 | 用途 |
|---|---|
| `index.html` | 游戏本体 |
| `camera-test.html` | 摄像头、麦克风、中文语音识别测试页 |
| `lib/` | three.js r160、pinyin-pro、Hanzi Writer 及 449 字笔顺数据、MediaPipe 手势识别的本地副本（不依赖外部 CDN） |

在线网址：https://taykokjun-88.github.io/mandarinknowledgeislandlevel1/

第三方库：three.js (MIT)、pinyin-pro (MIT)、Hanzi Writer (MIT)、hanzi-writer-data（Arphic Public License，见 `lib/hanzi-data/ARPHICPL.TXT`）、MediaPipe Tasks Vision 与手部模型 (Apache-2.0)。教材：《轻松学中文 1》。
