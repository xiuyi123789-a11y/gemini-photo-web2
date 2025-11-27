<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1N6EJq4ehPoT-aUv4xwDE0FEykW7TIMRD

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`


更新日志 (Update Log) - 2025-11-27
本次更新主要包含两个核心模块的升级：灵感知识库存储迁移与智能修图交互重构。

1. 灵感知识库 (Knowledge Base)
存储方案升级
从 LocalStorage 迁移至后端文件系统：不再依赖浏览器缓存，数据更安全、持久。
用户数据隔离：
实现了基于 UUID 的用户身份识别。
后端自动为每个用户创建独立的数据目录 data/{userId}/。
knowledge.json 存储元数据，图片文件独立存储于 images/ 子目录，大幅优化读写性能。
API 接口改造：
新增后端 Express 服务 (端口 3001)。
更新 /api/knowledge 接口，支持基于 x-user-id 请求头的用户数据读写。
2. 智能修图 (Smart Retouch)
交互逻辑重构（解除线性限制）
输入框解锁：
图片上传后，输入框立即解除锁定，无需等待 AI 解析。
用户可随时输入、修改修图指令，拥有最高编辑优先级。
新增占位符提示："在此输入修图指令，或等待 AI 解析..."。
流程并行化：
图片上传后，后台静默运行 AI 解析，不通过 Loading 遮罩阻挡用户操作。
若用户在解析完成前已手动输入内容，AI 建议将不会覆盖用户输入。
按钮解绑：
“执行优化”按钮状态逻辑更新：只要满足 (图片已上传 AND 输入框有内容)，按钮即刻变为高亮可用状态，无需等待 AI 解析结束。
3. 技术栈更新
后端服务：引入 Express.js, fs-extra, cors, uuid。
开发环境：配置 Vite Proxy 转发 API 请求，使用 concurrently 并发运行前后端服务。
