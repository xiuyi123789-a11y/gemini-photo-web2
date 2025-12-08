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
  limits: { fileSize: 20 * 1024 * 1024 } // Limit to 20MB
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

    // --- 高级提示词配置 ---
    const SYSTEM_PROMPT = `ROLE: Senior Visual Asset Analyst & Physics Engine Specialist
(角色设定：资深视觉资产分析师与物理引擎专家。你拥有商业摄影师的布光逻辑、工业设计师的材质库、以及CG渲染师的物理参数认知。)`;

    const USER_INSTRUCTION = `
# TASK:
Perform a "Microscopic Visual Deconstruction" of the provided image.
Your goal is to extract a dataset so detailed that a 3D artist could reconstruct the scene physically, or an AI could replicate it pixel-perfectly.

# CRITICAL ANALYSIS GUIDELINES (THE "MICROSCOPE" RULE):
1. NO GENERIC ADJECTIVES: Do not say "nice skin"; say "semi-matte skin with visible pores and slight sebum shine on the T-zone".
2. MATERIAL PHYSICS: Always describe the surface interaction: Roughness, Reflectivity (IOR), Transparency, and Imperfections (scratches, dust, fingerprints).
3. LIGHT INTERACTION: Describe how light hits the object: Subsurface Scattering (SSS), Fresnel Effect, Caustics, or Anisotropy.
4. MANUFACTURING DETAILS: Look for seams, stitching, mold marks, oxidation, or wear & tear.

# ANALYSIS PROTOCOL (7-DIMENSION STRUCTURE):
1. Subject (主体): The core focus.
2. Pose & Action (姿势&动作): Tension, Gravity, Flow.
3. Scene & Environment (场景&环境): Spatial context, Surface textures.
4. Composition & Camera (构图&镜头): Focal length, Depth of Field, Angles.
5. Lighting & Atmosphere (光照&氛围): Light source, Modifiers, Mood.
6. Apparel & Styling (服装&造型): Fabric weight, Weave, Accessories.
7. Style & Post-Processing (风格&后期): Color science, Grain, Rendering style.

# OUTPUT FORMAT (STRICT TEMPLATE):
Output in **Chinese**. Use the exact structure below.
If a category is not present, explicitly write [N/A]. DO NOT HALLUCINATE.

## OUTPUT EXAMPLES (LEARN FROM THIS LEVEL OF GRANULARITY):

### Scenario A: Complex Product Still Life (e.g., Vintage Sneaker)
**1. 主体 (Subject):**
* **核心物体:** 1985年复古篮球鞋（左脚，悬浮状态）。
* **材质物理:**
  * *鞋面A:* **长绒粗糙麂皮 (Rough-out Suede)**，深灰色，表面有明显的**手指抚摸留下的色差轨迹**，绒毛在边缘处呈现不规则的**磨损泛白**。
  * *鞋面B:* **裂纹漆皮 (Cracked Leather)**，白色，随着弯折处展现出自然的**龟裂纹理**，裂缝中渗入微尘。
* **工艺细节:** 中底为 **EVA发泡材质**，表面带有**注塑模具的微细颗粒感**，且因时间久远呈现**氧化后的奶油黄**。溢胶在接缝处清晰可见。
**2. 姿势&动作 (Pose & Action):**
* **动态:** 动态悬浮，鞋尖向下倾斜 15度。
* **张力:** 鞋带并非静止下垂，而是呈现**失重漂浮状**。
**3. 场景&环境 (Scene & Environment):**
* **支撑物:** 底部有一块**破碎的混凝土块**，断面粗糙，露出内部的**骨料碎石**。
* **地面:** **黑色镜面亚克力板**，产生高反差倒影，倒影边缘带有**菲涅尔反射**导致的亮度衰减。
**4. 构图&镜头 (Composition & Camera):**
* **视角:** 微距平视。
* **焦段:** 105mm 微距红圈镜头。
* **景深:** F11 小光圈，确保鞋头到鞋跟都在焦内。
**5. 光照&氛围 (Lighting & Atmosphere):**
* **布光:** **三点布光法**。主光为硬光，强调麂皮质感；轮廓光为冷蓝色。
* **光效:** 鞋底橡胶部分呈现轻微的**次表面散射 (SSS)**，透光处偏红。
**6. 服装&造型 (Apparel & Styling):**
* [N/A - 纯产品拍摄]
**7. 风格&后期 (Style & Post-Processing):**
* **风格:** 赛博朋克工业风。
* **后期:** 强烈的**锐化处理**，色差 (Chromatic Aberration) 在画面边缘轻微可见。

### Scenario B: High-End Beauty Portrait (Extreme Close-up)
**1. 主体 (Subject):**
* **人物:** 20岁北欧女性面部特写。
* **皮肤物理:** **超写实皮肤纹理**。可见鼻翼两侧的**毛孔**、脸颊上细微的**白色绒毛**。T区有自然的**皮脂光泽**，而非均匀高光。
* **眼部:** 虹膜呈现复杂的**放射状纹理**，瞳孔外圈有深色**角膜缘环**。
**2. 姿势&动作 (Pose & Action):**
* **微表情:** 嘴唇微张，舌尖轻抵上齿。眼神**失焦**。
**3. 场景&环境 (Scene & Environment):**
* **背景:** 深炭灰色背景纸，表面有轻微的**纸张纹理**。
**4. 构图&镜头 (Composition & Camera):**
* **构图:** 紧凑构图，头顶被切断。
* **镜头:** 85mm 人像皇镜。
* **景深:** F1.2 极浅景深。焦点死锁在**左眼睫毛**上。
**5. 光照&氛围 (Lighting & Atmosphere):**
* **布光:** **雷达罩**位于正上方，形成圆环形**眼神光**。
* **氛围:** 冷艳、高贵。
**6. 服装&造型 (Apparel & Styling):**
* **妆容:** **创意湿亮妆**。眼皮上涂有透明唇蜜，产生**不规则的高光反射**。
* **配饰:** 耳骨夹，材质为**拉丝纯银**，表面有细微的划痕。
**7. 风格&后期 (Style & Post-Processing):**
* **色调:** 肤色校正为**冷白皮**，阴影偏青色。
* **质感:** 保留了**ISO 100 的细腻度**，无噪点。

### Scenario C: Atmospheric Interior (Architectural Visualization)
**1. 主体 (Subject):**
* [N/A - 空间为主体]
**2. 姿势&动作 (Pose & Action):**
* [N/A - 无生物]
**3. 场景&环境 (Scene & Environment):**
* **硬装材质:**
  * *墙面:* **微水泥**，米灰色，表面有手工涂抹的**刀触肌理**。
  * *地面:* **老旧回收木地板**，带有**虫眼**、**水渍**和**行走磨损的痕迹**。
* **软装陈设:**
  * *沙发:* **亚麻布艺**，米白色，织物纹理粗糙，坐垫处有自然的**塌陷褶皱**。
  * *玻璃:* 咖啡桌为**钢化茶色玻璃**，边缘有绿色的**切面反光**。
**4. 构图&镜头 (Composition & Camera):**
* **视角:** **两点透视**。
* **镜头:** 24mm 移轴镜头。
**5. 光照&氛围 (Lighting & Atmosphere):**
* **自然光:** 傍晚的**黄金时刻**。色温约为 3500K。
* **光影交互:** 阳光透过窗纱，形成**漫射的柔光**。地面上有窗框拉长的**硬阴影**。
* **体积光:** 空气中漂浮着**被照亮的灰尘粒子**，形成明显的**丁达尔光束**。
**6. 服装&造型 (Apparel & Styling):**
* [N/A - 无]
**7. 风格&后期 (Style & Post-Processing):**
* **风格:** 极简主义 (Wabi-sabi)。
* **后期:** 模拟 **CGI 渲染质感**，高光部分带有轻微的**柔光辉光**。

# FINAL INSTRUCTION:
Analyze the uploaded image now.
STRICTLY follow the 7-section structure above.
MANDATORY: You MUST describe materials, physics, and light interactions with the level of detail shown in the examples. Do not summarize.
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

    // Use replicate.run() for simpler execution
    const output = await executeWithRetry(() => replicateClient.run("openai/gpt-4o-mini", { input }));

    const analysisText = Array.isArray(output) ? output.join('') : output.toString();
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

// 3. POST /api/generate-image (Image Generation)
app.post('/api/generate-image', validateUserId, async (req, res) => {
    try {
        const replicateClient = getReplicateClient(req);
        const { prompt, aspect_ratio, image_input } = req.body;

        // Using 'google/nano-banana' as requested
        const input = {
            prompt: prompt,
            aspect_ratio: aspect_ratio || "3:4",
            output_format: "jpg",
            ...(image_input && Array.isArray(image_input) && image_input.length > 0 ? { image_input } : {})
        };

        console.log('Generating with google/nano-banana, input:', JSON.stringify(input, null, 2));

        const output = await runReplicatePrediction(replicateClient, "google/nano-banana", input);
        
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
                aspect_ratio: "3:4"
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
                output_format: "jpg"
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