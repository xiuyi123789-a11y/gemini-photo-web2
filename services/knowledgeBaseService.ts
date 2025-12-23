
import { KnowledgeBaseEntry, AnalysisResult, ImageFile, KnowledgeBaseCategory } from '../types';

const KB_STORAGE_KEY = 'quantum_leap_ai_studio_kb';
const USER_ID_KEY = 'quantum_leap_user_id';
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'; // Use proxy path or env var

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

const parseStringAnalysisSections = (analysis: string): Array<{ title: string; content: string }> => {
  const lines = analysis.split(/\r?\n/);
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
    const bracketHeaderMatch = line.trim().match(/^(?:\d+\.\s*)?【\s*(.+?)\s*】\s*$/);
    const boldHeaderMatch = line.trim().match(/^\*\*\s*(?:\d+\.\s*)?(.+?)\s*\*\*\s*$/);
    const mdHeaderMatch = line.trim().match(/^#{1,6}\s*(?:\d+\.\s*)?(.+?)\s*$/);
    const headerText = bracketHeaderMatch?.[1] || boldHeaderMatch?.[1] || mdHeaderMatch?.[1];

    if (headerText) {
      commit();
      const normalized = headerText.replace(/[：:]\s*$/, '').trim();
      current = { title: normalized, contentLines: [] };
      continue;
    }

    if (!current) continue;
    current.contentLines.push(rawLine);
  }

  commit();
  return sections.map(s => ({ title: s.title, content: s.contentLines.join('\n').trim() }));
};

const mapSectionsToKBCategories = (analysis: string): Partial<Record<KnowledgeBaseCategory, string>> => {
  const sections = parseStringAnalysisSections(analysis);
  const result: Partial<Record<KnowledgeBaseCategory, string>> = {};

  const setIf = (cat: KnowledgeBaseCategory, content: string) => {
    const value = content.trim();
    if (!value) return;
    result[cat] = value;
  };

  for (const section of sections) {
    const t = section.title;
    if (/(姿势|动作|Pose)/i.test(t)) setIf(KnowledgeBaseCategory.POSE, section.content);
    else if (/(场景|环境|Scene|Environment)/i.test(t)) setIf(KnowledgeBaseCategory.SCENE, section.content);
    else if (/(构图|镜头|Composition|Camera)/i.test(t)) setIf(KnowledgeBaseCategory.COMPOSITION, section.content);
    else if (/(光照|氛围|Lighting|Atmosphere)/i.test(t)) setIf(KnowledgeBaseCategory.LIGHTING, section.content);
    else if (/(服装|造型|Apparel|Styling)/i.test(t)) setIf(KnowledgeBaseCategory.CLOTHING, section.content);
    else if (/(风格|后期|Style|Post)/i.test(t)) setIf(KnowledgeBaseCategory.STYLE, section.content);
  }

  return result;
};

