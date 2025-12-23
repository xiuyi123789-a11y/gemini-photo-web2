
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AnalysisResult, ImageFile, VariablePrompt, GeneratedImageState, KnowledgeBaseEntry, KnowledgeBaseCategory, ReferenceImageFile, KnowledgeBaseAnalysis } from '../types';
import { MagicWandIcon, PlusIcon, TrashIcon, RefreshIcon, DownloadIcon, ZoomInIcon, EyeIcon, PlayIcon, BookOpenIcon } from './IconComponents';
import { generateMasterImage, modifyMasterImage, generateSingleFromMaster, analyzeAndMergeReferenceImagesForGeneration, analyzeAndCategorizeImageForKB } from '../services/replicateService';
import { getKnowledgeBase, incrementEntryUsage, KB_UPDATE_EVENT, saveKBAnalysisToKB } from '../services/knowledgeBaseService';
import { LoadingSpinner } from './LoadingSpinner';
import { KnowledgeBaseModal } from './KnowledgeBaseModal';
import { ImageModal } from './ImageModal';
import { logOperation } from '../services/errorNotebookService';

// Simple UUID generator polyfill for non-secure contexts
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

interface GenerationViewProps {
  initialAnalysisResult: AnalysisResult[] | null;
}

const MAX_REF_IMAGES = 8;

