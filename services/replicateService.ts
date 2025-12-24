import { AnalysisResult, KnowledgeBaseAnalysis, KnowledgeBaseCategory } from '../types';
import { getKnowledgeBase } from './knowledgeBaseService';
import { addToErrorNotebook } from './errorNotebookService';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

type RetryOptions = {
    retries?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
    timeoutMs?: number;
};

const IMAGE_UNDERSTANDING_PROMPT = `
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
`.trim();

const getUserId = () => {
    return localStorage.getItem('userId') || 'default-user';
};

const getReplicateApiKey = () => {
    return localStorage.getItem('replicate_api_token') || '';
};

const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

const getBackoffDelayMs = (attempt: number, minDelayMs: number, maxDelayMs: number) => {
    const exp = minDelayMs * Math.pow(2, Math.max(0, attempt - 1));
    const capped = Math.min(maxDelayMs, exp);
    const jitter = capped * (0.2 * (Math.random() - 0.5) * 2);
    return Math.max(0, Math.round(capped + jitter));
};

const isRetryableStatus = (status: number) => {
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
};

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        window.clearTimeout(timer);
    }
};

const requestWithRetry = async (makeRequest: (attempt: number) => Promise<Response>, options?: RetryOptions) => {
    const retries = Math.max(0, options?.retries ?? 3);
    const minDelayMs = Math.max(0, options?.minDelayMs ?? 800);
    const maxDelayMs = Math.max(minDelayMs, options?.maxDelayMs ?? 8000);

    let lastError: unknown;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            const response = await makeRequest(attempt);
            if (response.ok) return response;

            if (isRetryableStatus(response.status) && attempt <= retries) {
                const retryAfterHeader = response.headers.get('retry-after');
                const retryAfterMs = retryAfterHeader ? (Number(retryAfterHeader) + 1) * 1000 : 0;
                const backoffMs = getBackoffDelayMs(attempt, minDelayMs, maxDelayMs);
                await sleep(Math.max(backoffMs, retryAfterMs));
                continue;
            }

            const errorData = await response.json().catch(() => ({} as any));
            throw new Error(errorData?.error || `API call failed: ${response.status} ${response.statusText}`);
        } catch (error) {
            lastError = error;
            const isAbort = error instanceof DOMException && error.name === 'AbortError';
            const isNetworkError = error instanceof TypeError;

            if ((isAbort || isNetworkError) && attempt <= retries) {
                const delayMs = getBackoffDelayMs(attempt, minDelayMs, maxDelayMs);
                await sleep(delayMs);
                continue;
            }

            throw error;
        }
    }

    throw lastError instanceof Error ? lastError : new Error('Request failed');
};

const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = error => reject(error);
    });
};

