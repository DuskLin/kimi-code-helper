# README 配图 / README images

这些图片直接复制自 `scripts/smoke.mjs` 生成的真实 Electron 界面截图，使用模拟账号、本地模拟上游和独立临时配置，不含真实账号凭据。图中的端口、日期、额度、费用和请求仅用于演示。

These images are unmodified Electron UI screenshots produced by `scripts/smoke.mjs`, using mock accounts, local mock upstreams, and isolated temporary configuration. They contain no real account credentials. Ports, dates, quotas, costs, and requests are illustrative.

| README asset          | Smoke-test source              |
| --------------------- | ------------------------------ |
| `overview-light.png`  | `artifacts/light.png`          |
| `overview-dark.png`   | `artifacts/dark.png`           |
| `account-editor.png`  | `artifacts/account-editor.png` |
| `request-history.png` | `artifacts/requests.png`       |

## 更新 / Updating

在具备图形环境与系统安全存储的机器上运行 `npm run test:smoke`，检查生成图片，再按上表复制至本目录。`artifacts/` 被 Git 忽略，因此 README 使用此目录下可跟踪的副本。中英文 README 共用图片；更新时请同时检查两份文档的说明。

Run `npm run test:smoke` on a machine with a graphical environment and system secure storage, inspect the output, then copy the mapped files here. Git ignores `artifacts/`, so the READMEs use tracked copies in this directory. Both languages share the same images; review both captions when updating them.
