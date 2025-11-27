
import { KnowledgeBaseEntry, AnalysisResult, ImageFile, KnowledgeBaseCategory } from '../types';

const KB_STORAGE_KEY = 'quantum_leap_ai_studio_kb';
const USER_ID_KEY = 'quantum_leap_user_id';
const API_BASE_URL = '/api'; // Use relative path for proxy

// Polyfill for uuid if crypto.randomUUID is not available (e.g. non-secure context)
function uuidv4() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Get or create userId
const getUserId = (): string => {
  let userId = localStorage.getItem(USER_ID_KEY);
  if (!userId) {
    userId = uuidv4();
    localStorage.setItem(USER_ID_KEY, userId);
  }
  return userId;
};

const THUMBNAIL_MAX_SIZE = 256; // Max width/height for thumbnails in pixels
export const KB_UPDATE_EVENT = 'kb_data_updated'; // Event name

/**
 * Resizes an image file to a thumbnail for storage efficiency.
 * @param file The image file to resize.
 * @returns A promise that resolves with the base64 string of the resized image.
 */
export const resizeImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let { width, height } = img;

                if (width > height) {
                    if (width > THUMBNAIL_MAX_SIZE) {
                        height *= THUMBNAIL_MAX_SIZE / width;
                        width = THUMBNAIL_MAX_SIZE;
                    }
                } else {
                    if (height > THUMBNAIL_MAX_SIZE) {
                        width *= THUMBNAIL_MAX_SIZE / height;
                        height = THUMBNAIL_MAX_SIZE;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    return reject(new Error('Could not get canvas context'));
                }
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.8)); // Use JPEG for better compression
            };
            img.onerror = reject;
            img.src = event.target?.result as string;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
};