const urlToBase64 = async (url: string): Promise<string> => {
    if (url.startsWith('data:')) return url;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.statusText}`);
        }
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error("Error converting URL to base64:", error);
        throw error; // Throw error instead of returning URL, to stop generation with invalid input
    }
};

const callApi = async (endpoint: string, body: any, stream: boolean = false, retryOptions?: RetryOptions) => {
    const userId = getUserId();
    const apiKey = getReplicateApiKey();
    const headers: any = {
        'Content-Type': 'application/json',
        'x-user-id': userId
    };

    if (apiKey) {
        headers['x-replicate-token'] = apiKey;
    }

    const fullUrl = API_BASE_URL.startsWith('http') 
        ? `${API_BASE_URL}${endpoint}`
        : `${window.location.origin}${API_BASE_URL}${endpoint}`;
        
    console.log(`[Frontend] Calling ${fullUrl}`);
    console.log(`[Frontend] Headers:`, { 
        'x-user-id': userId,
        'x-replicate-token': apiKey ? '(present)' : '(missing)'
    });

    const response = await requestWithRetry(
        async () => {
            return await fetchWithTimeout(
                fullUrl,
                {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body)
                },
                retryOptions?.timeoutMs ?? 120000
            );
        },
        retryOptions
    );

    if (stream) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Response body is not readable');
        
        let result = '';
        const decoder = new TextDecoder();
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += decoder.decode(value, { stream: true });
        }
        return result;
    } else {
        return await response.json();
    }
};

const runVisionAnalysis = async (imageFile: File, prompt?: string, retryOptions?: RetryOptions) => {
    const headers: HeadersInit = {};
    const userId = getUserId();
    const apiKey = getReplicateApiKey();
    if (userId) headers['x-user-id'] = userId;
    if (apiKey) headers['x-replicate-token'] = apiKey;

    const fullUrl = API_BASE_URL.startsWith('http')
        ? `${API_BASE_URL}/analyze-image`
        : `${window.location.origin}${API_BASE_URL}/analyze-image`;

    const response = await requestWithRetry(
        async () => {
            const formData = new FormData();
            formData.append('image', imageFile);
            if (prompt) formData.append('prompt', prompt);

            return await fetchWithTimeout(
                fullUrl,
                {
                    method: 'POST',
                    headers,
                    body: formData
                },
                retryOptions?.timeoutMs ?? 180000
            );
        },
        retryOptions
    );

    const data = await response.json().catch(() => ({} as any));
    const analysis = data?.analysis;
    if (typeof analysis !== 'string') {
        throw new Error(data?.error || '无法获取解析结果');
    }
    return analysis;
};

export const analyzeImages = async (
    files: File[],
    options?: {
        onProgress?: (progress: { completed: number; total: number; currentFileName?: string }) => void;
        retry?: RetryOptions;
    }
): Promise<AnalysisResult[]> => {
    const results: AnalysisResult[] = [];
    const total = files.length;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        options?.onProgress?.({ completed: i, total, currentFileName: file.name });
        try {
            const analysisText = await runVisionAnalysis(file, undefined, options?.retry);

            // 3. 格式化结果
            results.push({
                fileName: file.name,
                analysis: analysisText || '无法获取解析结果',
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error(`Error analyzing ${file.name}:`, error);
            results.push({
                fileName: file.name,
                analysis: `分析失败: ${error instanceof Error ? error.message : '未知错误'}`,
                timestamp: new Date().toISOString(),
                error: true
            });
            
            // 记录到错误本
            addToErrorNotebook({
                type: 'analysis_error',
                details: `File: ${file.name}, Error: ${error instanceof Error ? error.message : 'Unknown'}`
            });
        }
    }

    options?.onProgress?.({ completed: total, total });
    return results;
};

export const analyzeAndMergeReferenceImagesForGeneration = async (files: File[]): Promise<string> => {
    if (!Array.isArray(files) || files.length === 0) return '';

    const perImageRaw = await Promise.all(
        files.map(file => runVisionAnalysis(file, GENERATION_REFERENCE_IMAGE_SINGLE_JSON_PROMPT))
    );

    const analyses = perImageRaw.map((text, idx) => {
        const parsed = tryParseJsonObject(text);
        if (parsed) return parsed;
        return { image_index: idx + 1, raw: (text || '').trim() };
    });

    const mergePrompt = GENERATION_REFERENCE_IMAGE_MERGE_PROMPT.replace(
        '{{ANALYSES_JSON}}',
        JSON.stringify(analyses, null, 2)
    );

    const result = await callApi('/merge-generation-understanding', { prompt: mergePrompt });
    const merged = (result?.analysis || result?.prompt || result?.text || '').toString();
    if (!merged.trim()) {
        return perImageRaw.map((t, i) => `[Image ${i + 1}]\n${t}`).join('\n\n');
    }
    return merged.trim();
};

export const analyzeAndCategorizeImageForKB = async (imageFile: File): Promise<KnowledgeBaseAnalysis> => {
    try {
        const resultText = await runVisionAnalysis(imageFile, IMAGE_UNDERSTANDING_PROMPT);
        const parsed = parseImageUnderstandingPrompt(resultText);
        return parsed;
    } catch (error) {
        console.error("KB Analysis failed:", error);
        throw new Error("知识库图像解析失败。");
    }
};

const parseImageUnderstandingPrompt = (analysis: string): KnowledgeBaseAnalysis => {
    const text = (analysis || '').trim();
    const lines = text.split(/\r?\n/);
    const sections: Array<{ title: string; contentLines: string[] }> = [];
    let current: { title: string; contentLines: string[] } | null = null;

    const commit = () => {
        if (!current) return;
        const content = current.contentLines.join('\n').trim();
        if (current.title.trim() && content) {
            sections.push({ title: current.title.trim(), contentLines: content.split('\n') });
        }
        current = null;
    };

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const bracketMatch = line.trim().match(/^(?:\d+\.\s*)?[【\[]\s*(.+?)\s*[】\]]\s*$/);
        const headerText = bracketMatch?.[1];

        if (headerText) {
            commit();
            current = { title: headerText.trim(), contentLines: [] };
            continue;
        }

        if (!current) continue;
        current.contentLines.push(rawLine);
    }

    commit();

    const fragments: Partial<Record<KnowledgeBaseCategory, string>> = {};
    const setIf = (cat: KnowledgeBaseCategory, content: string) => {
        const value = content.trim();
        if (!value) return;
        fragments[cat] = value;
    };

    for (const section of sections.map(s => ({ title: s.title, content: s.contentLines.join('\n').trim() }))) {
        const t = section.title;
        if (/(姿势|动作|Pose)/i.test(t)) setIf(KnowledgeBaseCategory.POSE, section.content);
        else if (/(场景|环境|Scene|Environment)/i.test(t)) setIf(KnowledgeBaseCategory.SCENE, section.content);
        else if (/(构图|镜头|Composition|Camera)/i.test(t)) setIf(KnowledgeBaseCategory.COMPOSITION, section.content);
        else if (/(光照|氛围|Lighting|Atmosphere)/i.test(t)) setIf(KnowledgeBaseCategory.LIGHTING, section.content);
        else if (/(服装|造型|Clothing|Apparel|Styling)/i.test(t)) setIf(KnowledgeBaseCategory.CLOTHING, section.content);
        else if (/(风格|后期|Style|Post)/i.test(t)) setIf(KnowledgeBaseCategory.STYLE, section.content);
    }

    return {
        holistic_description: text,
        fragments
    } as KnowledgeBaseAnalysis;
};

const createBaseDirectives = () => `
# CORE DIRECTIVES (NON-NEGOTIABLE):

