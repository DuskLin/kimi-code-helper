# README 配图 / README images

桌面图片直接复制自 `scripts/smoke.mjs` 生成的真实 Electron 界面截图，使用模拟账号、本地模拟上游和独立临时配置，不含真实账号凭据。图中的端口、日期、额度、费用和请求仅用于演示。

Desktop images are unmodified Electron UI screenshots produced by `scripts/smoke.mjs`, using mock accounts, local mock upstreams, and isolated temporary configuration. They contain no real account credentials. Ports, dates, quotas, costs, and requests are illustrative.

| README asset          | Smoke-test source              |
| --------------------- | ------------------------------ |
| `overview-light.png`  | `artifacts/light.png`          |
| `overview-dark.png`   | `artifacts/dark.png`           |
| `account-editor.png`  | `artifacts/account-editor.png` |
| `request-history.png` | `artifacts/requests.png`       |

## 更新 / Updating

在具备图形环境与系统安全存储的机器上运行 `npm run test:smoke`，检查生成图片，再按上表复制至本目录。`artifacts/` 被 Git 忽略，因此 README 使用此目录下可跟踪的副本。中英文 README 共用图片；更新时请同时检查两份文档的说明。

Run `npm run test:smoke` on a machine with a graphical environment and system secure storage, inspect the output, then copy the mapped files here. Git ignores `artifacts/`, so the READMEs use tracked copies in this directory. Both languages share the same images; review both captions when updating them.

## 手机与 iPad 配图 / Phone and iPad screenshots

移动端图片由 `node scripts/capture-dashboard-docs.mjs` 从实际网页的开发预览模式生成，固定时钟和示例账号，并启用触摸视口模拟。截图保留页面的「交互预览／示例数据」标记，未连接真实账号服务，不含访问码或公网地址。它们是 Chromium 视口截图，不是实体设备或 Safari 兼容性测试。

Mobile images are captured from the actual web UI in development preview mode, with a fixed clock, demo accounts, touch-enabled viewports, and visible demo labels. They do not connect to real account services. These are Chromium viewport captures, not physical-device or Safari compatibility tests.

| README asset                   | Source                                                  | CSS viewport | Capture scale |
| ------------------------------ | ------------------------------------------------------- | ------------ | ------------- |
| `dashboard-phone.png`          | `artifacts/docs-dashboard/dashboard-phone.png`          | 390 × 844    | 2×            |
| `dashboard-phone-detail.png`   | `artifacts/docs-dashboard/dashboard-phone-detail.png`   | 390 × 844    | 2×            |
| `dashboard-ipad-portrait.png`  | `artifacts/docs-dashboard/dashboard-ipad-portrait.png`  | 1024 × 1366  | 2×            |
| `dashboard-ipad-landscape.png` | `artifacts/docs-dashboard/dashboard-ipad-landscape.png` | 1366 × 1024  | 2×            |

脚本会自动启动并关闭独立的本地 Vite 服务和浏览器。重新生成后检查图片，再将以上四张图复制到 `docs/images/`；中英文 README 共用同一组图片。

The script starts and stops its own local Vite server and browser. Inspect the output before copying the four PNGs to `docs/images/`. Both READMEs share these assets.
