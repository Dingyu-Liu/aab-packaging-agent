# 01 iOS SDK 模块

两个 profile 共用真实 01 skill 2026.11.06.1。AF 使用原文已确认的入口与 H5 契约；原 skill 明确支持 Adjust，但其入口归因结构/空值/签名/返回 URL 字段需当前工程或合作方确认，不套 AF 专属报文。App Store ID、Bundle ID、Facebook App ID分别保存。

参数来自 integration-inputs.example.json，secret 无默认值；留空表示核对工程已有配置，不拿占位符初始化。检查输出的“已验证”布尔值不是表单输入，不让用户预先宣称通过。