export const GenerationView: React.FC<GenerationViewProps> = ({ initialAnalysisResult }) => {
  const [referenceImages, setReferenceImages] = useState<ReferenceImageFile[]>([]);
  const [consistentPrompt, setConsistentPrompt] = useState('');
  const [variablePrompts, setVariablePrompts] = useState<VariablePrompt[]>([
    { id: uuidv4(), prompt: '' }
  ]);

  const [kbCache, setKbCache] = useState<KnowledgeBaseEntry[]>([]);
  const [copyRecommendations, setCopyRecommendations] = useState<Record<string, string[]>>({});
  const [autoFillBackups, setAutoFillBackups] = useState<Record<string, string>>({});
  
  const [masterImage, setMasterImage] = useState<{ src: string | null; isLoading: boolean }>({ src: null, isLoading: false });
  const [masterPromptStale, setMasterPromptStale] = useState(false);
  const [modificationPrompt, setModificationPrompt] = useState('');
  
  const [error, setError] = useState<string | null>(null);
  const [generatedImages, setGeneratedImages] = useState<GeneratedImageState>({});
  const [enlargedImage, setEnlargedImage] = useState<string | null>(null);
  
  const [isKbModalOpen, setIsKbModalOpen] = useState(false);
  const [editingField, setEditingField] = useState<'consistent' | string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const prevRefImagesCount = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const consistentTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;

    const refresh = async () => {
      const start = performance.now();
      try {
        const entries = await getKnowledgeBase();
        if (!alive) return;
        setKbCache(entries);
        logOperation('kb_cache_refresh', { count: entries.length, elapsedMs: Math.round(performance.now() - start) });
      } catch (e: any) {
        logOperation('kb_cache_refresh_failed', { message: e?.message || 'unknown', elapsedMs: Math.round(performance.now() - start) });
      }
    };

    refresh();
    const onUpdate = () => refresh();
    window.addEventListener(KB_UPDATE_EVENT, onUpdate);
    return () => {
      alive = false;
      window.removeEventListener(KB_UPDATE_EVENT, onUpdate);
    };
  }, []);

  useEffect(() => {
     if (initialAnalysisResult && initialAnalysisResult.length > 0) {
         populateFromAnalysis(initialAnalysisResult, true);
     }
   }, [initialAnalysisResult]);

   const populateFromAnalysis = (results: AnalysisResult[], updateVariables: boolean = false) => {
         // Combine all analysis results into one text
         const combinedAnalysis = results.map(r => `[${r.fileName || 'Image'}]\n${r.analysis || ''}`).join('\n\n');
         
         setConsistentPrompt(combinedAnalysis.trim());
         
         if (updateVariables) {
             // Since we don't have structured variables anymore, reset or keep one empty
             setVariablePrompts([{ id: uuidv4(), prompt: '' }]);
         }
   };

  // Removed automatic trigger of old analysis to prevent overwriting the new specific subject identification
  /*
  useEffect(() => {
    const allProcessed = referenceImages.every(img => !img.isProcessing);
    const hasImages = referenceImages.length > 0;
    
    if (hasImages && allProcessed) {
         if (referenceImages.length !== prevRefImagesCount.current) {
             triggerAutoAnalysis();
             prevRefImagesCount.current = referenceImages.length;
         }
    } else if (referenceImages.length === 0) {
         prevRefImagesCount.current = 0;
    }
  }, [referenceImages, apiKey]);
  */
  
  // Update ref count without triggering analysis
  useEffect(() => {
       if (referenceImages.length !== prevRefImagesCount.current) {
           prevRefImagesCount.current = referenceImages.length;
       }
  }, [referenceImages]);

  const handleFileSelect = useCallback(async (selectedFiles: ImageFile[]) => {
    const newUploads = selectedFiles.slice(0, MAX_REF_IMAGES - referenceImages.length);
    if (newUploads.length === 0) return;

    const newImageStates: ReferenceImageFile[] = newUploads.map(imgFile => ({
        id: uuidv4(),
        file: imgFile.file,
        originalPreview: imgFile.preview,
        processedPreview: imgFile.preview,
        isProcessing: false,
    }));

    setReferenceImages(prev => [...prev, ...newImageStates]);
  }, [referenceImages.length]);

  const handleStartAnalysis = async () => {
    if (referenceImages.length === 0) {
        setError("请先上传参考图片。");
        return;
    }

    setIsAnalyzing(true);
    setError(null);

    try {
        const validFiles = referenceImages.map(img => img.file);
        if (validFiles.length > 0) {
            const mergedPrompt = await analyzeAndMergeReferenceImagesForGeneration(validFiles);
            setConsistentPrompt(mergedPrompt.trim());
            setVariablePrompts([{ id: uuidv4(), prompt: '' }]);
            setEditingField('consistent');
            requestAnimationFrame(() => {
                consistentTextareaRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                consistentTextareaRef.current?.focus();
            });
        }

    } catch (e: any) {
        console.error("Analysis workflow failed", e);
        setError(e.message || "图片分析流程失败");
    } finally {
        setIsAnalyzing(false);
    }
  };

  const handleDeleteReferenceImage = (id: string) => {
    setReferenceImages(prev => prev.filter(img => img.id !== id));
  };
  
  const handleConsistentPromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setConsistentPrompt(e.target.value);
    if(masterImage.src) setMasterPromptStale(true);
  }
  
  const handleVariablePromptChange = (id: string, value: string) => {
    setVariablePrompts(prev => prev.map(p => p.id === id ? { ...p, prompt: value } : p));
    if(id === variablePrompts[0]?.id && masterImage.src) {
        setMasterPromptStale(true);
    }
  };

  const addVariablePrompt = () => {
    setVariablePrompts(prev => [...prev, { id: uuidv4(), prompt: '' }]);
  };

  const removeVariablePrompt = (id: string) => {
    setVariablePrompts(prev => prev.filter(p => p.id !== id));
    setGeneratedImages(prev => {
        const newState = {...prev};
        delete newState[id];
        return newState;
    });
  };

  const getProcessedImages = () => {
      return referenceImages.map(img => img.originalPreview);
  };

  const handleVariableImageUpload = async (id: string, files: File[]) => {
      const newImages = files.map(file => ({
        id: uuidv4(),
        file,
        preview: URL.createObjectURL(file)
      }));

      setVariablePrompts(prev =>
        prev.map(p =>
          p.id === id ? { ...p, referenceImages: [...(p.referenceImages || []), ...newImages] } : p
        )
      );
  };

  const handleAnalyzeVariableImages = async (
    id: string,
    imagesToAnalyze?: NonNullable<VariablePrompt['referenceImages']>
  ) => {
      const vp = variablePrompts.find(p => p.id === id);
      const images = imagesToAnalyze || vp?.referenceImages || [];
      if (images.length === 0) return;

      setVariablePrompts(prev => prev.map(p => p.id === id ? { ...p, isAnalyzing: true } : p));

      const settled = await Promise.allSettled(images.map(img => analyzeAndCategorizeImageForKB(img.file)));

      setVariablePrompts(prev =>
        prev.map(p => {
          if (p.id !== id) return p;
          const nextAnalyses: Record<string, KnowledgeBaseAnalysis> = { ...(p.imageAnalyses || {}) };
          settled.forEach((res, index) => {
            if (res.status !== 'fulfilled') return;
            nextAnalyses[images[index].id] = res.value;
          });
          return { ...p, imageAnalyses: nextAnalyses, isAnalyzing: false };
        })
      );
  };

  const handleSaveVariableToKB = async (id: string) => {
      const prompt = variablePrompts.find(p => p.id === id);
      const images = prompt?.referenceImages || [];
      const analyses = prompt?.imageAnalyses || {};
      const tasks = images
        .map(img => ({ img, analysis: analyses[img.id] }))
        .filter((x): x is { img: NonNullable<VariablePrompt['referenceImages']>[number]; analysis: KnowledgeBaseAnalysis } => Boolean(x.analysis));

      if (tasks.length === 0) return;

      const results = await Promise.allSettled(tasks.map(t => saveKBAnalysisToKB(t.analysis, t.img.file)));
      const okCount = results.filter(r => r.status === 'fulfilled').length;
      const failedCount = results.length - okCount;

      if (failedCount === 0) {
        alert(`已保存到知识库！(${okCount} 张)`);
      } else {
        alert(`已保存 ${okCount} 张，失败 ${failedCount} 张`);
      }
  };

  const handleDeleteVariableImage = (promptId: string, imageId?: string) => {
      setVariablePrompts(prev =>
        prev.map(p => {
          if (p.id !== promptId) return p;
          if (!imageId) return { ...p, referenceImages: [], imageAnalyses: {} };

          const nextImages = (p.referenceImages || []).filter(img => img.id !== imageId);
          const nextAnalyses = { ...(p.imageAnalyses || {}) };
          delete nextAnalyses[imageId];
          return { ...p, referenceImages: nextImages, imageAnalyses: nextAnalyses };
        })
      );
  };

  const mergeVariablePromptFragments = (vp: VariablePrompt): Record<string, string> => {
    const analyses = Object.values(vp.imageAnalyses || {});
    const merged: Record<string, string[]> = {};

    for (const analysis of analyses) {
      for (const [key, value] of Object.entries(analysis.fragments || {})) {
        if (typeof value !== 'string') continue;
        const text = value.trim();
        if (!text) continue;
        merged[key] = merged[key] ? [...merged[key], text] : [text];
      }
    }

    const mergedStrings: Record<string, string> = {};
    for (const [key, values] of Object.entries(merged)) {
      const unique = Array.from(new Set(values.map(v => v.trim()).filter(Boolean)));
      if (unique.length > 0) mergedStrings[key] = unique.join('\n');
    }
    return mergedStrings;
  };

  const handleGenerateMaster = async (isRegeneration = false) => {
    const processedImages = getProcessedImages();
    if (!processedImages || processedImages.length === 0 || (!variablePrompts[0]?.prompt && !consistentPrompt)) {
      setError("请上传参考图，并确保有一致性描述或主图提示词。");
      return;
    }
    setError(null);
    setMasterImage({ src: null, isLoading: true });
    
    try {
        const result = await generateMasterImage(processedImages, consistentPrompt, variablePrompts[0].prompt);
        setMasterImage({ src: result, isLoading: false });
        setMasterPromptStale(false);
    } catch (e: any) {
        setError(e.message || "主图生成失败。");
        setMasterImage({ src: null, isLoading: false });
    }
  };

  const handleModifyMaster = async () => {
    const processedImages = getProcessedImages();
    if (!processedImages || processedImages.length === 0 || !masterImage.src || !modificationPrompt) {
        setError("无法修改，缺少参考图、主图或修改指令。");
        return;
    }
    setError(null);
    setMasterImage(prev => ({ ...prev, isLoading: true }));
    try {
        const result = await modifyMasterImage(processedImages, masterImage.src, consistentPrompt, variablePrompts[0].prompt, modificationPrompt);
        setMasterImage({ src: result, isLoading: false });
        setModificationPrompt('');
    } catch (e: any) {
        setError(e.message || "主图修改失败。");
        setMasterImage(prev => ({ ...prev, isLoading: false }));
    }
  };
  
  const handleGenerateAll = async () => {
    const processedImages = getProcessedImages();
    if (!processedImages || processedImages.length === 0 || !masterImage.src) {
        setError("请先生成并确认主图，才能生成系列图片。");
        return;
    }
    setError(null);
    
    const imagePromises = variablePrompts.map(vp => 
        generateSingleFromMaster(processedImages, masterImage.src!, consistentPrompt, vp.prompt, false, vp.referenceImages?.[0]?.file)
        .then(imageSrc => ({ id: vp.id, src: imageSrc, error: null }))
        .catch(error => ({ id: vp.id, src: null, error }))
    );

    const initialStates = variablePrompts.reduce((acc, vp) => {
        acc[vp.id] = { src: null, isLoading: true };
        return acc;
    }, {} as GeneratedImageState);
    setGeneratedImages(initialStates);

    for (const promise of imagePromises) {
        const result = await promise;
        setGeneratedImages(prev => ({
            ...prev,
            [result.id]: { src: result.src, isLoading: false }
        }));
        if(result.error) {
            setError(`部分图片生成失败。`);
            console.error(`Failed to generate image for prompt ${result.id}:`, result.error);
        }
    }
  };

  const handleRegenerateSingle = async (promptId: string) => {
    const processedImages = getProcessedImages();
    if (!processedImages || processedImages.length === 0 || !masterImage.src) {
      setError("请先生成并确认主图。");
      return;
    }
    setError(null);
    setGeneratedImages(prev => ({...prev, [promptId]: { src: prev[promptId]?.src || null, isLoading: true }}));
    
    const promptToRegenerate = variablePrompts.find(p => p.id === promptId);
    if (!promptToRegenerate) return;

    try {
        const imageSrc = await generateSingleFromMaster(processedImages, masterImage.src, consistentPrompt, promptToRegenerate.prompt, true, promptToRegenerate.referenceImages?.[0]?.file);
        setGeneratedImages(prev => ({...prev, [promptId]: { src: imageSrc, isLoading: false }}));
    } catch(e: any) {
        setError(e.message || `图片 ${promptId} 重新生成失败。`);
        setGeneratedImages(prev => ({...prev, [promptId]: { src: prev[promptId]?.src || null, isLoading: false }}));
    }
  };
  
  const downloadImage = (src: string, filename: string) => {
    const link = document.createElement('a');
    link.href = src;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  
  const openKbModal = (idOrType: 'consistent' | string) => {
    setEditingField(idOrType);
    setIsKbModalOpen(true);
  };

  const tokenize = (text: string) => {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
    );
  };

  const calculateSimilarity = (text1: string, text2: string) => {
    const set1 = tokenize(text1);
    const set2 = tokenize(text2);
    if (set1.size === 0 || set2.size === 0) return 0;

    let intersection = 0;
    set1.forEach(token => {
      if (set2.has(token)) intersection++;
    });

    const union = set1.size + set2.size - intersection;
    return union === 0 ? 0 : intersection / union;
  };

  const pickEntryTextForField = (entry: KnowledgeBaseEntry, field: 'consistent' | 'variable') => {
    if (entry.fullPrompt && entry.category === KnowledgeBaseCategory.FULL_PROMPT) {
      const content = field === 'consistent' ? entry.fullPrompt.consistentPrompt : entry.fullPrompt.variablePrompt;
      if (content && content.trim()) return content.trim();
      return `${entry.fullPrompt.consistentPrompt || ''}\n${entry.fullPrompt.variablePrompt || ''}`.trim() || entry.promptFragment;
    }
    return entry.promptFragment;
  };

  const buildRecommendations = (fieldKey: string, currentText: string): string[] => {
    const context = currentText.trim();
    const activeEntries = kbCache.filter(e => !e.deletedAt);
    const maxUsage = Math.max(...activeEntries.map(e => e.usageCount || 0), 1);

    const scored = activeEntries
      .map(entry => {
        let entryText = entry.promptFragment;
        if (entry.fullPrompt) {
          entryText += ` ${entry.fullPrompt.consistentPrompt} ${entry.fullPrompt.variablePrompt}`;
        }
        const usageScore = (entry.usageCount || 0) / maxUsage;
        const relevanceScore = context ? calculateSimilarity(context, entryText) : 0;
        const finalScore = (usageScore * 0.4) + (relevanceScore * 0.6);
        return { entry, finalScore };
      })
      .sort((a, b) => b.finalScore - a.finalScore);

    const fieldType: 'consistent' | 'variable' = fieldKey === 'consistent' ? 'consistent' : 'variable';

    const unique = new Set<string>();
    const options: string[] = [];
    for (const item of scored) {
      const text = pickEntryTextForField(item.entry, fieldType).trim();
      if (!text) continue;
      const key = text.replace(/\s+/g, ' ').slice(0, 180);
      if (unique.has(key)) continue;
      unique.add(key);
      options.push(text);
      if (options.length >= 5) break;
    }

    const fallbackBase = context || (fieldType === 'consistent' ? '写一段高度一致的母版描述，包含主体、服装、场景、光影与风格。' : '写一条清晰的镜头指令，包含景别、构图、动作与焦点。');
    const fallback = [
      fallbackBase,
      `${fallbackBase}\n高细节，真实质感，商业摄影风格。`,
      `${fallbackBase}\n明确镜头焦段、景深与光源方向，保持主体一致。`,
      `${fallbackBase}\n强调材质纹理、光影层次与色彩倾向。`,
      `${fallbackBase}\n干净背景或可控场景，避免无关元素。`
    ];

    for (const text of fallback) {
      if (options.length >= 3) break;
      const key = text.replace(/\s+/g, ' ').slice(0, 180);
      if (unique.has(key)) continue;
      unique.add(key);
      options.push(text);
    }

    return options.slice(0, Math.min(Math.max(options.length, 3), 5));
  };

  const getFieldText = (fieldKey: string) => {
    if (fieldKey === 'consistent') return consistentPrompt;
    return variablePrompts.find(p => p.id === fieldKey)?.prompt || '';
  };

  const setFieldText = (fieldKey: string, value: string) => {
    if (fieldKey === 'consistent') {
      setConsistentPrompt(value);
      return;
    }
    setVariablePrompts(prev => prev.map(p => (p.id === fieldKey ? { ...p, prompt: value } : p)));
  };

  const handleGetInspiration = (fieldKey: string) => {
    const start = performance.now();
    const currentText = getFieldText(fieldKey);
    const options = buildRecommendations(fieldKey, currentText);

    setCopyRecommendations(prev => ({ ...prev, [fieldKey]: options }));
    setAutoFillBackups(prev => (fieldKey in prev ? prev : { ...prev, [fieldKey]: currentText }));
    setFieldText(fieldKey, options[0] || currentText);

    logOperation('copy_autofill', {
      fieldKey,
      optionCount: options.length,
      kbCacheCount: kbCache.length,
      elapsedMs: Math.round(performance.now() - start)
    });
  };

  const handleUndoAutoFill = (fieldKey: string) => {
    const backup = autoFillBackups[fieldKey];
    if (backup === undefined) return;
    setFieldText(fieldKey, backup);
    setAutoFillBackups(prev => {
      const next = { ...prev };
      delete next[fieldKey];
      return next;
    });
    logOperation('copy_autofill_undo', { fieldKey });
  };

  const handleApplyRecommendation = (fieldKey: string, text: string) => {
    const currentText = getFieldText(fieldKey);
    setAutoFillBackups(prev => (fieldKey in prev ? prev : { ...prev, [fieldKey]: currentText }));
    setFieldText(fieldKey, text);
    logOperation('copy_recommendation_apply', { fieldKey, length: text.length });
  };

  const handleSelectKbEntry = async (entry: KnowledgeBaseEntry) => {
    try {
        await incrementEntryUsage(entry.id);
    } catch (error) {
        console.error("Failed to increment usage count", error);
        // Continue selection even if tracking fails
    }
    
    if (entry.fullPrompt && entry.category === KnowledgeBaseCategory.FULL_PROMPT) {
        // For FULL_PROMPT, replace the consistent and the FIRST variable prompt.
        setConsistentPrompt(entry.fullPrompt.consistentPrompt);
        setVariablePrompts(prev => prev.map((p, index) => 
            index === 0 ? { ...p, prompt: entry.fullPrompt.variablePrompt } : p
        ));
    } else {
        // For fragments, APPEND the text.
        const textToAppend = ` ${entry.promptFragment}`; // Add a leading space for separation.
        if (editingField === 'consistent') {
            setConsistentPrompt(prev => prev.trim() + textToAppend);
        } else if (typeof editingField === 'string') {
            setVariablePrompts(prev => prev.map(p => 
                p.id === editingField ? { ...p, prompt: p.prompt.trim() + textToAppend } : p
            ));
        }
    }
    setIsKbModalOpen(false);
    setEditingField(null);
  };
  
  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
        const fileArray: File[] = Array.from(e.target.files);
        const imageFiles = fileArray.map(file => ({ file, preview: URL.createObjectURL(file) }));
        handleFileSelect(imageFiles);
    }
  };

  const kbContextPrompt = editingField === 'consistent' 
      ? consistentPrompt 
      : (typeof editingField === 'string' ? variablePrompts.find(p => p.id === editingField)?.prompt : undefined);

  return (
    <div>
        {enlargedImage && <ImageModal src={enlargedImage} onClose={() => setEnlargedImage(null)} />}
        {isKbModalOpen && (
            <KnowledgeBaseModal 
                onClose={() => setIsKbModalOpen(false)} 
                onSelectEntry={handleSelectKbEntry} 
                currentContextPrompt={kbContextPrompt}
            />
        )}
        <div className="grid lg:grid-cols-2 gap-8">
        {/* Left Column: Inputs */}
        <div className="flex flex-col gap-8">
              <div>
                <h3 className="text-xl font-bold text-white mb-3 flex items-center gap-2">
                    <span className="bg-fuchsia-500 w-8 h-8 rounded-full flex items-center justify-center text-sm">1</span>
                    参考图 (支持多张)
                </h3>
                <p className="text-slate-400 mb-4 text-sm">上传一张或多张清晰的图片作为主角。</p>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                    {referenceImages.map((img) => (
                         <div 
                            key={img.id} 
                            className="relative group aspect-square bg-slate-800 rounded-2xl overflow-hidden flex items-center justify-center border border-white/5 shadow-inner cursor-pointer"
                            onClick={() => setEnlargedImage(img.originalPreview)}
                         >
                            {img.isProcessing && <LoadingSpinner text=""/>}
                            {!img.isProcessing && img.processedPreview && (
                                <img src={img.processedPreview} alt="Reference" className="w-full h-full object-cover" />
                            )}
                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                <div className="p-2 bg-white/20 rounded-full text-white hover:bg-white/40 backdrop-blur-sm transition-colors"><EyeIcon className="w-4 h-4"/></div>
                                <button 
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleDeleteReferenceImage(img.id);
                                    }} 
                                    className="p-2 bg-red-500/20 rounded-full text-red-400 hover:bg-red-500/80 hover:text-white backdrop-blur-sm transition-colors" title="删除图片"
                                >
                                    <TrashIcon className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    ))}
                    {referenceImages.length < MAX_REF_IMAGES && (
                        <div 
                            onClick={() => fileInputRef.current?.click()}
                            className="aspect-square border-2 border-dashed border-slate-600 rounded-2xl flex flex-col items-center justify-center text-center text-slate-500 hover:border-fuchsia-400 hover:text-fuchsia-400 hover:bg-slate-800/50 cursor-pointer transition-all duration-300"
                        >
                            <PlusIcon className="w-6 h-6 mb-1"/>
                            <span className="text-xs font-bold">添加图片</span>
                        </div>
                    )}
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept="image/*"
                        onChange={onFileInputChange}
                        className="hidden"
                    />
                </div>

                {referenceImages.length > 0 && (
                    <button
                        onClick={handleStartAnalysis}
                        disabled={isAnalyzing}
                        className="mt-4 w-full py-3 bg-gradient-to-r from-fuchsia-600 to-purple-600 hover:from-fuchsia-500 hover:to-purple-500 text-white font-bold rounded-xl shadow-lg shadow-fuchsia-500/30 transition-all transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {isAnalyzing ? (
                            <>
                                <LoadingSpinner text="" />
                                <span>正在处理与分析...</span>
                            </>
                        ) : (
                            <>
                                <MagicWandIcon className="w-5 h-5" />
                                <span>开始图片理解 (Step 1)</span>
                            </>
                        )}
                    </button>
                )}
              </div>
              
              <div>
                 <div className="flex justify-between items-center mb-3">
                    <h3 className="text-xl font-bold text-white flex items-center gap-2">
                        <span className="bg-violet-500 w-8 h-8 rounded-full flex items-center justify-center text-sm">2</span>
                        一致性内容
                    </h3>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleGetInspiration('consistent')}
                        className="px-3 py-1.5 text-fuchsia-300 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 rounded-full transition-colors flex items-center gap-1.5 text-sm font-semibold border border-fuchsia-500/20"
                        title="智能推荐并自动填充"
                      >
                        <MagicWandIcon className="w-4 h-4" />
                        获取灵感
                      </button>
                      <button
                        onClick={() => openKbModal('consistent')}
                        className="px-3 py-1.5 text-slate-300 bg-slate-800/70 hover:bg-slate-700 rounded-full transition-colors flex items-center gap-1.5 text-sm font-semibold border border-slate-700"
                        title="从知识库选择"
                      >
                        <BookOpenIcon className="w-4 h-4" />
                        知识库
                      </button>
                    </div>
                </div>
                <textarea
                  ref={consistentTextareaRef}
                  value={consistentPrompt}
                  onChange={handleConsistentPromptChange}
                  rows={5}
                  className="w-full p-4 bg-slate-800/50 border border-slate-600 rounded-2xl focus:ring-2 focus:ring-fuchsia-500 focus:border-transparent transition-all text-slate-200 placeholder-slate-500 resize-y shadow-inner"
                  placeholder="例如：一名19岁的女大学生，穿着白色超大T恤和浅蓝色宽松牛仔裤..."
                />
                {copyRecommendations['consistent'] && copyRecommendations['consistent'].length > 0 && (
                  <div className="mt-3 p-4 bg-slate-900/40 border border-white/5 rounded-2xl shadow-inner">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-semibold text-slate-400">智能推荐 (3-5)</span>
                      {autoFillBackups['consistent'] !== undefined && (
                        <button
                          onClick={() => handleUndoAutoFill('consistent')}
                          className="text-xs font-bold text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-1.5 rounded-full border border-amber-500/20 transition-colors"
                        >
                          撤销自动填充
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {copyRecommendations['consistent'].map((opt, i) => (
                        <button
                          key={`${i}-${opt.slice(0, 24)}`}
                          onClick={() => handleApplyRecommendation('consistent', opt)}
                          className="text-xs bg-slate-800 border border-slate-700 hover:border-fuchsia-500 text-slate-300 hover:text-white px-3 py-2 rounded-xl transition max-w-full text-left"
                          title={opt}
                        >
                          {opt.length > 42 ? `${opt.slice(0, 42)}...` : opt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-xl font-bold text-white mb-3 flex items-center gap-2">
                    <span className="bg-blue-500 w-8 h-8 rounded-full flex items-center justify-center text-sm">3</span>
                    非一致性内容 (单张定义)
                </h3>
                <div className="space-y-5">
                  {variablePrompts.map((vp, index) => {
                    const hasImages = Boolean(vp.referenceImages && vp.referenceImages.length > 0);
                    const mergedFragments = mergeVariablePromptFragments(vp);
                    const hasFragments = Object.keys(mergedFragments).length > 0;

                    return (
                    <div key={vp.id} className="bg-slate-800/40 border border-white/5 p-4 rounded-2xl shadow-lg backdrop-blur-sm hover:border-white/10 transition-colors">
                      <div className="flex items-center justify-between mb-2">
                         <span className="text-sm font-bold text-fuchsia-400 uppercase tracking-wider">图片 #{index + 1}</span>
                         <div className="flex space-x-1">
                            <button onClick={() => handleGetInspiration(vp.id)} className="p-2 text-slate-400 hover:text-fuchsia-400 hover:bg-white/5 rounded-full transition-colors" title="智能推荐并自动填充">
                                <MagicWandIcon className="w-4 h-4" />
                            </button>
                            <button onClick={() => openKbModal(vp.id)} className="p-2 text-slate-400 hover:text-slate-200 hover:bg-white/5 rounded-full transition-colors" title="从知识库选择">
                                <BookOpenIcon className="w-4 h-4" />
                            </button>
                            <button onClick={() => removeVariablePrompt(vp.id)} disabled={variablePrompts.length <= 1} className="p-2 text-slate-400 hover:text-red-400 hover:bg-white/5 rounded-full disabled:opacity-30 transition-colors" title="删除此提示">
                                <TrashIcon className="w-4 h-4" />
                            </button>
                         </div>
                      </div>
                      <textarea
                        value={vp.prompt}
                        onChange={(e) => handleVariablePromptChange(vp.id, e.target.value)}
                        rows={3}
                        className="w-full p-3 bg-slate-900/50 border border-slate-700 rounded-xl focus:ring-2 focus:ring-fuchsia-500 focus:border-transparent transition text-slate-300 placeholder-slate-600 mb-3"
                        placeholder={index === 0 ? '主图的提示词：全身照，站在镜子前...' : '例如：鞋子特写，无人物...'}
                      />
                      {copyRecommendations[vp.id] && copyRecommendations[vp.id].length > 0 && (
                        <div className="mb-3 p-3 bg-slate-900/40 border border-white/5 rounded-2xl shadow-inner">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[11px] font-semibold text-slate-400">智能推荐 (3-5)</span>
                            {autoFillBackups[vp.id] !== undefined && (
                              <button
                                onClick={() => handleUndoAutoFill(vp.id)}
                                className="text-[11px] font-bold text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 px-2.5 py-1 rounded-full border border-amber-500/20 transition-colors"
                              >
                                撤销自动填充
                              </button>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {copyRecommendations[vp.id].map((opt, i) => (
                              <button
                                key={`${i}-${opt.slice(0, 24)}`}
                                onClick={() => handleApplyRecommendation(vp.id, opt)}
                                className="text-[11px] bg-slate-800 border border-slate-700 hover:border-fuchsia-500 text-slate-300 hover:text-white px-2.5 py-2 rounded-xl transition max-w-full text-left"
                                title={opt}
                              >
                                {opt.length > 42 ? `${opt.slice(0, 42)}...` : opt}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {/* Image Upload Area */}
                      <div className="mb-3">
                        <div className="relative group">
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            id={`file-${vp.id}`}
                            onChange={(e) => {
                              const files = e.target.files ? (Array.from(e.target.files) as File[]) : [];
                              if (files.length > 0) handleVariableImageUpload(vp.id, files);
                              e.currentTarget.value = '';
                            }}
                          />

                          {!hasImages ? (
                            <label
                              htmlFor={`file-${vp.id}`}
                              className="flex items-center justify-center w-full p-3 border-2 border-dashed border-slate-700 rounded-xl text-slate-500 hover:border-fuchsia-500 hover:text-fuchsia-400 cursor-pointer transition-colors text-sm font-bold gap-2"
                            >
                              <PlusIcon className="w-4 h-4" />
                              <span>上传参考图（可多张）</span>
                            </label>
                          ) : (
                            <div className="bg-slate-900/50 rounded-xl p-3 border border-slate-700">
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-xs text-slate-400 truncate">
                                  参考图已上传：{vp.referenceImages?.length || 0} 张
                                </span>
                                <div className="flex gap-1 flex-shrink-0">
                                  <button
                                    onClick={() => handleSaveVariableToKB(vp.id)}
                                    disabled={!hasFragments}
                                    className="text-xs bg-fuchsia-500/20 text-fuchsia-300 px-2 py-1 rounded hover:bg-fuchsia-500/40 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                    title="保存到知识库"
                                  >
                                    保存KB
                                  </button>
                                  <button
                                    onClick={() => handleDeleteVariableImage(vp.id)}
                                    className="text-xs bg-red-500/20 text-red-300 px-2 py-1 rounded hover:bg-red-500/40 transition"
                                    title="删除图片"
                                  >
                                    删除
                                  </button>
                                </div>
                              </div>

                              <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 mt-3">
                                {(vp.referenceImages || []).map((img) => (
                                  <div
                                    key={img.id}
                                    className="relative aspect-square bg-slate-800 rounded-lg overflow-hidden group"
                                  >
                                    <img src={img.preview} alt="Ref" className="w-full h-full object-cover" />
                                    {vp.isAnalyzing && (
                                      <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                                        <LoadingSpinner text="" />
                                      </div>
                                    )}
                                    <button
                                      onClick={() => handleDeleteVariableImage(vp.id, img.id)}
                                      className="absolute top-1 right-1 p-1 bg-red-500/20 text-red-200 hover:bg-red-500/80 hover:text-white rounded-full backdrop-blur-sm transition-colors"
                                      title="删除此图"
                                      type="button"
                                    >
                                      <TrashIcon className="w-3 h-3" />
                                    </button>
                                  </div>
                                ))}

                                <label
                                  htmlFor={`file-${vp.id}`}
                                  className="aspect-square border-2 border-dashed border-slate-700 rounded-lg flex flex-col items-center justify-center text-slate-500 hover:border-fuchsia-500 hover:text-fuchsia-400 cursor-pointer transition-colors text-xs font-bold gap-1"
                                >
                                  <PlusIcon className="w-4 h-4" />
                                  添加
                                </label>
                              </div>

                              {hasFragments && (
                                <div className="flex flex-wrap gap-1 mt-3 max-h-28 overflow-y-auto">
                                  {Object.entries(mergedFragments).map(([key, value]) => (
                                    <button
                                      key={key}
                                      onClick={() => handleVariablePromptChange(vp.id, vp.prompt + (vp.prompt ? ' ' : '') + value)}
                                      className="text-[10px] bg-slate-800 border border-slate-600 hover:border-fuchsia-500 text-slate-300 hover:text-white px-2 py-0.5 rounded-full transition truncate max-w-full text-left"
                                      title={value}
                                      type="button"
                                    >
                                      {key}: {value.substring(0, 10)}...
                                    </button>
                                  ))}
                                </div>
                              )}

                              {!hasFragments && !vp.isAnalyzing && (
                                <button
                                  onClick={() => handleAnalyzeVariableImages(vp.id)}
                                  className="text-xs text-fuchsia-400 underline mt-2 text-left"
                                  type="button"
                                >
                                  重新解析
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      
                      <div className="mt-3 flex justify-end">
                           <button 
                             onClick={() => handleRegenerateSingle(vp.id)}
                             className="bg-slate-700 hover:bg-fuchsia-600 text-white text-xs font-bold py-2 px-4 rounded-full flex items-center gap-2 transition-all shadow-md hover:shadow-fuchsia-500/40 group"
                             title="立即生成此图片"
                           >
                               <PlayIcon className="w-3 h-3 group-hover:scale-110 transition-transform" />
                               生成此图
                           </button>
                      </div>
                    </div>
                    );
                  })}
                </div>
                <button onClick={addVariablePrompt} className="mt-6 w-full py-3 border-2 border-dashed border-slate-600 rounded-2xl flex items-center justify-center space-x-2 text-slate-400 hover:text-fuchsia-400 hover:border-fuchsia-400 hover:bg-slate-800/50 font-bold transition-all">
                  <PlusIcon className="w-5 h-5" />
                  <span>添加另一个画面</span>
                </button>
            </div>
        </div>
        
        {/* Right Column: Results */}
        <div className="bg-slate-800/30 backdrop-blur-md rounded-3xl p-6 border border-white/5 min-h-[400px] flex flex-col gap-8">
            {/* Master Image Module */}
            <div>
                 <div className="flex items-center justify-between mb-4">
                     <h3 className="text-xl font-bold text-white">主图 (视觉基准)</h3>
                     <span className="text-xs bg-fuchsia-500/20 text-fuchsia-300 px-2 py-1 rounded-full border border-fuchsia-500/30">Step 1</span>
                 </div>
                 
                 <div 
                    className="aspect-[3/4] bg-slate-900/80 rounded-2xl flex items-center justify-center relative group text-slate-500 border border-slate-700 overflow-hidden shadow-inner cursor-pointer"
                    onClick={() => masterImage.src && setEnlargedImage(masterImage.src)}
                 >
                    {masterImage.isLoading && <LoadingSpinner text="主图生成中..."/>}
                    {!masterImage.isLoading && masterImage.src && (
                         <>
                            <img src={masterImage.src} alt="Master visual" className="w-full h-full object-cover"/>
                            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-all backdrop-blur-sm flex items-center justify-center gap-4">
                               <div className="p-3 bg-white/10 hover:bg-fuchsia-500 text-white rounded-full backdrop-blur-md transition-all transform hover:scale-110" title="放大查看"><ZoomInIcon className="w-6 h-6"/></div>
                               <button 
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        downloadImage(masterImage.src!, 'master_image.png');
                                    }}
                                    className="p-3 bg-white/10 hover:bg-blue-500 text-white rounded-full backdrop-blur-md transition-all transform hover:scale-110" title="下载此图片"><DownloadIcon className="w-6 h-6"/></button>
                               <button 
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleGenerateMaster(true);
                                    }}
                                    className="p-3 bg-white/10 hover:bg-green-500 text-white rounded-full backdrop-blur-md transition-all transform hover:scale-110" title="重新生成"><RefreshIcon className="w-6 h-6"/></button>
                           </div>
                         </>
                    )}
                    {!masterImage.isLoading && !masterImage.src && (
                        <div className="text-center p-8">
                            <div className="w-16 h-16 bg-slate-800 rounded-full mx-auto mb-3 flex items-center justify-center">
                                <MagicWandIcon className="w-8 h-8 text-slate-600" />
                            </div>
                            <p>您的主图将显示在此处。</p>
                        </div>
                    )}
                 </div>
                 
                 <div className="mt-4 flex gap-2">
                    <button onClick={() => handleGenerateMaster(false)} disabled={masterImage.isLoading || referenceImages.some(i => i.isProcessing) || referenceImages.length === 0 || (!variablePrompts[0]?.prompt && !consistentPrompt)} className={`flex-grow font-bold py-3 px-6 rounded-xl transition-all shadow-lg transform active:scale-95 ${masterPromptStale ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-amber-500/30' : 'bg-gradient-to-r from-fuchsia-600 to-purple-600 hover:from-fuchsia-500 hover:to-purple-500 text-white shadow-fuchsia-500/30'} disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none`}>
                        {masterImage.isLoading ? '处理中...' : (masterImage.src ? (masterPromptStale ? '更新主图' : '重新生成主图') : '生成主图')}
                    </button>
                 </div>

                 {masterImage.src && (
                     <div className="mt-3 bg-slate-900/50 p-2 rounded-xl border border-slate-700 flex items-center gap-2">
                        <input type="text" value={modificationPrompt} onChange={e => setModificationPrompt(e.target.value)} placeholder="输入修改指令，例如：把地毯换成木地板" className="flex-grow p-2 bg-transparent border-none text-sm text-white focus:ring-0 placeholder-slate-500"/>
                        <button onClick={handleModifyMaster} disabled={masterImage.isLoading} className="bg-blue-600 text-white text-xs font-bold py-2 px-4 rounded-lg hover:bg-blue-500 transition-colors shadow-md disabled:opacity-50">修改</button>
                    </div>
                 )}
            </div>
            
            <div className="border-t border-white/10 my-2"></div>

            {/* Batch Images Module */}
            <div>
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold text-white">系列图片</h3>
                    <button onClick={handleGenerateAll} disabled={!masterImage.src || referenceImages.some(i => i.isProcessing)} className="bg-emerald-600 text-white text-sm font-bold py-2 px-4 rounded-full hover:bg-emerald-500 hover:shadow-lg hover:shadow-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-95">
                       生成所有图片
                    </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  {variablePrompts.map(({ id }, idx) => {
                      const image = generatedImages[id];
                      // Even if not generated yet, show a placeholder to indicate position
                      const showPlaceholder = !image || (!image.isLoading && !image.src);

                      return (
                          <div 
                            key={id} 
                            className="bg-slate-900/50 rounded-2xl overflow-hidden aspect-[3/4] flex items-center justify-center group relative border border-slate-700/50 shadow-sm cursor-pointer"
                            onClick={() => image?.src && setEnlargedImage(image.src)}
                          >
                              
                              {image?.isLoading && <LoadingSpinner text="" />}
                              
                              {image && !image.isLoading && image.src && (
                                  <>
                                    <img src={image.src} alt={`Generated for prompt ${id}`} className="w-full h-full object-cover"/>
                                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-all backdrop-blur-sm flex items-center justify-center gap-2 md:gap-3">
                                        <div className="p-2 bg-white/10 hover:bg-fuchsia-500 text-white rounded-full backdrop-blur-md transition-all transform hover:scale-110" title="放大"><ZoomInIcon className="w-4 h-4 md:w-5 md:h-5"/></div>
                                        <button 
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                downloadImage(image.src!, `series_image_${id.substring(0,6)}.png`);
                                            }}
                                            className="p-2 bg-white/10 hover:bg-blue-500 text-white rounded-full backdrop-blur-md transition-all transform hover:scale-110" title="下载"><DownloadIcon className="w-4 h-4 md:w-5 md:h-5"/></button>
                                        <button 
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleRegenerateSingle(id);
                                            }}
                                            className="p-2 bg-white/10 hover:bg-green-500 text-white rounded-full backdrop-blur-md transition-all transform hover:scale-110" title="重生成"><RefreshIcon className="w-4 h-4 md:w-5 md:h-5"/></button>
                                    </div>
                                  </>
                              )}
                              
                              {showPlaceholder && !image?.isLoading && (
                                <div className="flex flex-col items-center justify-center text-slate-600">
                                    <span className="text-2xl font-bold opacity-20">#{idx + 1}</span>
                                    <span className="text-xs mt-1 opacity-50">待生成</span>
                                </div>
                               )}
                          </div>
                      )
                  })}
              </div>
            </div>
             {error && <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 mt-4 text-center text-sm">{error}</div>}
        </div>
      </div>
    </div>
  );
};