## 1. STRICT OUTPUT FORMAT:
- **Aspect Ratio:** The output image MUST BE a **3:4 vertical portrait**. DO NOT generate landscape or square images. This is a mandatory instruction.
`;

const GENERATION_REFERENCE_IMAGE_SINGLE_JSON_PROMPT = `
你是一位拥有 20 年经验的「商业摄影修图师」兼「视觉分析专家」。你的任务是极其精准地解析输入图片，提取用于高保真图像重建的 JSON 数据。

【输入】
- 你将收到一张图片。

【核心任务】
1) **显微镜级观察：** 不要只看大概。对于服装和产品，必须分析其**材质纹理（Texture）、光泽感（Sheen）、厚度（Weight）和工艺细节（Craftsmanship）**。
2) **专业摄影分析：** 使用专业术语描述光线（如：伦勃朗光、蝴蝶光、漫反射、硬光）和构图。
3) **严格的事实提取：** 严禁虚构。对于看不清的细节填 null，但在 notes 中说明。
4) **人物与风格：** 默认亚洲女性、高质感小红书/商业摄影风格。

【输出要求（必须严格遵守）】
- 只输出一个 JSON 对象，不要 markdown，不要代码块。
- 重点在于 **materials（材质）** 和 **details（细节）** 字段的丰富度。

JSON 结构：
{
  "image_type": "person" | "product" | "scene" | "mixed",
  "subject_priority": "person" | "product" | "scene" | null,
  "person": {
    "present": boolean,
    "gender": string | null,
    "age_range": string | null,
    "ethnicity": string | null,
    "vibe": string | null,
    "body": {
      "height_cm": number | null,
      "weight_kg": number | null,
      "bust_cm": number | null,
      "waist_cm": number | null,
      "hip_cm": number | null,
      "notes": string
    },
    "face": {
      "visible": boolean,
      "details": string | null, // 描述五官特征、皮肤质感（如：清透、哑光、奶油肌）
      "makeup": string | null,
      "notes": string
    },
    "hair": string | null, // 描述发色、发质（如：柔顺、毛躁）、卷度
    "clothing": string | null, // 【重点】必须包含：面料名称（如针织、丹宁、丝绸）、表面纹理（如螺纹、磨毛、光面）、版型、褶皱感
    "accessories": string | null, // 描述材质（金属、塑料、皮革）
    "pose": string | null,
    "framing": string | null,
    "notes": string
  },
  "product": {
    "present": boolean,
    "category": string | null,
    "overall": string | null,
    "structure": string | null,
    "colors": string | null, // 精准色值描述（如：复古棕、象牙白）
    "materials": string | null, // 【重点】描述材质组合（如：翻毛皮拼接网布）、反光特性、表面触感
    "details": string | null, // 【重点】描述Logo工艺、缝线颜色、鞋底纹路、五金件细节
    "notes": string
  },
  "scene": {
    "present": boolean,
    "location_type": string | null,
    "elements": string | null,
    "materials": string | null, // 描述地面/墙面材质（如：粗糙混凝土、湿润草地）
    "cleanliness": string | null,
    "notes": string
  },
  "lighting": {
    "source": string | null, // 自然光/人造光
    "direction": string | null, // 侧光/逆光/顶光
    "quality": string | null, // 【重点】软光(Soft)/硬光(Hard)/漫反射(Diffused)
    "shadows": string | null, // 阴影深浅、边缘锐度
    "color_temperature": string | null, // 暖调/冷调/中性
    "notes": string
  },
  "style": {
    "overall_style": string | null, // 如：High-end Streetwear, Minimalist
    "image_quality": string | null, // 【重点】描述画质特征：8k, sharp focus, film grain, noise level
    "post_processing": string | null, // 滤镜感、对比度、饱和度
    "notes": string
  },
  "negative_constraints": string // 画面中存在的瑕疵，如：blur, distortion, low resolution, bad anatomy
}
`.trim();

const GENERATION_REFERENCE_IMAGE_MERGE_PROMPT = `
你是一位「高级视觉提示词工程师」兼「多源图像融合专家」。你将收到多个 JSON（由图片解析器产出），这些 JSON 包含可见事实与约束。

