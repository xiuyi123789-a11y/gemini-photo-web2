import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import Replicate from 'replicate';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// CRITICAL: Use process.env.PORT for Zeabur deployment
const PORT = process.env.PORT || 3001;

// Initialize Replicate client (Fallback)
const defaultReplicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// Helper to get Replicate client for request
const getReplicateClient = (req) => {
    const token = req.headers['x-replicate-token'];
    if (token) {
        return new Replicate({ auth: token });
    }
    // Fallback to server token if available
    if (process.env.REPLICATE_API_TOKEN) {
        return defaultReplicate;
    }
    throw new Error('Replicate API token is missing. Please provide it in the settings.');
};

// --- Middleware ---
app.use(cors({
    origin: '*', // Allow all origins for now, tighten this in production if needed
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-replicate-token', 'x-user-id']
}));
app.use(express.json({ limit: '50mb' })); // Increase limit for base64 images
app.use(express.urlencoded({ extended: true }));

// 2. Multer Configuration (Critical for file uploads)
const upload = multer({
  storage: multer.memoryStorage(), // Store in memory for speed
  limits: { fileSize: 50 * 1024 * 1024 } // Limit to 50MB
});

// Debug middleware to log headers
app.use((req, res, next) => {
    console.log(`[Request] ${req.method} ${req.path}`);
    // console.log('[Headers] x-replicate-token present:', !!req.headers['x-replicate-token']);
    next();
});

// --- Directories ---
const DATA_DIR = path.join(__dirname, '../data');
const DIST_DIR = path.join(__dirname, '../dist'); // Frontend build directory

// Helper to get user directory
const getUserDir = (userId) => path.join(DATA_DIR, userId);
const getUserImagesDir = (userId) => path.join(DATA_DIR, userId, 'images');
const getUserKnowledgeFile = (userId) => path.join(DATA_DIR, userId, 'knowledge.json');
const ERROR_NOTEBOOK_PATH = path.join(DATA_DIR, 'error_notebook.json');

// Ensure data directory exists
fs.ensureDirSync(DATA_DIR);

// In-memory job store for async upscaling
const UPSCALE_JOBS = new Map(); // jobId -> { status, imageUrl?, error?, createdAt }

// --- Helpers ---

// Middleware to validate userId
const validateUserId = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(400).json({ error: 'Missing x-user-id header' });
  }
  // Basic validation to prevent path traversal
  if (!/^[a-zA-Z0-9-]+$/.test(userId)) {
    return res.status(400).json({ error: 'Invalid userId format' });
  }
  req.userId = userId;
  next();
};

// Helper to save Replicate output (Stream or URL) to local file
const saveReplicateOutput = async (outputItem, userId) => {
  if (!outputItem) return null;

  try {
    const filename = `${uuidv4()}.png`;
    const imagesDir = getUserImagesDir(userId);
    await fs.ensureDir(imagesDir);
    const filePath = path.join(imagesDir, filename);

    let buffer;
    if (typeof outputItem === 'string') {
        // If it's a URL, download it
        console.log(`Downloading generated image from: ${outputItem}`);
        const response = await fetch(outputItem);
        if (!response.ok) throw new Error(`Failed to download image: ${response.statusText}`);
        buffer = await response.arrayBuffer();
    } else {
        // If it's a stream/blob/buffer
        buffer = await new Response(outputItem).arrayBuffer();
    }

    await fs.writeFile(filePath, Buffer.from(buffer));
    console.log(`Saved generated image to: ${filePath}`);
    return `/api/images/${userId}/${filename}`;
  } catch (error) {
    console.error('Error saving Replicate output:', error);
    throw error;
  }
};