export const addAnalysisResultToKB = async (result: AnalysisResult, imageFiles: ImageFile[]): Promise<void> => {
    const newEntries: Omit<KnowledgeBaseEntry, 'id' | 'usageCount'>[] = [];
    
    // --- New Simple Mode (String Analysis) ---
    if (result.analysis && !result.consistent_elements) {
        // Find the corresponding image
        const matchedImage = imageFiles.find(img => img.file.name === result.fileName);
        const targetImage = matchedImage || imageFiles[0]; // Fallback to first image
        const thumbnail = await resizeImage(targetImage.file);
        const groupId = uuidv4();

        newEntries.push({
            category: KnowledgeBaseCategory.FULL_PROMPT,
            promptFragment: `智能解析: ${result.fileName || '未知文件'}`,
            sourceImagePreview: thumbnail,
            fullPrompt: {
                consistentPrompt: result.analysis,
                variablePrompt: ""
            },
            groupId
        });

        const fragments = mapSectionsToKBCategories(result.analysis);
        Object.entries(fragments).forEach(([category, content]) => {
          if (typeof content !== 'string' || !content.trim()) return;
          newEntries.push({
            category: category as KnowledgeBaseCategory,
            promptFragment: content.trim(),
            sourceImagePreview: thumbnail,
            groupId
          });
        });

        await addMultipleKnowledgeBaseEntries(newEntries);
        return;
    }

    // --- Complex/Legacy Mode ---
    const thumbnailPreviews = await Promise.all(imageFiles.map(img => resizeImage(img.file)));
    const groupId = uuidv4(); // Generate a group ID for this batch

    // Add consistent elements (associated with the first image)
    const { consistent_elements, inconsistent_elements } = result;
    if (!consistent_elements) return; // Safety check

    const firstImagePreview = thumbnailPreviews[0];

    // --- New Structure Handling (Structured Object) ---
    if (consistent_elements.synthesized_definition) {
        const def = consistent_elements.synthesized_definition;
        
        const consistentText = `核心主体: ${def.core_subject_details}. 人物特征: ${def.human_features || '无'}. 场景氛围: ${def.scene_atmosphere || '纯净背景'}. 视觉质量: ${def.visual_quality}.`;
        
        const firstVariable = inconsistent_elements[0];
        const variableText = firstVariable ? `[${firstVariable.content_type}] ${firstVariable.unique_features}` : '';

        // FULL PROMPT
        newEntries.push({
            category: KnowledgeBaseCategory.FULL_PROMPT,
            promptFragment: `完整复刻: ${def.subject_type}`,
            sourceImagePreview: firstImagePreview,
            fullPrompt: {
                consistentPrompt: consistentText,
                variablePrompt: variableText
            },
            groupId
        });

        // FRAGMENTS
        if (def.scene_atmosphere && def.scene_atmosphere !== 'null') {
            newEntries.push({
                category: KnowledgeBaseCategory.SCENE,
                promptFragment: `场景: ${def.scene_atmosphere}`,
                sourceImagePreview: firstImagePreview,
                groupId
            });
        }
        
        newEntries.push({
            category: KnowledgeBaseCategory.STYLE,
            promptFragment: `风格: ${def.visual_quality}`,
            sourceImagePreview: firstImagePreview,
            groupId
        });

        // Inconsistent Elements
        for (const item of inconsistent_elements) {
            const imageIndex = item.image_index; // New structure is 0-based index directly
            if (imageIndex < 0 || imageIndex >= thumbnailPreviews.length) continue;
            const preview = thumbnailPreviews[imageIndex];

            newEntries.push({
                category: KnowledgeBaseCategory.COMPOSITION, // Defaulting to Composition for now as it captures framing/pose
                promptFragment: `[${item.content_type}] ${item.unique_features}`,
                sourceImagePreview: preview,
                groupId
            });
        }

        addMultipleKnowledgeBaseEntries(newEntries);
        return;
    }

    // --- Legacy Structure Handling ---
    if (consistent_elements.primary_subject) {
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
            },
            groupId
        });

        // --- Create FRAGMENT entries ---
        newEntries.push({
            category: KnowledgeBaseCategory.SCENE,
            promptFragment: `场景环境: ${consistent_elements.scene_environment.general_location}, 包含 ${consistent_elements.scene_environment.shared_elements.join(', ')}`,
            sourceImagePreview: firstImagePreview,
            groupId
        });
         newEntries.push({
            category: KnowledgeBaseCategory.STYLE,
            promptFragment: `风格与质量: ${consistent_elements.image_quality_and_composition.style}, 使用 ${consistent_elements.image_quality_and_composition.lens_type}, 光照为 ${consistent_elements.image_quality_and_composition.lighting}`,
            sourceImagePreview: firstImagePreview,
            groupId
        });

        // Add inconsistent elements
        for (const item of inconsistent_elements) {
            const imageIndex = item.image_index - 1;
            if (imageIndex < 0 || imageIndex >= thumbnailPreviews.length) continue;
            const preview = thumbnailPreviews[imageIndex];

            if (item.subject_pose) {
                newEntries.push({ category: KnowledgeBaseCategory.POSE, promptFragment: item.subject_pose, sourceImagePreview: preview, groupId });
            }
            if (item.framing) {
                newEntries.push({ category: KnowledgeBaseCategory.COMPOSITION, promptFragment: item.framing, sourceImagePreview: preview, groupId });
            }
            if (item.person_description && item.person_description.toLowerCase().includes('穿着')) {
                 newEntries.push({ category: KnowledgeBaseCategory.CLOTHING, promptFragment: item.person_description, sourceImagePreview: preview, groupId });
            }
        }
        
        addMultipleKnowledgeBaseEntries(newEntries);
    }
};

export const addRetouchLearningEntry = async (originalFile: File, analysisText: string): Promise<void> => {
    try {
        const thumbnail = await resizeImage(originalFile);
        const newEntry: Omit<KnowledgeBaseEntry, 'id' | 'usageCount'> = {
            category: KnowledgeBaseCategory.RETOUCH_LEARNING,
            promptFragment: analysisText, // Storing the successful analysis/suggestion as the fragment
            sourceImagePreview: thumbnail,
            learningContext: analysisText, // Redundant but explicit for the AI learning purpose
            groupId: uuidv4()
        };
        
        await addMultipleKnowledgeBaseEntries([newEntry]);
    } catch (e) {
        console.error("Failed to add retouch learning entry", e);
    }
};

