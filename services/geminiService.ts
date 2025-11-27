import { GoogleGenAI, Modality } from "@google/genai";
import { AnalysisResult, CategorizedKBSuggestions, KnowledgeBaseCategory, KnowledgeBaseAnalysis } from '../types';
import { getKnowledgeBase } from './knowledgeBaseService';

// Helper to create AI instance on-the-fly
const getAi = (apiKey: string): GoogleGenAI => {
    if (!apiKey) {
        throw new Error("API Key is missing. Please provide a valid API key.");
    }
    return new GoogleGenAI({ apiKey });
};

// Helper to convert File to Gemini Part
const fileToGenerativePart = async (file: File) => {
  const base64EncodedDataPromise = new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.readAsDataURL(file);
  });
  return {
    inlineData: { data: await base64EncodedDataPromise, mimeType: file.type },
  };
};

// Helper to convert base64 string to Gemini Part
const base64ToGenerativePart = (base64String: string, mimeType: string = 'image/png') => {
    const data = base64String.startsWith('data:') ? base64String.split(',')[1] : base64String;
    return {
        inlineData: {
            data,
            mimeType,
        }
    };
};

export const analyzeImages = async (images: File[], apiKey: string): Promise<AnalysisResult> => {
  const ai = getAi(apiKey);
  const imageParts = await Promise.all(images.map(fileToGenerativePart));

  const prompt = `
# ROLE: 资深视觉分析师与摄影指导 (v2.0)

# TASK:
分析以下 ${images.length} 张图片。你的目标是识别并结构化所有图片中的一致性（共享）和非一致性（独特）元素。分析需要极度深入，务必涵盖所有下述标准。

# ANALYSIS_CRITERIA:
1.  **主体 (Subject):** 描述物品、特征、材质。
2.  **品牌识别 (Brand Identification):** 如果可见，明确指出品牌名称或标志。
3.  **情感氛围 (Emotional Tone):** 描述图片传达的情感或氛围 (例如 "轻松、居家", "动感、街头")。
4.  **场景 (Scene):** 描述地点和共享的背景元素。
5.  **风格与质量 (Style & Quality):** 描述摄影风格、光照、画质和镜头类型。
6.  **景别 (Framing):** 识别景别（如“全身构图”、“腿部特写”）。
7.  **人物与姿势 (Person & Pose):** 关键！严格遵守原图。如果人物面部被遮挡或未出现，必须明确指出“面部不可见”或“被手机遮挡”。描述姿势和服装。
8.  **相机设置推断 (Inferred Camera Settings):** 根据景深和动态模糊推断可能的相机设置。例如 '大光圈（f/1.8），背景虚化明显'。
9.  **宽高比 (Aspect Ratio):** 识别每张图片的宽高比。如果无法明确判断，默认为“3:4竖构图”。

# OUTPUT_FORMAT:
以结构化的JSON格式提供输出。不要在JSON结构之外添加任何解释性文字。
{
  "consistent_elements": {
    "primary_subject": {
      "item": "描述主要物品",
      "key_features": ["关键特征列表"],
      "materials": ["材质列表"],
      "brand": "例如 '鞋舌和鞋侧有Kappa标志'",
      "emotional_tone": "例如 '轻松、舒适的居家氛围'"
    },
    "scene_environment": {
      "general_location": "通用地点",
      "shared_elements": ["共享的背景元素"]
    },
    "image_quality_and_composition": {
      "style": "摄影风格",
      "lighting": "光照描述",
      "quality": "图像质量",
      "lens_type": "推断的镜头类型"
    }
  },
  "inconsistent_elements": [
    {
      "image_index": 1,
      "framing": "景别描述",
      "subject_pose": "姿势描述",
      "person_description": "人物描述 (服装, 面部是否可见)",
      "unique_details": "独特的细节",
      "aspect_ratio": "例如 '3:4竖构图'",
      "camera_settings": "例如 '大光圈（f/1.8），背景虚化明显'"
    }
  ]
}`;

  const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash', 
      contents: { parts: [...imageParts, { text: prompt }] },
      config: {
          responseMimeType: 'application/json',
      }
  });

  try {
    const jsonString = response.text.trim();
    return JSON.parse(jsonString) as AnalysisResult;
  } catch (error) {
    console.error("Failed to parse Gemini response:", response.text);
    throw new Error("API 返回了无效的 JSON 响应。请重试。");
  }
};