// Helper to execute Replicate operations with retry logic for 429 errors
const executeWithRetry = async (operation, maxRetries = 10) => {
    let retries = 0;
    while (true) {
        try {
            return await operation();
        } catch (error) {
            // Check for 429 status or rate limit message
            const isRateLimit = error.status === 429 || 
                                (error.message && error.message.includes('429')) ||
                                (error.response && error.response.status === 429);
            
            if (isRateLimit) {
                retries++;
                if (retries > maxRetries) {
                    console.error(`[Replicate] Max retries (${maxRetries}) exceeded for rate limit.`);
                    throw error;
                }
                
                // Default backoff: 2s, 4s, 8s...
                let delay = 2000 * Math.pow(1.5, retries - 1); 
                
                // Try to extract retry_after from error
                try {
                    // Check headers if available
                    if (error.response && error.response.headers) {
                        const retryHeader = error.response.headers.get('retry-after');
                        if (retryHeader) {
                            delay = (parseInt(retryHeader, 10) + 1) * 1000;
                        }
                    }
                    // Check message for "retry_after" JSON field
                    const match = error.message && error.message.match(/"retry_after":\s*(\d+)/);
                    if (match) {
                        delay = (parseInt(match[1], 10) + 1) * 1000;
                    }
                } catch (e) {
                    // Ignore parsing errors
                }

                console.log(`[Replicate] Rate limit hit (429). Retrying in ${Math.round(delay)}ms... (Attempt ${retries}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
};

// Helper to run Replicate prediction with polling for better error handling
const runReplicatePrediction = async (client, modelPath, input) => {
    console.log(`Starting prediction for model: ${modelPath}`);
    
    let versionId;
    
    // Check if modelPath contains a version hash (owner/name:version)
    if (modelPath.includes(':')) {
        versionId = modelPath.split(':')[1];
    } else {
        // Fetch latest version dynamically if no hash provided
        try {
            const [owner, name] = modelPath.split('/');
            const modelData = await executeWithRetry(() => client.models.get(owner, name));
            if (!modelData.latest_version) {
                throw new Error('Model has no latest version');
            }
            versionId = modelData.latest_version.id;
        } catch (e) {
            console.error(`Error resolving version for ${modelPath}:`, e);
            throw new Error(`Failed to resolve latest version for ${modelPath}`);
        }
    }

    let prediction = await executeWithRetry(() => client.predictions.create({
        version: versionId,
        input: input
    }));

    console.log(`Prediction created: ${prediction.id}`);

    // Poll for completion
    while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled') {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        prediction = await executeWithRetry(() => client.predictions.get(prediction.id));
    }

    if (prediction.status === 'failed' || prediction.status === 'canceled') {
        console.error('Prediction failed/canceled:', prediction.error);
        throw new Error(`Prediction failed: ${prediction.error || 'Unknown error'}`);
    }

    try {
        console.log('[Replicate] Prediction result summary:', JSON.stringify({
            id: prediction.id,
            status: prediction.status,
            outputType: typeof prediction.output,
            outputIsArray: Array.isArray(prediction.output),
            outputPreview: Array.isArray(prediction.output) ? prediction.output.slice(0,1) : prediction.output
        }, null, 2));
    } catch {}
    return prediction.output;
};

// ==========================================
// 🚨 API ROUTES 🚨
// ==========================================

// 1. Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', port: PORT, timestamp: new Date().toISOString() });
});

// 2. POST /api/analyze-image (Vision Analysis - UPGRADED)
app.post('/api/analyze-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '未接收到图片文件' });
    }

    console.log(`[Server] 收到图片: ${req.file.originalname} (${req.file.size} bytes)`);

    const mimeType = req.file.mimetype;
    const base64Image = req.file.buffer.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64Image}`;

    console.log('[Server] 正在调用 Replicate 模型 (openai/gpt-4o-mini)...');
    
    const replicateClient = getReplicateClient(req);

    const SYSTEM_PROMPT = `你是一个专门为「图像生成模型」服务的【图像理解与提示词工程智能体】。输出以“可复刻”为第一优先级，其次便于穿搭迁移，再次是描述完整好读。全程使用中文描述，可夹带少量英语技术词。不要虚构图像中看不到的品牌、具体地点或人物身份。`;

    const USER_INSTRUCTION = `
你是一个专门为「图像生成模型」服务的【图像理解与提示词工程智能体】。 
 
【核心目标】 
- 输入：一张图片（以穿搭图、好物分享图、多角度人物图为主）。 
- 输出：一段结构化、中文为主的「图像理解 Prompt」，用于在文生图 / 图生图模型中复刻或延展这张图片。 
- 输出要以“可复刻”为第一优先级，其次是便于穿搭迁移，再次是描述完整好读。 
 
【默认设定】 
1. 默认人物类型：年轻亚洲女性。 
2. 默认整体气质：小红书高级网红风格——精致、高级感、生活化，不是影楼写真大片。 
3. 默认任务：尽可能高相似度地复刻原图的： 
   - 主体特征 
   - 服装与关键单品 
   - 姿势与构图 
   - 光线氛围与后期风格 
 
如果图像明显不符上述默认（如男性、多人物、纯静物等），请在【主体 / Subject】中显式说明“本图不符合默认设定”，但仍按同样结构拆解。 
 
【输出结构（必须严格遵守）】 
 
在每次回答中，你只输出一段文本，包含以下内容，标题和顺序必须固定： 
 
第一行：画质与风格前缀（可视图像略调），示例结构： 
(照片级写实:1.3), (masterpiece:1.2), (best quality:1.2), 8k，超高细节，真实皮肤与布料质感，不插画风、不动漫风， 
默认人物为年轻亚洲女性，大长腿，170CM，C罩杯，有马甲线，腰很细，小红书高级网红风格。 
 
随后依次输出以下七个部分，每个部分用方括号标题开头，并用自然语言描述： 
 
【主体 / Subject】 
- 说明：人物/主要物体的核心信息。 
- 至少包括： 
  - 性别、年龄段（大致）、身材体型。 
  - 气质标签（如：日常随性、高级网红、运动感、酷飒、职场等）。 
  - 是否露脸？如果露脸，描述脸型、五官大致特征、妆面风格；如果不露脸，说明裁切到哪里。 
  - 若画面主体并非单人亚洲女性，要明确说明（例如：多人、男性、纯静物等）。 
 
【姿势与动作 / Pose & Action】 
- 说明：身体姿态、手脚动作、是否 POV 或对镜自拍。 
- 需要描述： 
  - 姿势：站/坐/躺/跪/蹲，正对/侧对/背对，是否弯腰、仰头、低头、扭身。 
  - 手部：手在做什么、拿什么、放在哪里、动作是自然/刻意/摆拍。 
  - 腿部：并拢、分开、交叉、弯曲、翘腿等。 
  - 如有明显动作（甩头发、走路、跳跃、伸展等），要点明动作感和方向。 
 
【场景与环境 / Scene & Environment】 
- 说明：场景位置和环境细节。 
- 需要描述： 
  - 室内/室外，大致类型：卧室、客厅、街道、地铁、健身房、咖啡店、商场、楼顶等。 
  - 前景和背景中的关键物件：树、建筑、栏杆、镜子、桌椅、健身器械、橱窗、城市灯光等。 
  - 地面/墙面/背景材质：木地板、瓷砖、混凝土、草地、地毯、玻璃幕墙等。 
  - 环境整洁度：极简干净 / 日常略杂 / 非常凌乱。 
  - 如有重要“好物”或产品（包、鞋、耳机、相机、饮料等），说明其位置与存在感。 
 
【构图与镜头 / Composition & Camera】 
- 说明：从哪里看、拍到哪里、如何裁切。 
- 需要描述： 
  - 视角：第一人称 POV、对镜自拍、第三人称平视、俯拍、仰拍、极度仰视等。 
  - 取景范围：全身、半身、三分之二身、只拍腿、只拍上半身、只拍某部位。 
  - 裁切位置：头部是否入镜，裁到肩/胸/腰/膝/脚等。 
  - 构图：人物是否居中、偏左/右、是否有明显对称、三分法、留白。 
  - 景深：背景虚化程度，是否有明显前景虚化（例如植物、栏杆）。 
  - 若是多角度拍摄的一张，需要说明相机相对人物的高度与方向（如“从右前方略俯拍”、“从下往上极端仰拍”）。 
 
【光照与氛围 / Lighting & Atmosphere】 
- 说明：光源类型、方向、柔硬程度与整体情绪。 
- 需要描述： 
  - 光源：自然光/室内灯/霓虹灯/闪光灯/车灯等。 
  - 光线方向：从左/右/前/后/上方/逆光/侧逆光。 
  - 光线性质：柔和漫射光 / 强烈直射光 / 点光源 / 多光源混合。 
  - 阴影情况：阴影是否明显、边缘硬/软、是否有轮廓光。 
  - 色温与调色：偏暖/偏冷/偏灰、是否有明显滤镜（如暖黄、青橙、冷蓝、黑金等）。 
  - 氛围关键词：轻松、慵懒、运动、清冷、梦幻、夜店、城市霓虹、INS 氛围感等。 
 
【服装与造型 / Clothing & Styling】 
- 说明：逐件拆解穿搭与配饰，这是穿搭与好物场景的重点。 
- 需要尽可能细分： 
  - 上衣：类型（T 恤、衬衫、毛衣、吊带、短款上衣、夹克、风衣等）、版型（紧身/宽松/短款/长款）、颜色、材质（针织、棉、真丝、皮革、羽绒、纱等）、图案（纯色、条纹、格子、豹纹、字母印花、图案印花等）。 
  - 下装：裤/裙类型、长度（超短/短/中长/长）、版型（直筒、阔腿、紧身、A 字）、颜色与材质。 
  - 鞋：运动鞋、高跟鞋、短靴、长靴、乐福鞋、凉鞋、拖鞋等，颜色、材质和重点细节。 
  - 包与配饰：手提包、腋下包、斜挎包、腰包、帽子、围巾、腰带、手表、耳环、项链、戒指等，说明它们的位置、大小、风格（通勤、街头、甜美、酷感、户外机能等）。 
  - 发型与妆容（在能看见脸/头发的情况下）：头发长短、卷直、颜色、扎法，妆容大致风格。 
- 对“产品/好物”要特别指出：例如一只重点展示的包、一副耳机、一条项链、一双鞋，要描述其造型、颜色、质感和摆放方式。 
 
【风格与后期 / Style & Post-processing】 
- 说明：整体风格标签与后期处理味道。 
- 需要描述： 
  - 整体风格：如“小红书高级网红风”、“韩系日常通勤”、“健身博主身材记录”、“街头潮流穿搭”、“纯欲氛围”、“复古胶片风”等。 
  - 画质：手机直出感 / 高清单反 / 带颗粒的胶片感 / 明显滤镜风 / 轻微柔焦等。 
  - 调色：偏暖、偏冷、低饱和、高饱和、高对比、低对比、复古色等。 
  - 特效：镜头光晕、泛光、暗角、光斑、光线条纹、景深特效等。 
  - 明确说明「不是」的风格，例如：不是动漫风、不是夸张赛博朋克风、不是影楼强修风、不是过度磨皮。 
 
【权重使用规则】 
- 你可以在特别重要的关键词上使用类似 Stable Diffusion 风格的权重标记 (关键词:1.3)。 
- 建议： 
  - 将视角、构图方式、人物是否露脸、关键穿搭单品与整体风格等重点加权到 1.2–1.6。 
  - 不要对所有词都加权，保持每个 Prompt 中约 5–10 个关键权重即可。 
 
【负向约束写法】 
- 由于有些下游模型没有专门的 Negative Prompt 区域，你需要在描述中自然加入“不要什么”的说法，例如： 
  - “不插画风、不动漫风、不夸张赛博朋克色彩” 
  - “不是影楼写真风，不是过度磨皮网红滤镜” 
- 用中文自然描述，不需要单独列出 Negative Prompt 段落。 
 
【风格要求】 
- 全程使用中文描述，可以夹带少量英语技术词（如 POV、DOF、film look），但不要大段英文。 
- 语言力求客观、具体、工程化，避免泛泛而谈的“好看、漂亮、氛围拉满”，除非在【风格与后期】中用作氛围补充。 
- 不虚构图像中看不到的品牌、具体地点或人物身份；不对人物真实信息（姓名、职业等）做猜测。 
- 输出不包含 JSON、列表编号，只需按照上述标题顺序分段输出自然语言文字。
`;

    // Prepare input for openai/gpt-4o-mini
    const input = {
        top_p: 1,
        prompt: req.body.prompt || USER_INSTRUCTION, // 优先使用前端传入的 prompt，否则使用默认详细指令
        messages: [],
        image_input: [dataUri],
        temperature: 0.2,
        system_prompt: SYSTEM_PROMPT, // 使用新的角色设定
        presence_penalty: 0,
        frequency_penalty: 0,
        max_completion_tokens: 3000 // 增加 Token 限制以允许详细输出
    };

    // Prefer streaming to avoid timeouts and capture incremental output
    let analysisText = '';
    try {
      for await (const event of await executeWithRetry(() => replicateClient.stream("openai/gpt-4o-mini", { input }))) {
        analysisText += String(event || '');
      }
    } catch (e) {
      // Fallback to run when stream is not supported
      const output = await executeWithRetry(() => replicateClient.run("openai/gpt-4o-mini", { input }));
      analysisText = Array.isArray(output) ? output.join('') : String(output);
    }
    console.log('[Server] 分析完成');

    res.json({
      success: true,
      analysis: analysisText
    });

  } catch (error) {
    console.error('[Server Error]', error);
    res.status(500).json({
      success: false,
      error: error.message || '智能解析服务出错'
    });
  }
});

// 2.1. POST /api/sd-prompt-from-image (Generate SD Positive/Negative Prompts)
app.post('/api/sd-prompt-from-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '未接收到图片文件' });
    }
    const replicateClient = getReplicateClient(req);
    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

    const ROLE_AND_OBJECTIVE = `
You are an advanced Stable Diffusion Prompt Engineer (CLIP Interrogator). Your goal is to analyze input images and generate highly detailed, weighted prompt tags optimized for SDXL/Automatic1111. You must "think like a machine" and strictly follow the weighting and logic rules below.

1. Positive Prompt Guidelines (Detailed & Weighted):
- Format: Use comma-separated tags only. No natural language sentences.
- Mandatory Weighting: You MUST use the syntax (keyword:weight) for key elements.
- Base weight: 1.0 (no brackets needed).
- Emphasis: Use 1.1 to 1.3 for main subjects.
- Strong Emphasis: Use 1.4 to 1.5 for defining artistic styles or crucial details.
- Standard Starter: Always start with: (masterpiece, best quality, highres:1.2), 8k, ultra detailed.
- Mandatory Human Attributes (CRITICAL): If a human is present, you MUST identify and describe: Race/Ethnicity, Age, Skin Tone, Body Features; Visual Details for texture, lighting, clothes, background.

2. Negative Prompt Logic (Anti-Completion & Quality):
- Global Negatives (Always Include): test, watermark, (text:1.2), (worst quality, low quality, normal quality:1.4), lowres, (jpeg artifacts:1.2), (signature:1.2), username, blurry, artist name.
- Partial Body / Cropping (CRITICAL): If only part of body is visible, add negatives for missing parts with high weight (1.5).
- Framing & Composition: Always add (out of frame:1.5), (cropped:1.5) unless explicitly artistic cropped view.
- NSFW policy: DO NOT add nsfw or nude to the negative prompt.

3. Output Format:
Strictly output a JSON object:
{
  "positive_prompt": "string of tags with weights",
  "negative_prompt": "string of tags with weights"
}
`.trim();

    const input = {
      top_p: 1,
      prompt: ROLE_AND_OBJECTIVE,
      messages: [],
      image_input: [dataUri],
      temperature: 0.2,
      system_prompt: 'Return STRICT JSON ONLY. No extra text.',
      presence_penalty: 0,
      frequency_penalty: 0,
      max_completion_tokens: 1200
    };

    let raw = '';
    try {
      for await (const event of await executeWithRetry(() => replicateClient.stream('openai/gpt-4o-mini', { input }))) {
        raw += String(event || '');
      }
    } catch (e) {
      const output = await executeWithRetry(() => replicateClient.run('openai/gpt-4o-mini', { input }));
      raw = Array.isArray(output) ? output.join('') : String(output);
    }

    const tryParseJson = (text) => {
      try {
        return JSON.parse(text);
      } catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
          try {
            return JSON.parse(text.slice(start, end + 1));
          } catch {
            return null;
          }
        }
        return null;
      }
    };

    const parsed = tryParseJson(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.positive_prompt || !parsed.negative_prompt) {
      return res.status(500).json({ error: '解析失败：模型未返回规范 JSON', details: raw.slice(0, 300) });
    }

    res.json({ success: true, positive_prompt: parsed.positive_prompt, negative_prompt: parsed.negative_prompt });
  } catch (error) {
    console.error('[Server Error] sd-prompt-from-image', error);
    res.status(500).json({ success: false, error: error.message || '提示词生成服务出错' });
  }
});

