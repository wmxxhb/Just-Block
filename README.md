# Just Block

## 功能

- 屏蔽指定网站及其子域名，支持 Chrome、Edge。
- 访问前逐题回答五个问题，再手打 200 字，把原文中的“你”全部改成“我”，禁止粘贴。
- 等待 5 分钟后手动确认，允许访问 10 分钟，到期重新屏蔽。
- 支持回看已答题目；本地历史记录触发、通过、放弃等结果和累计次数。
- 可选 Windows 系统保护，在扩展停用后保留系统屏蔽条目。

## 使用指南

1. [下载项目 ZIP](https://github.com/wmxxhb/Just-Block/archive/refs/heads/main.zip)，解压到固定位置。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式，点击“加载已解压的扩展程序”，选择含 `manifest.json` 的文件夹。
3. 点击扩展图标，在“管理网站名单”中每行填写一个域名并保存。默认屏蔽 `x.com`、`twitter.com`。
4. 打开被屏蔽的网站，依次完成验证。可从弹窗或设置页查看本地历史记录；不保存回答或完整网址。

更新时覆盖原文件，再点击扩展管理页的“重新加载”，不要先移除扩展，以保留设置和历史记录。

### Windows 系统保护（可选）

- 安装：右键 `windows/Install-Guardian.cmd`，以管理员身份运行。重启浏览器，在扩展设置中点击“连接 Windows 保护程序”。
- 升级保护程序：以管理员身份运行 `windows/Update-Guardian.cmd`。从扩展 1.1.1 及之后版本升级时，现有保护程序可继续使用。
- 卸载：先在扩展设置完成“解锁删改”，随后在 10 分钟内以管理员身份运行 `windows/Uninstall-Guardian.cmd`。
- 源码位于 `windows/JustBlock.cs`，可运行 `windows/Build.ps1` 重新编译；项目已附编译后的程序。

系统保护使用 Windows 服务和 hosts 文件，会影响其他浏览器的域名访问。代理、未列出的子域名和已有连接可能绕过，管理员也可移除保护。