export const analyzeAndCategorizeImageForKB = async (imageFile: File, apiKey: string): Promise<KnowledgeBaseAnalysis> => {
    const ai = getAi(apiKey);
    const imagePart = await fileToGenerativePart(imageFile);
    const prompt = `
# ROLE: 资深提示词工程师与图像解构专家 (v3.0)

# TASK:
对提供的图片进行两次分析。首先，生成一段完整的、连贯的、极度详细的“母版”描述。然后，从该描述中提炼并拆解出独立的、可复用的高质量提示词片段，并为每个片段分配最合适的类别。

# STEP 1: HOLISTIC DESCRIPTION (母版描述)
创作一段单一的、综合性的文字，捕捉图像的全部精髓。这段描述应该足够详细，以便AI可以仅凭此文字就高度复刻出原图的场景、人物、氛围和风格。

# STEP 2: FRAGMENT EXTRACTION (片段拆解)
基于你上面写的“母版描述”，将其拆解为以下类别的独立提示词片段。确保片段来自母版描述，并保持其高质量。
- **${KnowledgeBaseCategory.POSE}**: 极详细地描述人物的姿势、身体朝向、动作、手势、视线方向和表情。
- **${KnowledgeBaseCategory.SCENE}**: 极详细地描述具体环境、地点、背景元素、关键道具和整体氛围。
- **${KnowledgeBaseCategory.COMPOSITION}**: 极详细地描述构图方式、景别、相机高度和角度、镜头选择和效果。
- **${KnowledgeBaseCategory.LIGHTING}**: 极详细地描述光源类型、方向、质感、色温以及它如何塑造氛围。
- **${KnowledgeBaseCategory.CLOTHING}**: 极详细地描述从上到下的服装、配饰、品牌（如果可见）、材质、发型和妆容。
- **${KnowledgeBaseCategory.STYLE}**: 极详细地描述图像的整体艺术风格、色彩处理和后期效果。

# OUTPUT_FORMAT:
以结构化的JSON格式提供输出。
{
  "holistic_description": "（在这里填写完整的母版描述，例如：一张超现实主义照片，描绘了一个19岁的亚洲女大学生，在光线明亮的宿舍里，她坐在地毯上，穿着白色西装外套和涂鸦牛仔裤，通过镜子进行低角度自拍，焦点在她的鞋子上...）",
  "fragments": {
    "${KnowledgeBaseCategory.POSE}": ["一个女孩坐在镜子前的地毯上，双腿交叉，身体前倾", "单手举起手机自拍，另一只手自然地放在膝盖上"],
    "${KnowledgeBaseCategory.COMPOSITION}": ["低角度拍摄，焦点在人物脚下的鞋子上", "前景有镜子的白色边框，形成画中画构图"],
    "${KnowledgeBaseCategory.SCENE}": ["在光线明亮的大学女生宿舍里", "背景里有床、书桌和墙上的海报"],
    "${KnowledgeBaseCategory.LIGHTING}": ["来自侧面窗户的柔和自然光", "温暖的色调"],
    "${KnowledgeBaseCategory.CLOTHING}": ["白色休闲西装外套，内搭黑色高领打底衫", "带有涂鸦印花的深蓝色阔腿牛仔裤"],
    "${KnowledgeBaseCategory.STYLE}": ["超现实主义照片，细节丰富", "生活方式抓拍风格"]
  }
}
`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash', 
        contents: { parts: [imagePart, { text: prompt }] },
        config: {
            responseMimeType: 'application/json',
        }
    });

    try {
        const jsonString = response.text.trim();
        return JSON.parse(jsonString) as KnowledgeBaseAnalysis;
    } catch (error) {
        console.error("Failed to parse KB analysis response:", response.text);
        throw new Error("知识库图像解析失败。");
    }
};

const processGenerationResponse = (response: any): string => {
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const base64ImageBytes: string = part.inlineData.data;
        return `data:image/png;base64,${base64ImageBytes}`;
      }
    }
    throw new Error('图片生成失败，模型未返回图像数据。');
};

export const removeWatermark = async (imageFile: File, apiKey: string): Promise<string> => {
    const ai = getAi(apiKey);
    const imagePart = await fileToGenerativePart(imageFile);
    const prompt = `
# ROLE: AI Image Restoration Expert
# TASK: Analyze the provided image. Identify and seamlessly remove any watermarks, logos, text overlays, or other distracting graphical elements. Restore the underlying image content as faithfully as possible.
# OUTPUT: Return only the clean, restored image. Do not add any elements. Do not change the composition.
`;
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [imagePart, { text: prompt }] },
        config: {
            responseModalities: [Modality.IMAGE],
        },
    });
    return processGenerationResponse(response);
};


