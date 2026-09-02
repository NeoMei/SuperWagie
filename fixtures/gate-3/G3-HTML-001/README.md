# G3-HTML-001 — 离线 HTML 与 Official Host

本 fixture 固定三种交付页面：文章、项目介绍、数据说明。`site/` 必须在断网
CSP 下正常呈现，并通过桌面/移动 viewport、可访问性、站内链接和本地资源检查。

Taste 规则输入固定为 `leonxlnx/taste-skill` commit
`ccbc15639c97057cbfcf32ecebc38ef716e4bb37`，只读取审核后的
`skills/taste-skill/SKILL.md`；不运行上游安装器、不自动更新、不接入第三方
Publisher。许可证和哈希见 `THIRD_PARTY_NOTICES.md`。

Official Host 的 preview/promote/同链接更新/rollback/revoke 必须在官网测试环境
另行执行；本地浏览器成功不能代签这些服务端步骤。
