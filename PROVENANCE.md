# 发布前检查记录

## 基准与范围

以已验收的 WeRead Popular Highlights v0.7.0 为基准。原施工材料中的 `build-v07.py` 结合 `accepted-v0.6.0.user.js`、`v07-bridge-add.js` 和 `v07-ui.js`，在内存中可复现完全相同的成品。

发布脚本只增加 `@license MIT` 元数据，运行代码、脚本名称、namespace、存储键及 UI 均保持不变。单文件已包含完整源码，不分发依赖旧版本拼接的施工脚本。

基准成品 SHA-256：`d17e4a752ccd504ffcd8e999f5afb3012de8763ffa6bdc5d89ca71879135bec8`。

## 参考来源

开发期间阅读过 [chloeeee72/weread-enhancer-userscript](https://github.com/chloeeee72/weread-enhancer-userscript/tree/4d1a12572e2687a911092e47b92e02de70c9e59b)。本次固定比对提交 `4d1a12572e2687a911092e47b92e02de70c9e59b`；该树未发现许可证文件，不将其代码视为可按 MIT 再发布。

旧施工目录的 `extractor.js` 和 `layoutMap.js` 与该仓库同名文件逐字节一致，属于阅读参考材料，**未纳入发布目录，也不在成品构建依赖中**。网站 bundle、解码分析文件、页面快照和测试探针同样不分发。

## 实现比对

- **Vue/webpack reader 捕获**：参考实现主要遍历 DOM/Vue 实例，并注入临时 webpack 模块取得 require、递归扫描 store/解码器；本脚本在 document-start 包装现有 chunk factory，并拦截 Vue 2 `_init`，捕获实际 reader 实例。没有复制其临时模块注入器、实例遍历器或递归 store 扫描实现。
- **canvas / preRender**：参考实现包含预渲染 DOM 捕获、布局重建和 canvas 比例回退；本脚本不实现这些流程，直接使用现有 reader 的渲染对象、坐标转换、矩形和高亮方法。
- **decrypt / range**：双方均调用网站已有的 `decryption` 接口，这是共享的站点接口知识。本脚本独立构建 `data-wr-co` UTF-16 偏移表，以 API range 和文本校验定位，不包含参考项目或微信读书的解密算法实现。

对参考仓库 JavaScript 文件进行了非空实质代码行比对，并人工检查上述关键流程；最长连续完全相同行块只有 1 行，属于常见循环/Promise 语法。结合控制流程差异，未发现发布脚本中明显直接复制或高度近似的参考实现片段。本次范围内支持独立发布并采用 MIT，无需改写运行逻辑；这不是对所有第三方来源的穷尽性法律审查。

## 隐私与测试值

发布目录不包含真实 API Key、静态 Authorization 凭据、Cookie、会话值、账号快照或私人绝对路径。脚本中的 `wrk-` 是格式提示，Authorization 值在运行时从 GM storage 生成。未读取浏览器 Cookie 或 Tampermonkey GM storage。

生产脚本未包含 bookId `834436`、chapterUid `441`、range `1393-1489` 或 Harry Potter 专用分支。书籍和章节由当前 reader 提供，range 由官方 API 返回。旧页面快照中的测试书籍信息不纳入发布。

仅新增许可证元数据和文档，运行逻辑与基准一致，因此无需重新进行浏览器完整验收。最终发布脚本使用 `node --check` 验证。
