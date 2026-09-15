# Kimi Code Helper

一个基于 Electron、React 和 TypeScript 的桌面应用空框架。

当前仅包含基础窗口、浅色／深色展示模式，以及主题偏好的本地保存。多账号、额度、负载均衡和性能监控功能尚未实现。

## 开发

需要 Node.js 22.12 或更高版本，推荐 Node.js 22 LTS。

```bash
npm install
npm run dev
```

窗口右上角可切换浅色／深色模式，重启应用后保留选择。

## 常用命令

```bash
npm run typecheck    # TypeScript 检查
npm run build        # 编译主进程、预加载脚本和界面
npm start            # 运行已编译的桌面应用
npm test             # 构建并启动真实 Electron，验证主题和持久化
npm run pack         # 生成当前平台的应用目录
npm run dist         # 生成当前平台的安装包
npm run format       # 格式化源代码
npm run format:check # 检查格式
```

桌面冒烟测试需要图形环境，使用独立的临时设置目录，不会修改日常开发时保存的主题。截图输出至 `artifacts/`。

## 目录结构

```text
src/
  main/
    index.ts              # 窗口、生命周期和 IPC 处理
    services/settings.ts  # 输入校验与设置文件原子写入
  preload/index.ts        # 向界面暴露白名单 API
  shared/contracts.ts    # 跨进程类型与通信通道
  renderer/
    index.html
    src/
      App.tsx             # 空工作空间和主题切换
      main.tsx            # React 入口和错误边界
      styles.css          # 窗口布局
      theme.css           # 浅色／深色设计变量
scripts/smoke.mjs          # 真实 Electron 冒烟验证
electron.vite.config.ts    # 开发与构建配置
electron-builder.yml       # 跨平台打包配置
```

主题设置保存在 Electron `app.getPath('userData')` 下的 `settings.json`。macOS 默认位置为 `~/Library/Application Support/Kimi Code Helper/settings.json`。首次启动默认浅色；设置缺失或格式无效时使用默认值。

渲染进程启用了沙箱和上下文隔离，并关闭 Node.js 集成。系统操作通过预加载脚本中的受限 API 交给主进程执行，IPC 校验调用来源与输入。

## 打包

构建产物在 `out/`，打包产物在 `dist/`。已配置 macOS（DMG / ZIP）、Windows（NSIS）和 Linux（AppImage）目标。通常在对应系统中生成安装包。macOS 使用本地临时签名（ad hoc），发布签名、公证、应用图标和自动更新尚未配置。

技术参考：[electron-vite](https://electron-vite.org/guide/)、[Electron 上下文隔离](https://www.electronjs.org/docs/latest/tutorial/context-isolation)。

## License

MIT
