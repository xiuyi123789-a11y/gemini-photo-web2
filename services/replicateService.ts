import { AnalysisResult, KnowledgeBaseAnalysis, KnowledgeBaseCategory } from '../types';
import { getKnowledgeBase } from './knowledgeBaseService';
import { addToErrorNotebook } from './errorNotebookService';

const API_BASE_URL = '/api';

const getUserId = () => {
    return localStorage.getItem('userId') || 'default-user';
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

const callApi = async (endpoint: string, body: any, apiKey?: string, stream: boolean = false) => {
    const userId = getUserId();
    const headers: any = {
        'Content-Type': 'application/json',
        'x-user-id': userId
    };

    if (apiKey) {
        headers['x-replicate-token'] = apiKey;
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `API call failed: ${response.statusText}`);
    }

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

export const analyzeImages = async (images: File[], apiKey: string): Promise<AnalysisResult> => {
    const base64Images = await Promise.all(images.map(fileToBase64));

    const prompt = `
# ROLE: Visual Asset Librarian & Scene Director 
(角色设定：视觉资产管理员与场景导演。你的工作是将“物体本身”与“拍摄方式”彻底分离。) 

# TASK: 
Analyze ALL ${images.length} images to separate "WHAT is in the image" (Consistent) from "HOW it is shot" (Inconsistent). 

# CRITICAL LOGIC (THE "INVENTORY" RULE): 
**Rule 1: The "Consistent Elements" is a Global Asset Library.** 
- If Image 1 shows a [Woman] and Image 2 shows a [Shoe], the Consistent Content MUST contain **BOTH** the [Woman] AND the [Shoe]. 
- **NEVER** put the physical description of a main subject (color, material, face) into "Inconsistent Elements". 
- Even if an object appears in only ONE image, it is still a "Core Asset" and belongs in "Consistent Elements". 

**Rule 2: The "Inconsistent Elements" is for Camera & Action ONLY.** 
- This section describes the *momentary state*: Angle, Pose, Lighting Direction, Zoom Level. 
- **Bad Example:** "Unique Features: A white sneaker." (WRONG - The sneaker is an asset). 
- **Good Example:** "Unique Features: Side profile view, floating composition." (CORRECT). 

# STEP-BY-STEP EXECUTION: 

1.  **Build the Asset List (Consistent Content):** 
    - Scan Image 1: Extract the Subject (e.g., Model). Add detailed physical description to \`core_subject_details\`. 
    - Scan Image 2: Extract the Subject (e.g., Shoe). Does it conflict with the Model? No, it's a new asset. **APPEND** the Shoe's detailed description to \`core_subject_details\`. 
    - *Result:* The \`core_subject_details\` should read like: "A female model with [details]... AND A white sneaker with [details]..." 

2.  **Define the Shot (Inconsistent Content):** 
    - For Image 1: Describe ONLY the Model's pose and the camera angle. 
    - For Image 2: Describe ONLY the Shoe's rotation and the background style. 

# LANGUAGE INSTRUCTION:
**CRITICAL:** All content values in the JSON output MUST be in **Simplified Chinese (简体中文)**.
- The JSON keys (e.g., "consistent_elements", "core_subject_details") must remain in **English**.
- The values (descriptions) must be fully translated to Simplified Chinese.

# OUTPUT_FORMAT: 
Return strictly in JSON format. 

{ 
  "consistent_elements": { 
    "synthesized_definition": { 
      "subject_summary": "e.g., 'Fashion Model & Vintage Sneaker Collection'", 
      "core_subject_details": "【关键指令】在此处合并所有图片中的物体描述。例如：'1. 模特：长发，白色羽毛裙... 2. 鞋品：灰白色复古运动鞋，麂皮材质...' (必须包含所有出现的主体)", 
      "scene_atmosphere": "【环境库】提取所有出现的背景元素（如：海洋、岩石、纯白摄影棚背景）", 
      "visual_quality": "统一的画质描述 (e.g., High fidelity, Studio lighting)" 
    } 
  }, 
  "inconsistent_elements": [ 
    { 
      "image_index": 0, 
      "subject_ref": "e.g., 'The Model'", 
      "action_and_pose": "e.g., 'Touching collarbone, looking left'", 
      "camera_angle": "e.g., 'Close-up, Side Profile'" 
    }, 
    { 
      "image_index": 1, 
      "subject_ref": "e.g., 'The Sneaker'", 
      "action_and_pose": "e.g., 'Static product display, no movement'", 
      "camera_angle": "e.g., 'Side view, slightly elevated'" 
    } 
  ] 
}
`;

    try {
        const resultText = await callApi('/analyze-image', {
            images: base64Images,
            prompt: prompt
        }, apiKey, true);

        const jsonString = resultText.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(jsonString) as AnalysisResult;
    } catch (error) {
        console.error("Analysis failed:", error);
        throw new Error("图片分析失败，请重试。");
    }
};

export const analyzeAndCategorizeImageForKB = async (imageFile: File, apiKey: string): Promise<KnowledgeBaseAnalysis> => {
    const base64Image = await fileToBase64(imageFile);

    const prompt = `
# ROLE: 资深提示词工程师与图像解构专家 (v3.0)

# TASK:
对提供的图片进行两次分析。首先，生成一段完整的、连贯的、极度详细的“母版”描述。然后，从该描述中提炼并拆解出独立的、可复用的高质量提示词片段，并为每个片段分配最合适的类别。
你需要捕捉图像中的每一个**超细节 (Ultra-Detailed)** 元素，包括微小的纹理、光影的微妙变化、材质的触感以及整体的空气感。

# STEP 1: HOLISTIC DESCRIPTION (母版描述 - ULTRA-DETAILED)
创作一段单一的、综合性的文字，捕捉图像的全部精髓。这段描述应该足够详细，包含人物特征、服装细节、环境氛围、光影质感等所有方面，以便AI可以仅凭此文字就高度复刻出原图。

# STEP 2: FRAGMENT EXTRACTION (片段拆解 - ULTRA-DETAILED)
基于你上面写的“母版描述”，将其拆解为以下类别的独立提示词片段。
【重要】：每个类别只生成**一条**完整的、包含所有细节的描述段落。不要使用列表或多个短句。

- **${KnowledgeBaseCategory.POSE}**: (一条描述) 极详细地描述人物的姿势、身体朝向、动作张力、手势细节、视线方向和微表情。
- **${KnowledgeBaseCategory.SCENE}**: (一条描述) 极详细地描述具体环境、空间结构、背景材质、关键道具、天气和整体氛围。
- **${KnowledgeBaseCategory.COMPOSITION}**: (一条描述) 极详细地描述构图方式（如对称、引导线）、景别、相机高度、拍摄角度、镜头焦段和透视关系。
- **${KnowledgeBaseCategory.LIGHTING}**: (一条描述) 极详细地描述光源类型（自然/人造）、方向（顺/逆/侧）、质感（硬/软）、色温以及光影对比度。
- **${KnowledgeBaseCategory.CLOTHING}**: (一条描述) 极详细地描述从头到脚的服装款式、面料质感（如丝绸、丹宁）、剪裁细节、褶皱表现、配饰和品牌特征。
- **${KnowledgeBaseCategory.STYLE}**: (一条描述) 极详细地描述图像的整体艺术风格、色彩倾向（如青橙色调）、后期处理风格（如胶片颗粒、柔光）和美学流派。

# LANGUAGE INSTRUCTION:
**CRITICAL:** All content values in the JSON output MUST be in **Simplified Chinese (简体中文)**.
- The JSON keys must remain in **English**.
- The values must be fully translated to Simplified Chinese.

# OUTPUT_FORMAT:
以结构化的JSON格式提供输出。
{
  "holistic_description": "（在这里填写完整的母版描述...）",
  "fragments": {
    "${KnowledgeBaseCategory.POSE}": "...",
    "${KnowledgeBaseCategory.COMPOSITION}": "...",
    "${KnowledgeBaseCategory.SCENE}": "...",
    "${KnowledgeBaseCategory.LIGHTING}": "...",
    "${KnowledgeBaseCategory.CLOTHING}": "...",
    "${KnowledgeBaseCategory.STYLE}": "..."
  }
}
`;

    try {
        const resultText = await callApi('/analyze-image', {
            images: [base64Image],
            prompt: prompt
        }, apiKey, true);

        const jsonString = resultText.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(jsonString) as KnowledgeBaseAnalysis;
    } catch (error) {
        console.error("KB Analysis failed:", error);
        throw new Error("知识库图像解析失败。");
    }
};

const createBaseDirectives = () => `
# CORE DIRECTIVES (NON-NEGOTIABLE):

## 1. STRICT OUTPUT FORMAT:
- **Aspect Ratio:** The output image MUST BE a **3:4 vertical portrait**. DO NOT generate landscape or square images. This is a mandatory instruction.
`;

export const generateMasterImage = async (
    referenceImages: string[],
    consistentPrompt: string,
    firstVariablePrompt: string,
    apiKey: string
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
        }, apiKey);

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
    modificationRequest: string,
    apiKey: string
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
    }, apiKey);

    return result.imageUrl;
};