app.post('/api/merge-generation-understanding', validateUserId, async (req, res) => {
  try {
    const replicateClient = getReplicateClient(req);
    const prompt = (req.body && req.body.prompt) ? String(req.body.prompt) : '';

    if (!prompt.trim()) {
      return res.status(400).json({ error: 'Missing prompt' });
    }

    const SYSTEM_PROMPT = `你是一个为「图像生成模型」服务的多参考图融合器。只使用输入内容中的事实与约束，不得补全或猜测。输出必须是中文自然语言，且只输出最终可复刻提示词文本。`;

    const input = {
      top_p: 1,
      prompt,
      messages: [],
      temperature: 0.2,
      system_prompt: SYSTEM_PROMPT,
      presence_penalty: 0,
      frequency_penalty: 0,
      max_completion_tokens: 2500
    };

    let text = '';
    try {
      for await (const event of await executeWithRetry(() => replicateClient.stream("openai/gpt-4o-mini", { input }))) {
        text += String(event || '');
      }
    } catch (e) {
      const output = await executeWithRetry(() => replicateClient.run("openai/gpt-4o-mini", { input }));
      text = Array.isArray(output) ? output.join('') : String(output);
    }
    res.json({ success: true, analysis: text });
  } catch (error) {
    console.error('[Server Error] merge-generation-understanding', error);
    res.status(500).json({ success: false, error: error.message || '合并理解服务出错' });
  }
});