【核心目标】
将多张参考图的信息融合成一段**“商业摄影级”**的图像生成提示词。你需要不仅仅是“描述”，而是要进行“视觉增强”，确保生成的画面具备极高的材质真实感和细节精度。

【融合与增强规则（最高优先级）】

1. **产品独裁原则（解决特征冲突）：**
   - **绝对替换：** 如果存在 \`product.present=true\` 的产品图（如鞋子），该产品的特征（颜色、材质、结构、Logo）必须**100%**取自产品图。
   - **屏蔽干扰：** 严禁描述人物图（\`person.present=true\`）中原本穿着的同类产品。例如：若人物图穿红鞋，产品图是棕鞋，输出必须明确描述“棕色鞋”，并**完全忽略**红鞋的任何特征。

2. **材质与细节的“合理推断”（解决细节缺失）：**
   - **拒绝平庸：** 不要只输出“粉色背心”或“牛仔裤”。必须基于商业摄影标准，推断并补充材质细节。
   - **增强示例：**
     - “背心” -> “高品质针织螺纹面料，表面有细腻棉质纹理”
     - “牛仔裤” -> “重磅水洗丹宁布，具有粗糙的织物纹理和清晰的缝线细节”
     - “皮鞋” -> “细腻的翻毛皮与光面皮拼接，具有真实的皮革毛孔与光泽”

3. **主体融合逻辑：**
   - 主体以人物图的姿态、身材、脸部为骨架。
   - 将产品图的物品“穿戴”或“放置”在主体上，替换原有物品。
   - 场景以场景图为准；若无场景图，则保留人物图的背景，但需进行“干净化”处理（去除杂乱路人）。

4. **画质与光影注入：**
   - 必须在描述中自然融入提升画质的关键词，如：\`8k resolution\`, \`photorealistic\`, \`highly detailed texture\`, \`cinematic lighting\`, \`depth of field\`。

【输出格式规范】
不要输出 JSON，不要编号。请输出以下 5 段内容，语言需精准、优美、具有画面诱导性：

【主体（人物/产品/人物+产品）】
（描述主体的身份、姿态、核心动作，强调高分辨率和真实感）

【服装&造型】
（**重点区域**：详细描述衣物和配饰。在此处执行“产品替换”和“材质增强”。必须使用丰富的形容词描述布料、剪裁和质感。）

【场景&环境】
（描述环境元素、地面材质、背景景深。强调环境与主体的融合。）

【光照&氛围】
（描述光源方向、光质-软/硬、色温、阴影细节，营造的高级感。）

【风格&后期】
（定义摄影风格，如：商业广告大片、小红书生活感、胶片感。包含画质关键词。）

其他描述：人物默认全身照、三视图（左视/正视/右视）、平视视角；产品默认三视图、三维视角。若与输入 JSON 冲突（例如裁切到无脸），必须以 JSON 为准并明确说明。

【输入 JSON 列表】
{{ANALYSES_JSON}}
`.trim();