export const generateSingleFromMaster = async (
    referenceImages: string[],
    masterImageSrc: string,
    consistentPrompt: string,
    variablePrompt: string,
    isRegeneration: boolean,
    apiKey: string,
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
        }, apiKey);

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

export const analyzeImageSmartRetouch = async (imageFile: File, apiKey: string): Promise<SmartRetouchAnalysisResult> => {
    const base64Image = await fileToBase64(imageFile);
    
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

    const prompt = `
# ROLE: 资深视觉分析师与商业摄影创意总监 (v3.0)

# TASK:
对上传的图片进行双重分析。
1. **深度解构 (Understanding):** 生成一段极度详细的“母版描述”，捕捉图像的每一个细节，包括微小的纹理、光影变化、材质触感及整体氛围。
2. **优化诊断 (Suggestions):** 像创意总监一样，指出画面的不足并给出大胆的、专业的修图与重绘指令。

# STEP 1: IMAGE UNDERSTANDING (母版描述 - ULTRA-DETAILED)
创作一段单一的、综合性的文字，捕捉图像的全部精髓。这段描述应该足够详细，包含人物特征、服装细节、环境氛围、光影质感等所有方面。
必须包含：
- **主体 (Subject):** 生理特征、面部细节、发丝质感。
- **场景 (Scene):** 空间结构、背景材质、关键道具。
- **光影 (Lighting):** 光源类型、方向、质感。
- **风格 (Style):** 摄影风格、色调分级。

# STEP 2: IMPROVEMENT SUGGESTIONS (优化指令)
不要输出任何分析过程。直接输出**修图与重绘指令 (Directives)**。
必须涵盖：
- **水印/Logo:** [强制] 如有，必须指令去除。
- **视觉冲击力:** 构图是否平淡？建议更具张力的视角。
- **人物状态:** 动作是否僵硬？建议更自然的Pose。
- **光影质感:** 建议更高级的布光。

${learnedContext}

# OUTPUT FORMAT:
以结构化的JSON格式提供输出。
{
  "understanding": "（在这里填写极度详细的母版描述...）",
  "suggestions": "1. [强制] 去除水印...\\n2. (指令)...\\n3. (指令)..." 
}
`;

    try {
        const resultText = await callApi('/analyze-image', {
            images: [base64Image],
            prompt: prompt
        }, apiKey, true);

        const jsonString = resultText.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(jsonString) as SmartRetouchAnalysisResult;
    } catch (error) {
        console.error("Smart Analysis failed:", error);
        return {
            understanding: "解析失败，请重试。",
            suggestions: "解析失败，请重试。"
        };
    }
};