app.post('/api/task-chat', validateUserId, async (req, res) => {
  try {
    const replicateClient = getReplicateClient(req);
    const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];

    const messages = rawMessages
      .filter((m) => m && typeof m === 'object')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : ''
      }))
      .filter((m) => m.content.trim().length > 0)
      .slice(-20);

    const maxCompletionTokens = Number.isFinite(Number(req.body?.max_completion_tokens)) ? Number(req.body.max_completion_tokens) : 1200;

    const SYSTEM = `你是电商图片任务型对话智能体。你的职责是：识别意图、补全关键槽位、在信息齐全时产出可用于图像生成器的最终提示词。\n\n你必须且只能输出一个 JSON 对象，不要 markdown，不要解释，不要多余文本。\n\n输出格式二选一：\n1) 需要追问时：{\"type\":\"clarify\",\"missing_slots\":[\"aspect_ratio\",\"style\"],\"question\":\"...\"}\n2) 可以生成时：{\"type\":\"generate\",\"aspect_ratio\":\"3:4\",\"prompt\":\"...\"}\n\n规则：\n- aspect_ratio 只能是 1:1 / 3:4 / 9:16 之一。\n- style 必须是清晰可执行的风格词（如：科技感、极简、轻奢、清新、复古胶片）。\n- 若用户没有明确给出 aspect_ratio 或 style，就必须输出 clarify 并在 question 里一次性把缺的都问完。\n- 当用户给出补充信息后，应输出 generate，并把商品信息与用户补充合并成最终 prompt。\n- 生成 prompt 时，优先保留用户输入的事实与约束，不要虚构品牌、参数或场景。`;

    const input = {
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      max_completion_tokens: Math.max(256, Math.min(4000, maxCompletionTokens))
    };

    const output = await executeWithRetry(() => replicateClient.run('openai/gpt-4o-mini', { input }));
    const text = Array.isArray(output) ? output.join('') : output.toString();
    res.json({ success: true, text });
  } catch (error) {
    console.error('[Server Error] task-chat', error);
    res.status(500).json({ success: false, error: error.message || '任务对话服务出错' });
  }
});