const tryParseJsonObject = (text: string): any | null => {
    const raw = (text || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

export const generateMasterImage = async (
    referenceImages: string[],
    consistentPrompt: string,
    firstVariablePrompt: string
): Promise<string> => {
    // const directives = createBaseDirectives(); // Merged into the main prompt for better flow
    const fullPrompt = `
# ROLE: High-Fidelity Image Synthesis Specialist 
(角色设定：高保真图像合成专家) 

# TASK: 
Generate a "Master Image" that strictly adheres to the visual information provided in the Reference Images and the textual descriptions in the Prompts. 
(任务目标：生成一张严格遵循参考图视觉信息和提示词文本描述的“主图”。) 

# CORE DIRECTIVES (THE "CLOSED WORLD" RULE): 
## 1. STRICT OUTPUT FORMAT (NON-NEGOTIABLE):
- **Aspect Ratio:** The output image MUST BE a **3:4 vertical portrait**. DO NOT generate landscape or square images.

## 2. STRICT ELEMENT BOUNDARY (CRITICAL): 
- **Source of Truth:** The output image must ONLY contain elements derived from: 
  1. **The Reference Images:** (e.g., if the reference is a shoe, render ONLY the shoe. If the reference is a person, render the person.) 
  2. **The Text Prompts:** (e.g., specific lighting, background texture, or additional objects explicitly mentioned). 
- **PROHIBITION:** Do **NOT** hallucinate or auto-complete subjects that are not present in the sources. 
  - **Example A:** If reference is a product and prompt is silent on humans -> **DO NOT generate a model, hands, or face.** 
  - **Example B:** If reference is a person -> **Maintain the person** as shown. 
  - **Example C:** If prompt does not describe a scene -> **Use a neutral/studio background.** Do not invent a street, gym, or room. 

## 3. VISUAL CONSISTENCY: 
- Preserve the structure, material, and identity of the main subject from the Reference Images. 
- Apply the style/atmosphere described in the "Consistent Elements" prompt ONLY to the valid subjects. 

# CREATIVE BRIEF: 
## Input Analysis: 
1. **Analyze Reference Images:** Identify the subject (Product? Person? Animal?). -> **Lock this Subject.** 
2. **Analyze Prompts:** Identify the environment/modifiers. -> **Apply these Modifiers.** 

## Execution: 
- **Consistent Content:** 
${consistentPrompt}
- **Variable Content:** 
${firstVariablePrompt}

# FINAL SAFETY CHECK: 
- Did I add a face/body that wasn't in the reference or prompt? -> **DELETE IT.** 
- Did I add a background scene not requested? -> **REMOVE IT.**
`;

    // Convert reference image URLs to Base64 before sending
    const base64Images = await Promise.all(referenceImages.map(url => urlToBase64(url)));

    try {
        const result = await callApi('/generate-image', {
            prompt: fullPrompt,
            image_input: base64Images, // Pass reference images if available for style/character consistency
            aspect_ratio: "3:4"
        });

        return result.imageUrl;
    } catch (error) {
        console.error("Master Image Generation failed:", error);
        await addToErrorNotebook(
            "Master Image Generation Failed",
            `Error generating master image: ${error.message}`,
            ["generation", "master", "error"]
        );
        throw error;
    }
};

export const modifyMasterImage = async (
    referenceImages: string[],
    masterImageSrc: string,
    consistentPrompt: string,
    firstVariablePrompt: string,
    modificationRequest: string
): Promise<string> => {
    const directives = createBaseDirectives();
    const prompt = `
# ROLE: AI Photo Editor & Retoucher

# TASK: 
Modify the provided image based on a specific user request. The goal is to refine the image while maintaining perfect consistency.

# MODIFICATION REQUEST:
"${modificationRequest}"

${directives}

# ORIGINAL CREATIVE BRIEF (For Context):
## Consistent Elements:
${consistentPrompt}

## Variable Elements:
${firstVariablePrompt}
`;

    const base64Master = await urlToBase64(masterImageSrc);

    const result = await callApi('/retouch-image', {
        image: base64Master,
        prompt: prompt,
        strength: 0.75 
    });

    return result.imageUrl;
};

export const generateSingleFromMaster = async (
    referenceImages: string[],
    masterImageSrc: string,
    consistentPrompt: string,
    variablePrompt: string,
    isRegeneration: boolean,
    fusionImage?: File | string // New parameter for fusion
): Promise<string> => {
    // Logic: Use Master Image as base + Full Prompt (Consistent + Variable)
    // This ensures unmentioned details default to the Master Image's visual information.
    const fullPrompt = `
# ROLE: AI Scene Director & Consistency Enforcer 
(角色设定：AI场景导演与一致性执行官。核心职能是基于“资产库”执行特定的“拍摄指令”。) 

# TASK: 
Generate a specific shot based on the [Variable Content] instruction, while strictly inheriting visual assets from [Consistent Content]. 

# THE "INHERITANCE & OVERWRITE" PROTOCOL (CRITICAL): 

## RULE 1: ASSET INHERITANCE (The "WHO & WHERE" - Hard Lock) 
**Source:** [Consistent Content] 
**Directive:** You MUST use the exact subjects and environment defined here. 
- **Identity:** The model's face, body type, hair, and the product's design/material are IMMUTABLE. 
- **Environment:** The location (e.g., "Ocean rocks") remains constant unless explicitly changed. 
- *Constraint:* Do NOT invent new clothes or change the model's ethnicity/features. 

## RULE 2: STATE OVERWRITE (The "HOW" - High Priority) 
**Source:** [Variable Content] 
**Directive:** This defines the Camera Angle, Framing, Pose, and Focus. 
- **Override Authority:** If [Variable Content] specifies a composition (e.g., "Close-up of shoes") that conflicts with the general description in [Consistent Content] (e.g., "Full body shot"), **THE VARIABLE CONTENT WINS.** 
- **Focus Shift:** You are allowed to crop out the head/body if the Variable Content asks for a "Shoe Detail Shot". 

# LOGIC EXECUTION PATH: 
1.  **Load Assets:** Get the Model + Shoes + Background from [Consistent Content]. 
2.  **Apply Camera:** Position the camera according to [Variable Content]. 
3.  **Render:** Generate the image. 

# INPUT DATA: 

## Consistent Content (The Assets): 
${consistentPrompt} 
*(Instruction: Treat this as the "Actor and Set Design". Use these visual elements.)* 

## Variable Content (The Director's Shot): 
${variablePrompt} 
*(Instruction: Treat this as the "Camera Command". This determines the angle, framing, and action. If this asks for a specific detail, IGNORE the full-body context of the Consistent Content.)* 

${isRegeneration ? `\n- **Random Seed:** ${Math.random()}` : ''}
`;

    const base64Master = await urlToBase64(masterImageSrc);
    
    let fusionImageBase64: string | undefined;
    if (fusionImage) {
        if (typeof fusionImage === 'string') {
             fusionImageBase64 = await urlToBase64(fusionImage);
        } else {
             fusionImageBase64 = await fileToBase64(fusionImage);
        }
    }

    // Using /retouch-image for Img2Img generation to maintain consistency with Master Image
    try {
        const result = await callApi('/retouch-image', {
            image: base64Master,
            prompt: fullPrompt,
            strength: 0.65, // Reduced from 0.85 to improve consistency with Master Image
            image_input: fusionImageBase64 ? [fusionImageBase64] : undefined
        });

        return result.imageUrl;
    } catch (error) {
        console.error("Generation failed:", error);
        await addToErrorNotebook(
            "Series Generation Failed",
            `Error generating single image from master: ${error.message}. Prompt: ${variablePrompt}`,
            ["generation", "series", "error"]
        );
        throw error;
    }
};

export interface SmartRetouchAnalysisResult {
    understanding: string;
    suggestions: string;
}

export const analyzeImageSmartRetouch = async (imageFile: File): Promise<SmartRetouchAnalysisResult> => {
    // Fetch previous successful retouch examples from Knowledge Base
    let learnedContext = "";
    try {
        const kbEntries = await getKnowledgeBase();
        const learnedExamples = kbEntries
            .filter(e => e.category === KnowledgeBaseCategory.RETOUCH_LEARNING)
            .slice(0, 3);

        if (learnedExamples.length > 0) {
            learnedContext = `
# LEARNED SUCCESSFUL DIRECTIVES:
(Based on previous user feedback, use these as examples of the desired output style for suggestions):
${learnedExamples.map((e, i) => `
--- STYLE REFERENCE ${i + 1} ---
${e.promptFragment}
`).join('\n')}
`;
        }
    } catch (e) {
        console.warn("Could not load knowledge base for context", e);
    }

    try {
        const understanding = await runVisionAnalysis(imageFile, IMAGE_UNDERSTANDING_PROMPT);

        const suggestionsPrompt = `
你是一个专业的商业摄影修图与重绘创意总监。你会基于输入图片与“图像理解 Prompt”，产出一份可执行的修图方案，并把“给用户看的解释”与“给图生图模型的英文提示词”严格分开输出。你的输出将被直接粘贴到工具里使用，因此格式必须稳定。

【输入】
图像理解 Prompt：
${understanding}

【重绘幅度（0-1）规则】
- 0.10–0.30：只做微调，尽量保持原图细节，背景与光影很难大改。
- 0.50–0.70：可以明显调整光影与背景，但保持主体轮廓与身份。
- 0.80+：大幅重绘，有较高风险改动物品外观（例如鞋子变样）。

【任务】
- 给出 1 个“重绘幅度”建议值（0-1 小数，保留两位）。
- 提出 3–5 条具体、可执行、可验证的优化点，聚焦：构图、光影、色调、质感、背景控制、人物状态与穿搭展示（偏商业摄影表达）。
- 把这些优化点转写成适合图生图模型的英文提示词：偏“摄影语言 + 可执行的细节”，不要把“调整色调/更高级/更有氛围”这类中文口号直接翻译成空话。
- 英文提示词必须包含权重语法，例如：(warm lighting:1.3)，并且至少出现 5 处带权重的短语；权重建议范围 1.1–1.6。

${learnedContext}

【输出格式（必须严格遵守，除标题外不要出现任何编号：不要 1) 2) 3)；不要 1. 2. 3.；不要 ①②③）】
【参数】
重绘幅度：<0-1 小数>

【给用户看的】
用中文解释“要改什么 + 为什么 + 预期效果”。可分多行，允许以“- ”开头，但不要出现任何编号。

【给AI看的】
只输出英文提示词（可多行），不要中文解释，不要 JSON，不要编号。
至少包含这些信息：
- Lighting：光源方向/光质/色温，并使用权重
- Color grading：具体色调与对比曲线倾向，并使用权重
- Texture/detail：皮肤/织物/材质细节，并使用权重
- Composition/camera：镜头焦段/景深/机位或构图策略
- Quality：photorealistic, commercial photography, high detail, clean background（不要水印/文字）
`.trim();

        const suggestions = await runVisionAnalysis(imageFile, suggestionsPrompt);
        return { understanding: (understanding || '').trim(), suggestions: (suggestions || '').trim() };
    } catch (error) {
        console.error("Smart Retouch Analysis failed:", error);
        throw new Error("智能修图分析失败。");
    }
};

export const mergeRetouchPromptsWithImage = async (
    imageFile: File,
    originalDescription: string,
    userInstructions: string
): Promise<string> => {
    const prompt = `
# ROLE: Advanced Prompt Engineer & Logic Merger

# TASK:
You are provided with an **Original Image Description** (which describes the attached image) and a set of **User Modification Instructions**.
Your goal is to generate a **New, Merged Description** that will be used to generate a modified version of the image.

# LOGIC:
New Description = (Original Description - Elements changed by Instructions) + Instructions.

# REQUIREMENTS:
1.  **Incorporate** all valid changes requested in the User Instructions.
2.  **Replace** any conflicting details in the Original Description with the new instructions.
3.  **Preserves** all other details from the Original Description that are NOT mentioned in the instructions.
4.  **Clean:** Ensure the new description describes a high-quality, clean image (no watermarks).

# INPUTS:
## Original Description:
"${originalDescription}"

## User Instructions:
"${userInstructions}"

# OUTPUT:
Return ONLY the final Merged Description text. Do not add explanations.
`;

    try {
        return await runVisionAnalysis(imageFile, prompt);
    } catch (error) {
        console.error("Prompt Merge failed:", error);
        return originalDescription + " " + userInstructions; 
    }
};

export const generateSmartRetouchImage = async (
    originalImageFile: File,
    fullDescription: string,
    strength: number = 0.65
): Promise<string> => {
    const base64Image = await fileToBase64(originalImageFile);
    const directives = createBaseDirectives();
    
    const prompt = `
# ROLE: Visionary AI Artist & Image Reconstruction Expert

# TASK:
Re-generate the input image to MATCH the provided **TARGET DESCRIPTION** exactly.
You must preserve the original composition and identity unless the description explicitly describes a change.

# TARGET DESCRIPTION:
${fullDescription}

# OPERATIONAL RULES:
1.  **Fidelity:** The output must match the description.
2.  **Identity:** Preserve the character's identity from the original image.
3.  **Quality:** 8K resolution, commercial photography quality.
4.  **Clean:** No watermarks, text, or glitches.

${directives}
`;

    const result = await callApi('/retouch-image', {
        image: base64Image,
        prompt: prompt,
        strength: Math.min(1, Math.max(0, strength))
    });

    return result.imageUrl;
};

// ============================================
// 图片放大模型支持
// ============================================

export type UpscaleModel = 'real-esrgan' | 'clarity-upscaler';

// Real-ESRGAN 参数 (快速放大)
export interface RealEsrganParams {
    scale: number; // 2 or 4, 放大倍数
    face_enhance: boolean; // 是否增强人脸
}

// Clarity Upscaler 参数 (高质量放大)
export interface ClarityUpscalerParams {
    prompt: string; // 正向提示词
    dynamic: number; // 1-50, HDR强度
    scheduler: string; // 调度器类型
    creativity: number; // 0-1, 创意度
    resemblance: number; // 0-1, 与原图相似度
    scale_factor: number; // 1-4, 放大倍数
    negative_prompt: string; // 负向提示词
    num_inference_steps: number; // 1-100, 推理步数
}

// 默认配置
export const DEFAULT_REAL_ESRGAN_PARAMS: RealEsrganParams = {
    scale: 2,
    face_enhance: false
};

export const DEFAULT_CLARITY_PARAMS: ClarityUpscalerParams = {
    prompt: 'masterpiece, best quality, highres, <lora:more_details:0.5> <lora:SDXLrender_v2.0:1>',
    dynamic: 6,
    scheduler: 'DPM++ 3M SDE Karras',
    creativity: 0.35,
    resemblance: 0.6,
    scale_factor: 2,
    negative_prompt: '(worst quality, low quality, normal quality:2) JuggernautNegative-neg',
    num_inference_steps: 18
};

/**
 * 放大图片 - 支持两种模型
 * @param imageFile 要放大的图片文件
 * @param model 使用的模型: 'real-esrgan' (快速) 或 'clarity-upscaler' (高质量)
 * @param params 模型参数
 * @returns 放大后的图片 URL
 */
export const upscaleImage = async (
    imageFile: File,
    model: UpscaleModel,
    params: RealEsrganParams | ClarityUpscalerParams
): Promise<string> => {
    const base64Image = await fileToBase64(imageFile);

    try {
        const result = await callApi(
            '/upscale-image',
            {
                model,
                image: base64Image,
                params
            },
            false,
            {
                retries: 2,
                minDelayMs: 1000,
                maxDelayMs: 5000,
                timeoutMs: 180000
            }
        );

        return result.imageUrl;
    } catch (error) {
        console.error(`${model} upscale failed:`, error);
        await addToErrorNotebook({
            type: 'upscale_error',
            details: `Model: ${model}, Error: ${error instanceof Error ? error.message : 'Unknown'}`
        });
        throw error;
    }
};

const createCornerMask = async (imageFile: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error('Failed to get canvas context'));
                return;
            }

            // Fill with black (preserve area)
            ctx.fillStyle = 'black';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Calculate 20% dimensions
            const w20 = canvas.width * 0.2;
            const h20 = canvas.height * 0.2;

            // Fill corners with white (inpainting area)
            ctx.fillStyle = 'white';
            // Top-Left
            ctx.fillRect(0, 0, w20, h20);
            // Top-Right
            ctx.fillRect(canvas.width - w20, 0, w20, h20);
            // Bottom-Left
            ctx.fillRect(0, canvas.height - h20, w20, h20);
            // Bottom-Right
            ctx.fillRect(canvas.width - w20, canvas.height - h20, w20, h20);

            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(imageFile);
    });
};

