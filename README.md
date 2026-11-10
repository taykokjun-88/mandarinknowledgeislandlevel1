# Mandarin 1的知识群岛 · Mandarin 1 Knowledge Isles

一个南洋风格的 3D 中文学习游戏：整个群岛 = Mandarin 1 这个 Module，9 座岛 = 9 个 Chapter（C1–C9）。

- 所有汉字上方都有拼音；“拼音”和“英文”可以分别开关
- 探索：生词、句型、常见错误，点击听发音（语速 0.7），每个知识点都有英文解释
- 闯关：每次 10 题（C9 为 15 题），从每岛 100+ 题的题库真随机抽题；题型有选择、听力、拼音、声调、对错、填空、排句子、配对；题目附英文
- 游戏：句子积木、翻牌配对、打地鼠、笔顺描红（都从题库随机出题）
- 声音与动作：声调冲浪（麦克风，声调在本机分析）、跟读过关（Chrome/Edge 用浏览器语音识别；iPhone、iPad 等用本机 AI 语音识别 Whisper，第一次需要下载约 75MB 模型，下载前会提醒，只下载一次）、抓抓泡泡（摄像头 AR：答案在镜头四角漂浮，用手抓正确答案；MediaPipe 在本机分析）；每个都先显示隐私说明，可以跳过
- 背景声音：轻柔的海风和海浪声（一段循环音效，几乎不占资源）
- 建设：50 种南洋摆设，分 6 类（植物、房屋、街景、休闲、节庆、交通），每解锁一座新岛就开放一批新摆设；拖到 1–6 号空地，可以随时移动、交换
- 海洋养殖：解锁 4 座岛后开放，20 种海洋生物分 5 类（鱼、虾蟹、软体、海底、大型动物），也随着闯关一批批解锁
- 世界：Mandarin 1 是第一个世界「南洋群岛」；第二个世界「中国群岛」（Mandarin 2）之后开放
- 我的成绩：昵称、每岛进度、继续上次；登入后进度自动云端同步，换设备用学号登入即可
- 画面：白天（默认）/ 夜晚 / 跟随系统；手绘云雾、草花、树冠、海鸥蝴蝶、南洋各族群小孩、奖励特效、界面图标
- 每日登入奖励：连续登入的天数越多，每天的椰子币越多（5 → 15），每满 7 天再加 15；断一天就重新开始
- 错题本：闯关答错的题会记进错题本，闯关页可以“复习错题”（不影响星星和椰子币），答对就移出；老师后台会统计全班的“常错题”，并能筛选“7 天没上线”的同学
- 加到主屏幕：可以像 App 一样安装（iPhone/iPad 用 Safari 的“分享 → 添加到主屏幕”，Chrome/Edge 用“安装”），全屏游玩；没有离线缓存，仍需要网络。设置里有按设备显示的步骤说明
- 岛屿开放：老师后台可按班设定每座岛「按进度 / 直接开放 / 维修升级中」和开放日期，关闭的岛显示施工牌
- 教师模式：登入画面点「我是老师」，输入老师后台的密码，全部岛屿解锁、建设免费，进度只存在这台设备
- 登入：班级代码 + 学号 + 4 位密码（注册时另取昵称），进度存到老师自己的 Google 表格，跨设备同步；每班可设学号名单，名单外的学号不能注册，错误学号的记录可一键删除；`teacher.html` 是老师后台（全班进度、各岛通过率、学号名单、重设密码、导出 CSV）。部署方法见 `backend/部署说明.md`

## 文件

| 文件 | 用途 |
|---|---|
| `index.html` | 游戏本体 |
| `teacher.html` | 老师后台 |
| `config.js` | 填入后台网址（留空 = 不用登入） |
| `manifest.webmanifest`、`assets/icons/` | 加到主屏幕用的应用清单和图标（`.svg` 是图标原稿） |
| `backend/Code.gs`、`backend/部署说明.md` | Google Apps Script 后台程序与部署说明 |
| `camera-test.html` | 摄像头、麦克风、中文语音识别测试页 |
| `lib/` | three.js r160、pinyin-pro、Hanzi Writer 及 449 字笔顺数据、MediaPipe 手势识别、transformers.js 的本地副本（不依赖外部 CDN） |
| `lib/models/Xenova/whisper-tiny/` | 语音识别备用模型（优先从 Hugging Face 官方下载 whisper-base，失败时用 whisper-tiny，再失败才用这份） |
| `assets/sprites/` | 手绘素材：云、草花、树冠、小孩、特效、图标、摆设；`src/` 是未切割的原图，`sea/` 是不再使用的手绘海洋生物 |

在线网址：https://taykokjun-88.github.io/mandarinknowledgeislandlevel1/

第三方库：three.js (MIT)、pinyin-pro (MIT)、Hanzi Writer (MIT)、hanzi-writer-data（Arphic Public License，见 `lib/hanzi-data/ARPHICPL.TXT`）、MediaPipe Tasks Vision 与手部模型 (Apache-2.0)、transformers.js (Apache-2.0)、Whisper 模型（OpenAI，MIT；量化版来自 Xenova/whisper-tiny，备用副本取自 npm 包 sts-whisper-tiny）。教材：《轻松学中文 1》。