const createBaseDirectives = () => `
# CORE DIRECTIVES (NON-NEGOTIABLE):

## 1. DEFAULT CHARACTER AESTHETICS:
Apply these defaults unless explicitly contradicted by the user's prompt.
- **Ethnicity:** All human subjects MUST be depicted as **Asian**.
- **Female Physique:** If the subject is female, render her with a **slim waist, long legs, and a C-cup bust**. She should have a healthy, athletic yet feminine build.
- **Male Physique:** If the subject is male, render him as **handsome with a lean, athletic build (defined but not bulky muscles)**.

## 2. STRICT OUTPUT FORMAT:
- **Aspect Ratio:** The output image MUST BE a **3:4 vertical portrait**. DO NOT generate landscape or square images. This is a mandatory instruction.
`;

export const generateMasterImage = async (
    referenceImages: string[],
    consistentPrompt: string,
    firstVariablePrompt: string,
    apiKey: string
): Promise<string> => {
    const ai = getAi(apiKey);
    const referenceImageParts = referenceImages.map(base64Str => base64ToGenerativePart(base64Str));
    const directives = createBaseDirectives();
    const prompt = `
# ROLE: Master AI Art Director & Photographer

# TASK: 
Generate a single, ultra-realistic, "Key Visual" or "Master Image". This image will serve as the absolute visual benchmark for an entire series. It must establish the definitive look for the scene, lighting, and human subject.

# REFERENCE_IMAGES:
Provided as input. These are the products. The products' appearance in the generated image must be an EXACT match to these references, synthesizing their features if multiple are provided.

${directives}

# CREATIVE BRIEF FOR THE MASTER IMAGE:

## Consistent Elements (Establish this theme):
${consistentPrompt}

## Variable Elements (The specific shot to capture for this Master Image):
${firstVariablePrompt}
`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [...referenceImageParts, { text: prompt }] },
        config: {
          responseModalities: [Modality.IMAGE],
        },
    });

    return processGenerationResponse(response);
};

export const modifyMasterImage = async (
    referenceImages: string[],
    masterImageSrc: string,
    consistentPrompt: string,
    firstVariablePrompt: string,
    modificationRequest: string,
    apiKey: string
): Promise<string> => {
    const ai = getAi(apiKey);
    const referenceImageParts = referenceImages.map(base64Str => base64ToGenerativePart(base64Str));
    const masterImagePart = base64ToGenerativePart(masterImageSrc);
    const directives = createBaseDirectives();

    const prompt = `
# ROLE: AI Photo Editor & Retoucher

# TASK: 
Modify the provided "Current Master Image" based on a specific user request. The goal is to refine the image while maintaining perfect consistency with the products in the "Reference Product Images".

# INPUT IMAGES:
1.  **Reference Product Images:** Use these for the EXACT product details. The products must not be altered.
2.  **Current Master Image:** This is the image to be modified.

# MODIFICATION REQUEST:
"${modificationRequest}"

${directives}

# ORIGINAL CREATIVE BRIEF (For Context):

## Consistent Elements:
${consistentPrompt}

## Variable Elements:
${firstVariablePrompt}

# OUTPUT:
Generate a new version of the Master Image that incorporates the modification request.
`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [...referenceImageParts, masterImagePart, { text: prompt }] },
        config: {
          responseModalities: [Modality.IMAGE],
        },
    });

    return processGenerationResponse(response);
};


export const generateSingleFromMaster = async (
    referenceImages: string[],
    masterImageSrc: string,
    consistentPrompt: string,
    variablePrompt: string,
    isRegeneration: boolean,
    apiKey: string
): Promise<string> => {
    const ai = getAi(apiKey);
    const referenceImageParts = referenceImages.map(base64Str => base64ToGenerativePart(base64Str));
    const masterImagePart = base64ToGenerativePart(masterImageSrc);
    const directives = createBaseDirectives();

    const prompt = `
# ROLE: AI Photoshoot Production Artist

# TASK:
Generate a single, new photorealistic image that belongs to the same series as the provided "Master Image". Adherence to the Master Image's established aesthetics is the top priority.

# INPUT IMAGES:
1.  **Reference Product Images:** The products in your new image must EXACTLY match these.
2.  **Master Image:** This is the visual benchmark. Your generated image MUST match the Master Image in: Environment, Subject, Lighting, and Overall Style.

${directives}

# CREATIVE BRIEF FOR THIS NEW SHOT:

## Consistent Elements (From the original shoot, for context):
${consistentPrompt}

## Variable Elements (The specific new shot to capture):
${variablePrompt}
${isRegeneration ? `\n- **Creative Variation:** Generate a completely new and unique artistic take for this specific shot, while adhering to all core directives. Use a new random seed: ${Math.random()}` : ''}
`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [...referenceImageParts, masterImagePart, { text: prompt }] },
        config: {
          responseModalities: [Modality.IMAGE],
        },
    });

    return processGenerationResponse(response);
}