export const removeWatermark = async (imageFile: File): Promise<string> => {
    const base64Image = await fileToBase64(imageFile);
    const maskImage = await createCornerMask(imageFile);

    const prompt = `
# ROLE: Blind Inpainting & Artifact Removal Specialist 
(角色设定：盲区重绘与伪影去除专家。核心能力是在不预设背景内容的情况下，基于周边像素智能填充指定区域。) 

# TASK: 
Analyze the 4 corner regions of the image (approx. 20% margin). Detect and remove ANY artificial overlays (text, watermarks, logos, UI frames) regardless of their content. Reconstruct the background using "Contextual Pixel Extension". 
(任务目标：分析图像四个角落区域。检测并移除任何任何人造覆盖物（文字、水印、Logo、UI框），无论其内容为何。使用“上下文像素延伸”重构背景。) 

# DETECTION ZONES (SPATIAL LOCK): 
Focus STRICTLY on these coordinates: 
1.  **Top-Left (0-20% W, 0-20% H)** 
2.  **Top-Right (80-100% W, 0-20% H)** 
3.  **Bottom-Left (0-20% W, 80-100% H)** 
4.  **Bottom-Right (80-100% W, 80-100% H)** 

# REMOVAL TARGETS (GENERIC): 
Look for and erase: 
- **Alphanumeric Characters:** Any text script (Chinese, English, Numbers). 
- **Geometric Overlays:** Rectangular borders, lines, or semi-transparent boxes. 
- **Logos/Icons:** Any vector-like graphics that do not match the photo-realistic noise of the scene. 

# RESTORATION LOGIC (CONTEXT AWARE): 
- **Do NOT invent new objects.** 
- **Algorithm:** 
  - Analyze the pixels immediately *adjacent* to the watermark. 
  - **If Gradient:** Continue the color transition smoothly (e.g., if sky, extend the blue fade). 
  - **If Pattern/Texture:** Clone and tile the pattern seamlessly (e.g., if floor/fabric, match the grain direction). 
  - **If Complex Detail:** Synthesize noise to match the camera ISO grain. 

# OUTPUT GOAL: 
A restored image where the corners blend invisibly with the rest of the scene. The viewer should not be able to tell where the watermark used to be.
`;
    
    // Using Flux Fill (inpainting) via backend
    const result = await callApi('/retouch-image', {
        image: base64Image,
        mask: maskImage, // Pass the generated mask
        prompt: prompt
        // Strength is not needed for Flux Fill in this context, or handled differently
    });

    return result.imageUrl;
};

export interface PreprocessResult {
    hasWatermark: boolean;
    subjectDescription: string;
}

export const preprocessImageForGeneration = async (imageFile: File): Promise<PreprocessResult> => {
    const prompt = `
# ROLE: Image Quality & Content Analyzer
# TASK: Analyze the image for two specific criteria:
1. **Watermarks:** Check the four corners (top-left, top-right, bottom-left, bottom-right) for any visible watermarks, logos, text overlays, or platform stamps.
2. **Main Subject:** Identify the main subject.
   - Criteria: Must occupy >45% of the image area and be positioned centrally.
   - Types: Product (Shoes, Clothes, Pants, Watch, etc.) OR Combination (Person + Clothes + Shoes).
   - Description: Provide a concise but descriptive prompt for the subject.

# OUTPUT FORMAT:
Return ONLY a JSON object.
{
  "hasWatermark": true/false,
  "subjectDescription": "Description of the main subject if identified, otherwise empty string."
}
`;

    try {
        const resultText = await runVisionAnalysis(imageFile, prompt);
        const jsonString = resultText.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(jsonString) as PreprocessResult;
    } catch (error) {
        console.error("Preprocessing analysis failed:", error);
        return { hasWatermark: false, subjectDescription: "" };
    }
};