export const saveKBAnalysisToKB = async (analysis: any, imageFile: File): Promise<void> => {
    // analysis is KnowledgeBaseAnalysis
    const thumbnail = await resizeImage(imageFile);
    const groupId = uuidv4();
    const newEntries: Omit<KnowledgeBaseEntry, 'id' | 'usageCount'>[] = [];

    // Add Holistic Description (Motherboard) as Full Prompt or Style? 
    // Maybe Full Prompt category but without strict Consistent/Variable split?
    // Or just treat it as SCENE/STYLE combination?
    // Let's add it as FULL_PROMPT for now, or maybe we don't save the motherboard description directly if not requested.
    // But user says "save to knowledge base".
    
    if (analysis.holistic_description) {
         newEntries.push({
            category: KnowledgeBaseCategory.FULL_PROMPT,
            promptFragment: `全图解构: ${analysis.holistic_description.substring(0, 50)}...`,
            sourceImagePreview: thumbnail,
            fullPrompt: {
                consistentPrompt: analysis.holistic_description,
                variablePrompt: ""
            },
            groupId
        });
    }

    if (analysis.fragments) {
        Object.entries(analysis.fragments).forEach(([category, content]) => {
            if (content && typeof content === 'string') {
                newEntries.push({
                    category: category as KnowledgeBaseCategory,
                    promptFragment: content,
                    sourceImagePreview: thumbnail,
                    groupId
                });
            }
        });
    }

    if (newEntries.length > 0) {
        await addMultipleKnowledgeBaseEntries(newEntries);
    }
};

export const incrementEntryUsage = async (id: string): Promise<void> => {
    const currentKB = await getKnowledgeBase();
    const updatedKB = currentKB.map(entry => 
        entry.id === id ? { ...entry, usageCount: (entry.usageCount || 0) + 1 } : entry
    );
    await saveKnowledgeBase(updatedKB);
};

// --- Deletion & Trash Bin Logic ---

// Soft delete (Move to Trash)
export const softDeleteKnowledgeBaseEntries = async (ids: string[]): Promise<void> => {
  const currentKB = await getKnowledgeBase();
  const now = Date.now();
  
  // Find entries to delete
  const entriesToDelete = currentKB.filter(e => ids.includes(e.id));
  const groupIdsToDelete = new Set<string>();

  // Identify FULL_PROMPT entries to trigger cascading delete
  entriesToDelete.forEach(e => {
    if (e.category === KnowledgeBaseCategory.FULL_PROMPT && e.groupId) {
        groupIdsToDelete.add(e.groupId);
    }
  });

  const updatedKB = currentKB.map(entry => {
      // Delete if ID matches OR if it belongs to a group being deleted (Cascade)
      if (ids.includes(entry.id) || (entry.groupId && groupIdsToDelete.has(entry.groupId))) {
          return { ...entry, deletedAt: now };
      }
      return entry;
  });

  await saveKnowledgeBase(updatedKB);
};

// Restore from Trash
export const restoreKnowledgeBaseEntries = async (ids: string[]): Promise<void> => {
    const currentKB = await getKnowledgeBase();
    const updatedKB = currentKB.map(entry => {
        if (ids.includes(entry.id)) {
             // Remove deletedAt field
            const { deletedAt, ...rest } = entry;
            return rest;
        }
        return entry;
    });
    await saveKnowledgeBase(updatedKB);
};

// Permanently Delete
export const permanentlyDeleteKnowledgeBaseEntries = async (ids: string[]): Promise<void> => {
    const currentKB = await getKnowledgeBase();
    const updatedKB = currentKB.filter(entry => !ids.includes(entry.id));
    await saveKnowledgeBase(updatedKB);
};

// Clean up old trash (older than 30 days)
export const cleanUpTrash = async (): Promise<void> => {
    const currentKB = await getKnowledgeBase();
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    
    const updatedKB = currentKB.filter(entry => {
        if (entry.deletedAt && entry.deletedAt < thirtyDaysAgo) {
            return false; // Delete
        }
        return true; // Keep
    });
    
    if (updatedKB.length !== currentKB.length) {
        await saveKnowledgeBase(updatedKB);
        console.log("Auto-cleaned up old trash items.");
    }
};

// Kept for backward compatibility if needed, but softDelete is preferred
export const deleteKnowledgeBaseEntry = async (id: string): Promise<void> => {
  await softDeleteKnowledgeBaseEntries([id]);
};