// --- SMART RETOUCH SERVICES ---

export const analyzeImageForImprovement = async (imageFile: File, apiKey: string): Promise<string> => {
    const ai = getAi(apiKey);
    const imagePart = await fileToGenerativePart(imageFile);
    
    // AI LEARNING: Fetch previous successful retouch examples from Knowledge Base
    const kbEntries = await getKnowledgeBase();
    const learnedExamples = kbEntries
        .filter(e => e.category === KnowledgeBaseCategory.RETOUCH_LEARNING)
        .slice(0, 3);

    let learnedContext = "";
    if (learnedExamples.length > 0) {
        learnedContext = `
# LEARNED SUCCESSFUL DIRECTIVES:
(Based on previous user feedback, use these as examples of the desired output style):
${learnedExamples.map((e, i) => `
--- STYLE REFERENCE ${i + 1} ---
${e.promptFragment}
`).join('\n')}
`;
    }

    const prompt = `
# ROLE: 资深商业摄影创意总监 (Creative Director)

# TASK:
对上传的图片进行“诊断”并给出“重绘指令”。
不要输出任何分析过程或废话。直接输出**修图与重绘指令 (Directives)**。
你的指令必须大胆、专业，涵盖构图、光影、甚至人物动作和拍摄视角的调整建议。

# MANDATORY CHECKS (必须检查):
1. **水印/Logo:** 如有，必须指令去除。
2. **视觉冲击力:** 构图是否平淡？建议更具张力的视角（如低角度仰拍、大特写）。
3. **人物状态:** 动作是否僵硬？建议更自然的Pose（如撩发、侧身、回眸）。
4. **光影质感:** 是否平光？建议更高级的布光（如伦勃朗光、侧逆光、电影感色调）。

${learnedContext}

# OUTPUT FORMAT (纯指令列表，无序号标题，每行一条):
1. [强制] 去除画面中所有的水印、文字和无关图标。
2. (指令: 调整视角/构图) ...
3. (指令: 调整人物动作/神态) ...
4. (指令: 优化光影/色调) ...
5. (指令: 细节修复) ...
`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash', 
        contents: { parts: [imagePart, { text: prompt }] },
    });
    
    return response.text.trim();
};


export const generateImprovedImage = async (
    originalImageFile: File,
    improvementInstructions: string,
    apiKey: string
): Promise<string> => {
    const ai = getAi(apiKey);
    const imagePart = await fileToGenerativePart(originalImageFile);
    const directives = createBaseDirectives();
    
    const prompt = `
# ROLE: Visionary AI Artist & Image Reconstruction Expert

# TASK:
Re-imagine and Re-generate the input image based on the provided **EXECUTION DIRECTIVES**.
Do NOT just "filter" the original image. You are authorized to make **STRUCTURAL CHANGES** (pose, camera angle, composition) if the directives ask for it.

# INPUT:
1. **Original Image:** Use this as a "Reference Sketch" for character identity (clothes, hair color, face features) and general scene context. **DO NOT** be constrained by the original pixel grid if the directives imply a change in perspective or pose.
2. **Directives:** ${improvementInstructions}

# OPERATIONAL RULES (AGGRESSIVE MODE):
1.  **Structure:** If directives say "change pose" or "change angle", you MUST generate a NEW composition that follows that instruction, even if it mismatches the original image's outline.
2.  **Identity:** Preserve the character's identity (face features, clothing style) strictly.
3.  **Watermarks:** REMOVE ALL WATERMARKS. The output must be pristine.
4.  **Quality:** The output must be 8K resolution, commercial photography quality.

${directives}

# OUTPUT:
Return ONLY the final generated image.
`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [imagePart, { text: prompt }] },
        config: {
          responseModalities: [Modality.IMAGE],
        },
    });

    return processGenerationResponse(response);
};