export const mergeRetouchPromptsWithImage = async (
    imageFile: File,
    originalDescription: string,
    userInstructions: string,
    apiKey: string
): Promise<string> => {
    const base64Image = await fileToBase64(imageFile);
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
        return await callApi('/analyze-image', {
            images: [base64Image],
            prompt: prompt
        }, apiKey, true);
    } catch (error) {
        console.error("Prompt Merge failed:", error);
        return originalDescription + " " + userInstructions; 
    }
};

export const generateSmartRetouchImage = async (
    originalImageFile: File,
    fullDescription: string,
    apiKey: string
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
        strength: 0.65 
    }, apiKey);

    return result.imageUrl;
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

export const removeWatermark = async (imageFile: File, apiKey: string): Promise<string> => {
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
    }, apiKey);

    return result.imageUrl;
};

export interface PreprocessResult {
    hasWatermark: boolean;
    subjectDescription: string;
}

export const preprocessImageForGeneration = async (imageFile: File, apiKey: string): Promise<PreprocessResult> => {
    const base64Image = await fileToBase64(imageFile);
    
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
        const resultText = await callApi('/analyze-image', {
            images: [base64Image],
            prompt: prompt
        }, apiKey, true);

        const jsonString = resultText.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(jsonString) as PreprocessResult;
    } catch (error) {
        console.error("Preprocessing analysis failed:", error);
        return { hasWatermark: false, subjectDescription: "" };
    }
};