// 3. POST /api/generate-image (Image Generation)
app.post('/api/generate-image', validateUserId, async (req, res) => {
    try {
        const replicateClient = getReplicateClient(req);
        const { prompt, aspect_ratio, image_input } = req.body;

        // Using 'google/nano-banana' as requested
        const model = "google/nano-banana";
        const input = {
            prompt: prompt,
            aspect_ratio: aspect_ratio || "3:4",
            output_format: "jpg",
            ...(image_input && Array.isArray(image_input) && image_input.length > 0 ? { image_input } : {})
        };

        console.log(`Generating with ${model}, input:`, JSON.stringify(input, null, 2));

        const output = await runReplicatePrediction(replicateClient, model, input);
        
        let outputUrl;
        if (Array.isArray(output)) {
            outputUrl = output[0];
        } else if (typeof output === 'object' && output.url) {
            outputUrl = output.url();
        } else {
            outputUrl = output;
        }

        if (!outputUrl || typeof outputUrl !== 'string') {
            throw new Error(`Invalid output from Replicate: ${JSON.stringify(output)}`);
        }

        const imageUrl = await saveReplicateOutput(outputUrl, req.userId);
        
        res.json({ imageUrl });
        
    } catch (error) {
        console.error('Generation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. POST /api/retouch-image (Image-to-Image / Inpainting)
app.post('/api/retouch-image', validateUserId, async (req, res) => {
    try {
        const replicateClient = getReplicateClient(req);
        const { image, mask, prompt, strength, image_input } = req.body;
        
        let input;
        let model;

        if (mask) {
            // Inpainting mode using Flux Fill
            console.log('Using Inpainting Mode (Flux Fill)');
            model = "black-forest-labs/flux-fill-dev";
            input = {
                image: image,
                mask: mask,
                prompt: prompt,
                guidance: 30,
                output_format: "jpg",
                aspect_ratio: "match_input_image"
            };
        } else {
            // Creative Mode
            console.log('Using Creative Mode (google/nano-banana)');
            model = "google/nano-banana";

            const inputs = [image];
            if (image_input && Array.isArray(image_input)) {
                inputs.push(...image_input);
            }

            input = {
                prompt: prompt,
                image_input: inputs,
                aspect_ratio: "match_input_image",
                output_format: "jpg",
                prompt_strength: strength || 0.75 // Restore strength parameter for 1.1.0 logic
            };
        }

        console.log(`Retouching with ${model}`);

        const output = await runReplicatePrediction(replicateClient, model, input);
        
        let outputUrl;
        if (Array.isArray(output)) {
            outputUrl = output[0];
        } else if (typeof output === 'object' && output.url) {
            outputUrl = output.url();
        } else {
            outputUrl = output;
        }

        if (!outputUrl || typeof outputUrl !== 'string') {
            throw new Error(`Invalid output from Replicate: ${JSON.stringify(output)}`);
        }

        const imageUrl = await saveReplicateOutput(outputUrl, req.userId);
        res.json({ imageUrl });

    } catch (error) {
        console.error('Retouch error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/upscale-image', validateUserId, async (req, res) => {
    try {
        const { model, image, params } = req.body || {};

        if (!model || !image) {
            return res.status(400).json({ error: '缺少必要参数：model / image' });
        }

        const replicateClient = getReplicateClient(req);

        const parsed = typeof image === 'string'
            ? image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
            : null;
        const mimeType = parsed?.[1] || 'image/png';
        const base64Data = parsed?.[2] || (typeof image === 'string' ? image : '');
        if (!base64Data || typeof base64Data !== 'string') {
            return res.status(400).json({ error: '图片数据无效' });
        }
        const imageDataUri = `data:${mimeType};base64,${base64Data}`;

        const safeParams = (params && typeof params === 'object') ? params : {};

        let output;

        if (model === 'real-esrgan') {
            console.log('[Upscale] Using Real-ESRGAN, scale:', safeParams.scale);

            // Resolve latest version id and run
            const modelInfo = await executeWithRetry(() => replicateClient.models.get('nightmareai', 'real-esrgan'));
            const versionId = modelInfo?.latest_version?.id;
            if (!versionId) throw new Error('Failed to resolve version for real-esrgan');
            output = await executeWithRetry(() => replicateClient.run(
                `nightmareai/real-esrgan:${versionId}`,
                {
                    input: {
                        image: imageDataUri,
                        scale: Number.isFinite(Number(safeParams.scale)) ? Number(safeParams.scale) : 2,
                        face_enhance: Boolean(safeParams.face_enhance)
                    }
                }
            ));
        } else if (model === 'clarity-upscaler') {
            console.log('[Upscale] Using Clarity Upscaler, scale_factor:', safeParams.scale_factor);

            const handfix =
                safeParams.handfix === 'hands_only' || safeParams.handfix === 'image_and_hands'
                    ? safeParams.handfix
                    : 'disabled';
            const outputFormat =
                safeParams.output_format === 'webp' || safeParams.output_format === 'jpg'
                    ? safeParams.output_format
                    : 'png';
            const tilingWidth = Number.isFinite(Number(safeParams.tiling_width)) ? Number(safeParams.tiling_width) : 112;
            const tilingHeight = Number.isFinite(Number(safeParams.tiling_height)) ? Number(safeParams.tiling_height) : 144;
            const downscalingResolution = Number.isFinite(Number(safeParams.downscaling_resolution))
                ? Number(safeParams.downscaling_resolution)
                : 768;
            const downscaling = downscalingResolution > 0;

            const modelInfo = await executeWithRetry(() => replicateClient.models.get('philz1337x', 'clarity-upscaler'));
            const versionId = modelInfo?.latest_version?.id;
            if (!versionId) throw new Error('Failed to resolve version for clarity-upscaler');
            output = await executeWithRetry(() => replicateClient.run(
                `philz1337x/clarity-upscaler:${versionId}`,
                {
                    input: {
                        image: imageDataUri,
                        prompt: typeof safeParams.prompt === 'string' ? safeParams.prompt : 'masterpiece, best quality, highres',
                        negative_prompt: typeof safeParams.negative_prompt === 'string'
                            ? safeParams.negative_prompt
                            : '(worst quality, low quality, normal quality:2) JuggernautNegative-neg',
                        scale_factor: Number.isFinite(Number(safeParams.scale_factor)) ? Number(safeParams.scale_factor) : 2,
                        dynamic: Number.isFinite(Number(safeParams.dynamic)) ? Number(safeParams.dynamic) : 6,
                        creativity: Number.isFinite(Number(safeParams.creativity)) ? Number(safeParams.creativity) : 0.35,
                        resemblance: Number.isFinite(Number(safeParams.resemblance)) ? Number(safeParams.resemblance) : 0.6,
                        tiling_width: tilingWidth,
                        tiling_height: tilingHeight,
                        sd_model: typeof safeParams.sd_model === 'string'
                            ? safeParams.sd_model
                            : 'juggernaut_reborn.safetensors [338b85bc4f]',
                        scheduler: typeof safeParams.scheduler === 'string'
                            ? safeParams.scheduler
                            : 'DPM++ 3M SDE Karras',
                        num_inference_steps: Number.isFinite(Number(safeParams.num_inference_steps))
                            ? Math.max(1, Math.round(Number(safeParams.num_inference_steps)))
                            : 18,
                        seed: Number.isFinite(Number(safeParams.seed)) ? Math.round(Number(safeParams.seed)) : 1337,
                        downscaling,
                        downscaling_resolution: downscalingResolution,
                        handfix,
                        pattern: Boolean(safeParams.pattern),
                        output_format: outputFormat,
                        sharpen: 0
                    }
                }
            ));
        } else {
            return res.status(400).json({ error: '模型类型不支持，请使用 real-esrgan 或 clarity-upscaler' });
        }

        const candidate = Array.isArray(output) ? output[0] : output;
        if (!candidate) {
            throw new Error(`Invalid output from Replicate: ${JSON.stringify(output)}`);
        }
        const savedUrl = await saveReplicateOutput(candidate, req.userId);
        console.log('[Upscale] Success, output URL:', savedUrl);
        res.json({ imageUrl: savedUrl });
    } catch (error) {
        const message = (error && typeof error === 'object' && 'message' in error)
            ? String(error.message)
            : 'Upscale failed';

        const isRateLimit = error?.status === 429 ||
            (message && message.includes('429')) ||
            (error?.response && error.response.status === 429);

        if (isRateLimit) {
            let retryAfterSeconds;
            try {
                const headerVal = error?.response?.headers?.get?.('retry-after');
                if (headerVal) retryAfterSeconds = Number(headerVal) + 1;
                const match = message.match(/"retry_after":\s*(\d+)/);
                if (!retryAfterSeconds && match) retryAfterSeconds = Number(match[1]) + 1;
            } catch (e) {
            }
            if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
                res.set('Retry-After', String(Math.round(retryAfterSeconds)));
            }
            return res.status(429).json({ error: 'Replicate 请求过于频繁(429)，请稍后重试' });
        }

        if (message.includes('token') && message.includes('missing')) {
            return res.status(401).json({ error: message });
        }

        console.error('[Upscale] Error:', error);
        res.status(500).json({
            error: message || 'Upscale failed',
            details: error?.toString?.() || String(error)
        });
    }
});

// Async: start upscale job and return jobId immediately
app.post('/api/upscale-image/start', validateUserId, async (req, res) => {
  try {
    const { model, image, params } = req.body || {};
    if (!model || !image) return res.status(400).json({ error: '缺少必要参数：model / image' });
    const jobId = uuidv4();
    UPSCALE_JOBS.set(jobId, { status: 'queued', createdAt: Date.now() });
    res.status(202).json({ jobId });

    (async () => {
      try {
        const replicateClient = getReplicateClient(req);
        const parsed = typeof image === 'string' ? image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/) : null;
        const mimeType = parsed?.[1] || 'image/png';
        const base64Data = parsed?.[2] || (typeof image === 'string' ? image : '');
        const imageDataUri = `data:${mimeType};base64,${base64Data}`;
        const safeParams = (params && typeof params === 'object') ? params : {};

        let output;
        if (model === 'real-esrgan') {
          const modelInfo = await executeWithRetry(() => replicateClient.models.get('nightmareai', 'real-esrgan'));
          const versionId = modelInfo?.latest_version?.id;
          output = await executeWithRetry(() => replicateClient.run(
            `nightmareai/real-esrgan:${versionId}`,
            { input: { image: imageDataUri, scale: Number.isFinite(Number(safeParams.scale)) ? Number(safeParams.scale) : 2, face_enhance: Boolean(safeParams.face_enhance) } }
          ));
        } else if (model === 'clarity-upscaler') {
          const tilingWidth = Number.isFinite(Number(safeParams.tiling_width)) ? Number(safeParams.tiling_width) : 112;
          const tilingHeight = Number.isFinite(Number(safeParams.tiling_height)) ? Number(safeParams.tiling_height) : 144;
          const downscalingResolution = Number.isFinite(Number(safeParams.downscaling_resolution)) ? Number(safeParams.downscaling_resolution) : 768;
          const downscaling = downscalingResolution > 0;
          const handfix = safeParams.handfix === 'hands_only' || safeParams.handfix === 'image_and_hands' ? safeParams.handfix : 'disabled';
          const outputFormat = safeParams.output_format === 'webp' || safeParams.output_format === 'jpg' ? safeParams.output_format : 'png';
          const modelInfo = await executeWithRetry(() => replicateClient.models.get('philz1337x', 'clarity-upscaler'));
          const versionId = modelInfo?.latest_version?.id;
          output = await executeWithRetry(() => replicateClient.run(
            `philz1337x/clarity-upscaler:${versionId}`,
            { input: {
              image: imageDataUri,
              prompt: typeof safeParams.prompt === 'string' ? safeParams.prompt : 'masterpiece, best quality, highres',
              negative_prompt: typeof safeParams.negative_prompt === 'string' ? safeParams.negative_prompt : '(worst quality, low quality, normal quality:2) JuggernautNegative-neg',
              scale_factor: Number.isFinite(Number(safeParams.scale_factor)) ? Number(safeParams.scale_factor) : 2,
              dynamic: Number.isFinite(Number(safeParams.dynamic)) ? Number(safeParams.dynamic) : 6,
              creativity: Number.isFinite(Number(safeParams.creativity)) ? Number(safeParams.creativity) : 0.35,
              resemblance: Number.isFinite(Number(safeParams.resemblance)) ? Number(safeParams.resemblance) : 0.6,
              tiling_width: tilingWidth,
              tiling_height: tilingHeight,
              sd_model: typeof safeParams.sd_model === 'string' ? safeParams.sd_model : 'juggernaut_reborn.safetensors [338b85bc4f]',
              scheduler: typeof safeParams.scheduler === 'string' ? safeParams.scheduler : 'DPM++ 3M SDE Karras',
              num_inference_steps: Number.isFinite(Number(safeParams.num_inference_steps)) ? Math.max(1, Math.round(Number(safeParams.num_inference_steps))) : 18,
              seed: Number.isFinite(Number(safeParams.seed)) ? Math.round(Number(safeParams.seed)) : 1337,
              downscaling,
              downscaling_resolution: downscalingResolution,
              handfix,
              pattern: Boolean(safeParams.pattern),
              output_format: outputFormat,
              sharpen: 0
            } }
          ));
        } else {
          UPSCALE_JOBS.set(jobId, { status: 'failed', error: '模型类型不支持', createdAt: Date.now() });
          return;
        }

        const candidate = Array.isArray(output) ? output[0] : output;
        const savedUrl = await saveReplicateOutput(candidate, req.userId);
        UPSCALE_JOBS.set(jobId, { status: 'succeeded', imageUrl: savedUrl, createdAt: Date.now() });
      } catch (err) {
        UPSCALE_JOBS.set(jobId, { status: 'failed', error: String(err?.message || err), createdAt: Date.now() });
      }
    })();
  } catch (error) {
    res.status(500).json({ error: error.message || '启动任务失败' });
  }
});

// Async: get result
app.get('/api/upscale-image/result/:jobId', validateUserId, (req, res) => {
  const job = UPSCALE_JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(job);
});

// 5. GET /api/knowledge
app.get('/api/knowledge', validateUserId, async (req, res) => {
  try {
    const knowledgeFile = getUserKnowledgeFile(req.userId);
    if (await fs.pathExists(knowledgeFile)) {
      const data = await fs.readJson(knowledgeFile);
      res.json(data);
    } else {
      res.json([]);
    }
  } catch (error) {
    console.error('Error reading knowledge base:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 6. POST /api/knowledge
app.post('/api/knowledge', validateUserId, async (req, res) => {
  try {
    const entries = req.body;
    if (!Array.isArray(entries)) {
      return res.status(400).json({ error: 'Expected an array of entries' });
    }

    const imagesDir = getUserImagesDir(req.userId);
    await fs.ensureDir(imagesDir);

    const processedEntries = await Promise.all(entries.map(async (entry) => {
      if (entry.sourceImagePreview && entry.sourceImagePreview.startsWith('data:image')) {
        const matches = entry.sourceImagePreview.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
        if (matches) {
          const ext = matches[1];
          const data = matches[2];
          const filename = `${uuidv4()}.${ext}`;
          const filePath = path.join(imagesDir, filename);
          
          await fs.writeFile(filePath, data, 'base64');
          
          return {
            ...entry,
            sourceImagePreview: `/api/images/${req.userId}/${filename}`
          };
        }
      }
      return entry;
    }));

    const knowledgeFile = getUserKnowledgeFile(req.userId);
    await fs.ensureDir(path.dirname(knowledgeFile));
    await fs.writeJson(knowledgeFile, processedEntries, { spaces: 2 });

    res.json(processedEntries);
  } catch (error) {
    console.error('Error saving knowledge base:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 7. Error Notebook Endpoints
app.post('/api/error-notebook', async (req, res) => {
    try {
        const { issue, solution, tags } = req.body;
        if (!issue || !solution) {
            return res.status(400).json({ error: 'Issue and solution are required' });
        }

        await fs.ensureFile(ERROR_NOTEBOOK_PATH);
        let notebook = [];
        try {
            notebook = await fs.readJson(ERROR_NOTEBOOK_PATH);
        } catch (e) {
            notebook = [];
        }

        const newEntry = {
            id: uuidv4(),
            issue,
            solution,
            timestamp: new Date().toISOString(),
            tags: tags || []
        };

        notebook.push(newEntry);
        await fs.writeJson(ERROR_NOTEBOOK_PATH, notebook, { spaces: 2 });
        
        res.json(newEntry);
    } catch (error) {
        console.error('Error writing to error notebook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/error-notebook', async (req, res) => {
    try {
        if (await fs.pathExists(ERROR_NOTEBOOK_PATH)) {
            const notebook = await fs.readJson(ERROR_NOTEBOOK_PATH);
            res.json(notebook);
        } else {
            res.json([]);
        }
    } catch (error) {
        console.error('Error reading error notebook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 8. Serve user images
app.get('/api/images/:userId/:filename', async (req, res) => {
  const { userId, filename } = req.params;
  
  if (!/^[a-zA-Z0-9-]+$/.test(userId) || !/^[a-zA-Z0-9-.]+$/.test(filename)) {
    return res.status(400).send('Invalid parameters');
  }

  const filePath = path.join(getUserImagesDir(userId), filename);
  
  if (await fs.pathExists(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Image not found');
  }
});

// ==========================================
// 🚨 STATIC FILES 🚨
// ==========================================

if (fs.existsSync(DIST_DIR)) {
    console.log('Serving static files from:', DIST_DIR);
    app.use(express.static(DIST_DIR));
} else {
    console.warn('Warning: dist directory not found. Frontend will not be served.');
}

// ==========================================
// 🚨 SPA CATCH-ALL 🚨
// ==========================================

app.get(/(.*)/, (req, res) => {
    if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
        res.sendFile(path.join(DIST_DIR, 'index.html'));
    } else {
        res.status(404).send('Frontend not found (dist directory missing)');
    }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] 服务已启动，监听端口: ${PORT}`);
});
