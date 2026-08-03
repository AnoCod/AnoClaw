# Workspace 只读文件浏览器

## 战略定位

Workspace 是强大的只读文件系统浏览器，不是编辑器，也不是 IDE。它负责发现、打开、导航和预览已存在的文件，但不负责创建、改写、重命名、移动或删除文件与目录。

这条边界同时覆盖界面和 HTTP API，不能只依赖隐藏按钮：

- 文件树仅保留搜索、筛选、刷新、展开、打开和“交给智能体分析”等只读动作。
- Monaco 仅作为源码查看器，启用 `readOnly` 与 `domReadOnly`；不提供保存、自动补全、AI 插入或整理导入。
- 旧版创建、写入、删除、重命名和移动 API 保留路由以兼容旧客户端，但统一返回 HTTP 405 和 `WORKSPACE_READ_ONLY`，且不会读取请求体或访问目标文件。
- 绑定 Workspace 只接受已存在、可访问的目录，不会替用户创建目录。
- 内置浏览器下载使用 Electron 的外部下载目录，不会自动写入 Workspace。
- 其他进程或获得独立文件工具权限的智能体仍可能改变磁盘文件；Workspace 只观察这些变化并自动刷新预览，不提供“接受、撤销、写回”等能力。

## 预览能力

| 类别 | 格式 | 查看方式 |
|---|---|---|
| 源码与文本 | 常见代码、配置、日志、字幕及未知文本文件 | 只读 Monaco、语法高亮、行列定位、悬停、诊断、定义跳转 |
| Markdown | `.md`, `.markdown` | 安全富文本与源码双模式；相对图片按当前文件目录解析 |
| Web | `.html`, `.htm`, `.xhtml`, `.svg` | 沙箱预览与源码双模式；HTML 会移除脚本、表单、嵌入对象和事件属性 |
| 配置文件 | `.ini`, `.cfg`, `.conf`, `.config`, `.properties`, `.env`, `.editorconfig`, `.npmrc` 等 | 将节、键、值和原始行号整理为只读表格，同时保留只读源码模式；不展开变量、不执行配置 |
| 结构化数据 | JSON、JSONC/JSON5、GeoJSON/TopoJSON、Web Manifest、source map、JSONL/NDJSON | 标准 JSON 与逐行 JSON 可折叠查看；含注释或 JSON5 扩展语法时保留源码模式 |
| 表格文本 | `.csv`, `.tsv` | 只读表格与源码双模式，预览最多 200 行、50 列 |
| Notebook | `.ipynb` | Markdown、代码和常见输出的只读单元格预览与源码双模式 |
| 图片 | PNG、JPEG、GIF、WebP、BMP、ICO、TIFF、AVIF、HEIC、JXL 等 | 原始比例适配预览；实际解码能力取决于 Electron/Chromium |
| Photoshop | `.psd`, `.psb` | 只显示文件中保存的合成图或缩略图，跳过且不解析或展示图层；无缩略图时可解码常见 8 位 RGB、灰度、索引色和位图合成图 |
| 音视频 | MP3、WAV、OGG、M4A、AAC、FLAC、Opus、MP4、WebM、MOV 等 | Chromium 原生只读播放器 |
| 文档 | PDF | Chromium PDF 预览 |
| Office/OpenDocument | DOCX、XLSX/XLSM、PPTX/PPTM、ODT/ODS/ODP | 文档 HTML、工作簿多表、幻灯片分卡或文本提取；旧 `.doc/.xls/.ppt` 显示兼容提示 |
| ZIP 家族 | ZIP、JAR、WAR、EAR、EPUB、APK、VSIX、NUPKG | 仅解析归档元数据，安全列出条目、原始大小和压缩大小，不解压条目内容 |
| 字体 | TTF、OTF、WOFF、WOFF2 | 拉丁字母、中文、数字与符号样张 |
| 其他二进制 | `.bin`, `.dat`, 固件/磁盘镜像、可执行文件、数据库、模型权重、科学数据、3D/CAD、冷门压缩包等 | 识别 PE、ELF、WASM、SQLite、Parquet、Arrow、DICOM、ISO、压缩流等常见魔数，并显示前 64 KiB 十六进制与 ASCII 对照；未知格式仍可安全查看字节 |

## 读取与安全限制

- 文本预览一次最多读取 1 MiB，并返回实际编码、文件总大小和截断状态；支持 UTF-8 BOM、UTF-16 LE 与 UTF-16 BE。
- 原始图片、媒体、PDF、字体和十六进制采样通过 Workspace 根目录约束后的流式读取端点提供，并支持 HTTP Range。
- HTML 预览使用 sandbox 与限制性 CSP，禁止脚本、表单提交、对象嵌入和网络连接；相对资源只重写到同一 Workspace 的只读读取端点。
- Office 与 ZIP 家族预览复用受限 ZIP 解析：文件最大 25 MiB、单条目解压最大 20 MiB、总解压最大 100 MiB，并限制异常压缩比。
- PSD/PSB 优先读取不超过 32 MiB 的资源区内嵌缩略图；没有可用缩略图时会跳过图层区，只读取最大 192 MiB 的合成图数据，画布最大 3200 万像素、合成通道展开最大 192 MiB。合成解码支持 Raw、PackBits RLE、ZIP 和 8 位 ZIP Prediction；CMYK、Lab、16/32 位等情况需要文件自带缩略图。
- 预览器绝不为查看文件创建缓存、临时文件或解压目录。

## 扩展新格式

1. 在 `WorkspaceFileCapabilities.ts` 注册扩展名、预览类型和 `preview/source` 模式。
2. 优先在浏览器内安全渲染；需要服务器解析时只返回结构化预览数据，不落盘、不执行文件内容。
3. 在 `WorkspaceTabGroup.ts` 添加渲染器，并确保异步结果受当前标签页的 render generation 约束。
4. 为 MIME、路径穿越、文件大小、压缩炸弹、活动脚本和旧写 API 增加测试。
5. 新能力不得恢复保存、创建、删除、重命名、移动或任何隐式 Workspace 写入。
