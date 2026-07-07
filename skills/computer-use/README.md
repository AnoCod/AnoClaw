# Computer Use Skill

AI agent技能，用于通过模拟鼠标和键盘操作来控制Windows桌面应用程序。

## 功能特性

- **鼠标控制**: 点击、移动、拖拽、滚动
- **键盘控制**: 文本输入、快捷键、按键序列
- **屏幕捕获**: 截图、OCR文字识别
- **窗口管理**: 查找窗口、移动、调整大小、关闭
- **自动化脚本**: 录制操作、回放、条件执行

## 安装

```bash
# 进入技能目录
cd .qoder/skills/computer-use

# 安装依赖
npm install
```

## 快速开始

### 基础用法

```javascript
const { mouse, keyboard, Key, Point } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  // 移动鼠标到指定位置
  await mouse.setPosition(new Point(100, 200));
  
  // 点击
  await mouse.leftClick();
  
  // 输入文本
  await keyboard.type('Hello World');
  
  // 快捷键
  await keyboard.pressKey(Key.LeftControl, Key.C);  // Ctrl+C
}

main().catch(console.error);
```

### 运行示例

```bash
# 基础测试
node examples/basic-test.js

# 完整演示
node examples/demo.js
```

## 文档

- **SKILL.md** - 主要技能文档和使用指南
- **reference.md** - 详细的API参考文档
- **examples.md** - 更多使用示例和高级模式

## 核心API

### 鼠标操作

```javascript
// 移动鼠标
await mouse.setPosition(new Point(x, y));

// 点击
await mouse.leftClick();
await mouse.rightClick();

// 拖拽
await mouse.leftButtonDown();
await mouse.setPosition(new Point(x, y));
await mouse.leftButtonUp();
```

### 键盘操作

```javascript
// 输入文本
await keyboard.type('Hello');

// 按键组合
await keyboard.pressKey(Key.LeftControl, Key.V);

// 释放所有按键
await keyboard.releaseAllKeys();
```

### 屏幕操作

```javascript
// 截图
const screenshot = await screen.capture();

// 获取屏幕尺寸
const width = await screen.width();
const height = await screen.height();

// 获取像素颜色
const color = await screen.getColorAt(new Point(x, y));
```

### 窗口操作

```javascript
// 列出所有窗口
const windows = await Window.list();

// 查找窗口
const notepad = await Window.getByTitle('Notepad');

// 窗口操作
await notepad.focus();
await notepad.setPosition(new Point(100, 100));
await notepad.close();
```

## 使用场景

1. **自动化测试** - 自动化UI测试
2. **数据录入** - 批量数据输入
3. **报表生成** - 自动化报表生成
4. **软件安装** - 自动化安装流程
5. **桌面自动化** - 重复性任务自动化

## 注意事项

1. **坐标系统**: (0,0) 是屏幕左上角，x向右增加，y向下增加
2. **延迟**: 操作之间需要适当延迟，让UI有时间响应
3. **权限**: 某些操作可能需要管理员权限
4. **DPI缩放**: 注意Windows DPI缩放可能影响坐标
5. **窗口焦点**: 确保目标窗口有焦点

## 故障排除

| 问题 | 解决方案 |
|------|----------|
| 鼠标不移动 | 检查是否有其他应用锁定输入 |
| 按键无响应 | 确保目标窗口有焦点 |
| 截图失败 | 以适当权限运行 |
| OCR不准确 | 改善光照，使用更高分辨率 |

## 依赖

- **nut-js** - 跨平台桌面自动化库
- **sharp** - 图像处理
- **tesseract.js** - OCR文字识别

## 许可证

MIT License