export const getKnowledgeBase = async (): Promise<KnowledgeBaseEntry[]> => {
  try {
    const userId = getUserId();
    const response = await fetch(`${API_BASE_URL}/knowledge`, {
      headers: {
        'x-user-id': userId
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch knowledge base: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error("Failed to read knowledge base from server", error);
    // Fallback to empty array or maybe localStorage if offline? 
    // For now, return empty array to match previous behavior
    return [];
  }
};

export const saveKnowledgeBase = async (entries: KnowledgeBaseEntry[]): Promise<void> => {
  try {
    const userId = getUserId();
    const response = await fetch(`${API_BASE_URL}/knowledge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userId
      },
      body: JSON.stringify(entries)
    });

    if (!response.ok) {
      throw new Error(`Failed to save knowledge base: ${response.statusText}`);
    }

    // Dispatch event to notify listeners (e.g., KnowledgeBaseView)
    window.dispatchEvent(new Event(KB_UPDATE_EVENT));
  } catch (error) {
    console.error("Failed to save knowledge base to server", error);
  }
};

export const addMultipleKnowledgeBaseEntries = async (entries: Omit<KnowledgeBaseEntry, 'id' | 'usageCount'>[]): Promise<KnowledgeBaseEntry[]> => {
  const currentKB = await getKnowledgeBase();
  const newEntries = entries.map(e => ({...e, id: uuidv4(), usageCount: 0}));
  const updatedKB = [...newEntries, ...currentKB];
  await saveKnowledgeBase(updatedKB);
  return newEntries;
}

export const addAnalysisResultToKB = async (result: AnalysisResult, imageFiles: ImageFile[]): Promise<void> => {
    const newEntries: Omit<KnowledgeBaseEntry, 'id' | 'usageCount'>[] = [];
    const thumbnailPreviews = await Promise.all(imageFiles.map(img => resizeImage(img.file)));

    // Add consistent elements (associated with the first image)
    const { consistent_elements, inconsistent_elements } = result;
    const firstImagePreview = thumbnailPreviews[0];

    // --- Create FULL PROMPT entry ---
    const consistentText = `主要主体: ${consistent_elements.primary_subject.item} (品牌: ${consistent_elements.primary_subject.brand}), 关键特征: ${consistent_elements.primary_subject.key_features.join(', ')}, 材质: ${consistent_elements.primary_subject.materials.join(', ')}.
场景环境: ${consistent_elements.scene_environment.general_location}, 包含 ${consistent_elements.scene_environment.shared_elements.join(', ')} 等元素.
风格与质量: ${consistent_elements.image_quality_and_composition.style}, 使用 ${consistent_elements.image_quality_and_composition.lens_type} 拍摄, 光照为 ${consistent_elements.image_quality_and_composition.lighting}, 画质 ${consistent_elements.image_quality_and_composition.quality}.
情感氛围: ${consistent_elements.primary_subject.emotional_tone}.`;

    const firstVariable = inconsistent_elements[0];
    const variableText = firstVariable ? `宽高比: ${firstVariable.aspect_ratio}. 景别: ${firstVariable.framing}. 姿势: ${firstVariable.subject_pose}. 人物描述 (重要): ${firstVariable.person_description}. 独特细节: ${firstVariable.unique_details}. 相机设置: ${firstVariable.camera_settings}.` : '';

    newEntries.push({
        category: KnowledgeBaseCategory.FULL_PROMPT,
        promptFragment: `完整复刻: ${consistent_elements.primary_subject.item} 在 ${consistent_elements.scene_environment.general_location}`,
        sourceImagePreview: firstImagePreview,
        fullPrompt: {
            consistentPrompt: consistentText,
            variablePrompt: variableText
        }
    });

    // --- Create FRAGMENT entries ---
    newEntries.push({
        category: KnowledgeBaseCategory.SCENE,
        promptFragment: `场景环境: ${consistent_elements.scene_environment.general_location}, 包含 ${consistent_elements.scene_environment.shared_elements.join(', ')}`,
        sourceImagePreview: firstImagePreview
    });
     newEntries.push({
        category: KnowledgeBaseCategory.STYLE,
        promptFragment: `风格与质量: ${consistent_elements.image_quality_and_composition.style}, 使用 ${consistent_elements.image_quality_and_composition.lens_type}, 光照为 ${consistent_elements.image_quality_and_composition.lighting}`,
        sourceImagePreview: firstImagePreview
    });

    // Add inconsistent elements
    for (const item of inconsistent_elements) {
        const imageIndex = item.image_index - 1;
        if (imageIndex < 0 || imageIndex >= thumbnailPreviews.length) continue;
        const preview = thumbnailPreviews[imageIndex];

        if (item.subject_pose) {
            newEntries.push({ category: KnowledgeBaseCategory.POSE, promptFragment: item.subject_pose, sourceImagePreview: preview });
        }
        if (item.framing) {
            newEntries.push({ category: KnowledgeBaseCategory.COMPOSITION, promptFragment: item.framing, sourceImagePreview: preview });
        }
        if (item.person_description && item.person_description.toLowerCase().includes('穿着')) {
             newEntries.push({ category: KnowledgeBaseCategory.CLOTHING, promptFragment: item.person_description, sourceImagePreview: preview });
        }
    }
    
    addMultipleKnowledgeBaseEntries(newEntries);
};

export const addRetouchLearningEntry = async (originalFile: File, analysisText: string): Promise<void> => {
    try {
        const thumbnail = await resizeImage(originalFile);
        const newEntry: Omit<KnowledgeBaseEntry, 'id' | 'usageCount'> = {
            category: KnowledgeBaseCategory.RETOUCH_LEARNING,
            promptFragment: analysisText, // Storing the successful analysis/suggestion as the fragment
            sourceImagePreview: thumbnail,
            learningContext: analysisText // Redundant but explicit for the AI learning purpose
        };
        addMultipleKnowledgeBaseEntries([newEntry]);
        console.log("Saved retouching memory to Knowledge Base for AI learning.");
    } catch (error) {
        console.error("Failed to save retouch learning entry:", error);
    }
};

export const incrementEntryUsage = (id: string): void => {
    const currentKB = getKnowledgeBase();
    const updatedKB = currentKB.map(entry => 
        entry.id === id ? { ...entry, usageCount: (entry.usageCount || 0) + 1 } : entry
    );
    saveKnowledgeBase(updatedKB);
};


export const deleteKnowledgeBaseEntry = (id: string): void => {
  const currentKB = getKnowledgeBase();
  const updatedKB = currentKB.filter(entry => entry.id !== id);
  saveKnowledgeBase(updatedKB);
};
