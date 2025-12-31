import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AnalysisResult, VariablePrompt, GeneratedImageState, ReferenceImageFile } from '../types';
import { MagicWandIcon, PlusIcon, TrashIcon, DownloadIcon, ZoomInIcon, PlayIcon, CheckIcon, LoadingSpinner, UploadIcon } from './IconComponents';
import { generateSingleFromMaster, analyzeImages, generateWorkbenchImage, urlToBase64, fileToBase64, parseImageUnderstandingPrompt, runVisionAnalysis, analyzeAndCategorizeImageForKB } from '../services/replicateService';
import { ImageModal } from './ImageModal';

// Simple UUID generator polyfill
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

const MAX_PRODUCT_DETAIL_IMAGES = 6;

const VARIABLE_PROMPT_TERM_CATEGORIES: Array<{
  id: string;
  label: string;
  items: Array<{ cn: string; en: string }>;
}> = [
  {
    id: 'camera_angles',
    label: '拍摄角度',
    items: [
      { cn: '平视', en: 'Eye-Level' },
      { cn: '仰视', en: 'Low Angle' },
      { cn: '俯视', en: 'High Angle' },
      { cn: '上帝视角/顶视', en: "Bird's Eye View / Top-Down" },
      { cn: '虫视/极低', en: "Worm's Eye View" },
      { cn: '荷兰角', en: 'Dutch Angle' },
      { cn: '第一人称', en: 'POV (Point of View)' },
      { cn: '过肩镜头', en: 'Over-the-Shoulder' },
      { cn: '侧颜', en: 'Side Profile' },
      { cn: '背影', en: 'Back View' },
      { cn: '自底向上透视', en: 'Bottom-up perspective' },
      { cn: '地面视角', en: 'Ground level shot' }
    ]
  },
  {
    id: 'shot_types',
    label: '景别裁切',
    items: [
      { cn: '极特写', en: 'Extreme Close-Up (ECU)' },
      { cn: '特写', en: 'Close-Up (CU)' },
      { cn: '中景', en: 'Medium Shot (MS)' },
      { cn: '七分身（美式镜头）', en: 'Cowboy Shot' },
      { cn: '全身/广角', en: 'Full Body / Wide Shot' },
      { cn: '远景/大远景', en: 'Long Shot / Extreme Long' },
      { cn: '美式镜头（膝盖以上）', en: 'American Shot' }
    ]
  },
  {
    id: 'body_framing',
    label: '局部特写',
    items: [
      { cn: '膝盖以下', en: 'Knees down shot' },
      { cn: '腰部以下', en: 'Waist down shot' },
      { cn: '低位截取', en: 'Low section' },
      { cn: '仅腿部', en: 'Legs only' },
      { cn: '中段特写', en: 'Midsection shot' },
      { cn: '躯干特写', en: 'Torso shot' },
      { cn: '臀/胯部特写', en: 'Hip shot / Hip level' },
      { cn: '膝处裁切', en: 'Cropped at knees' },
      { cn: '聚焦手部', en: 'Focus on hands' },
      { cn: '肚脐/腹部聚焦', en: 'Navel focus / Belly shot' },
      { cn: '锁骨特写', en: 'Clavicle shot' },
      { cn: '无头照', en: 'Headless shot' },
      { cn: '脖子以下', en: 'Neck down' },
      { cn: '头部出框/被裁', en: 'Cropped head / Head out of frame' },
      { cn: '下巴以下', en: 'Chin down' },
      { cn: '断头构图', en: 'Decapitated framing' }
    ]
  },
  {
    id: 'cinematic',
    label: '电影分镜',
    items: [
      { cn: '插入镜头', en: 'Insert shot' },
      { cn: '物体定场镜头', en: 'Establishing shot of [Object]' },
      { cn: '项圈式特写', en: 'Choker shot' },
      { cn: '腰下侧视', en: 'Profile from waist down' },
      { cn: '腿部平铺', en: 'Flat lay of legs' }
    ]
  },
  {
    id: 'lens_technical',
    label: '镜头参数',
    items: [
      { cn: '微距镜头/微距摄影', en: 'Macro Lens / Macro photography' },
      { cn: '鱼眼镜头', en: 'Fisheye Lens' },
      { cn: '长焦镜头', en: 'Telephoto Lens' },
      { cn: '广角镜头', en: 'Wide Angle Lens' },
      { cn: '景深/虚化', en: 'Bokeh / Depth of Field' }
    ]
  },
  {
    id: 'negative_prompting',
    label: '负向排除',
    items: [
      { cn: '出框', en: 'Out of frame' },
      { cn: '被裁切', en: 'Cropped' },
      { cn: '局部视角', en: 'Partial view' },
      { cn: '无身体（慎用）', en: 'Disembodied' }
    ]
  },
  {
    id: 'quick_combos',
    label: '组合示例',
    items: [
      {
        cn: '鞋与小腿（不见大腿以上）',
        en: 'Low angle, knees down shot, focus on sneakers, ground level shot, shallow depth of field'
      },
      {
        cn: '牛仔裤细节（无头无小腿）',
        en: 'Midsection shot, hip level, fabric texture focus, cropped head, cropped at knees, straight-on view'
      },
      {
        cn: '项链锁骨特写',
        en: 'Extreme close-up on neck and collarbone, chin down, macro photography, soft lighting'
      },
      {
        cn: '仅手与戒指',
        en: 'Focus on hands, insert shot, macro lens, body as background, blurred torso'
      },
      {
        cn: '夸张鞋底透视',
        en: "Worm’s eye view, bottom-up perspective, close-up on footwear, wide angle lens, dynamic composition"
      }
    ]
  }
];

export const GenerationView: React.FC<GenerationViewProps> = ({ initialAnalysisResult }) => {
  // --- STATES ---
  
  // Sidebar: Reference Images (Consistency Sources)
  const [referenceImages, setReferenceImages] = useState<ReferenceImageFile[]>([]);
  const [consistentPrompt, setConsistentPrompt] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGeneratingMaster, setIsGeneratingMaster] = useState(false);

  // Master Image (Input) - Max 1
  const [masterImage, setMasterImage] = useState<{ id: string; file: File | null; preview: string } | null>(null);
  
  // Product Detail Images (Input) - Max 6
  const [productDetailImages, setProductDetailImages] = useState<Array<{ id: string; file: File; preview: string }>>([]);

  // Variable Prompts (Non-consistent content)
  const [variablePrompts, setVariablePrompts] = useState<VariablePrompt[]>([
    { id: uuidv4(), prompt: '', weight: 70 }
  ]);

  // Generated Results
  const [generatedImages, setGeneratedImages] = useState<GeneratedImageState>({});
  
  // UI States
  const [error, setError] = useState<string | null>(null);
  const [enlargedImage, setEnlargedImage] = useState<string | null>(null);
  const [openVariableTermMenu, setOpenVariableTermMenu] = useState<{ promptId: string; categoryId: string } | null>(null);
  const variableTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const openMenuWrapperRef = useRef<HTMLDivElement | null>(null);

  // --- EFFECTS ---

  // Handle Variable Term Menu
  useEffect(() => {
    if (!openVariableTermMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (openMenuWrapperRef.current && !openMenuWrapperRef.current.contains(e.target as Node)) {
        setOpenVariableTermMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenVariableTermMenu(null);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openVariableTermMenu]);

  // --- HANDLERS: SIDEBAR ---

  const handleReferenceImageUpload = (files: File[]) => {
    const newImages = files.map(file => ({
      id: uuidv4(),
      file,
      originalPreview: URL.createObjectURL(file),
      processedPreview: null,
      isProcessing: false
    }));
    
    // Auto-populate Master Image if empty (User Requirement: 主图位置默认添加图片)
    if (!masterImage && newImages.length > 0) {
      setMasterImage({
        id: uuidv4(),
        file: newImages[0].file,
        preview: newImages[0].originalPreview
      });
    }

    setReferenceImages(prev => [...prev, ...newImages]);
  };

  const removeReferenceImage = (id: string) => {
    setReferenceImages(prev => prev.filter(img => img.id !== id));
  };

  const handleAnalyzeReferences = async () => {
    if (referenceImages.length === 0) return;
    setIsAnalyzing(true);
    try {
      // Analyze the first image for now, or multiple if service supports
      const results = await analyzeImages(referenceImages.map(r => r.file));
      // Combine analysis? Just take the first one's understanding for now
      if (results.length > 0 && results[0].analysis) {
        setConsistentPrompt(results[0].analysis);
      }
    } catch (e) {
      console.error("Analysis failed", e);
      setError("图片理解失败");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleGenerateMasterFromReferences = async () => {
    if (referenceImages.length === 0 && !consistentPrompt) {
      setError("请先上传参考图或输入一致性内容描述");
      return;
    }
    setIsGeneratingMaster(true);
    setError(null);
    try {
      const imageUrls = referenceImages.map(r => r.originalPreview); // generateWorkbenchImage handles urlToBase64
      
      const resultUrl = await generateWorkbenchImage(
        consistentPrompt || "High quality commercial photography", 
        imageUrls, 
        "3:4"
      );

      // Convert result URL to a "File-like" object for consistency (or just store URL)
      // Since our masterImage state expects a File object usually, but for generated images we might not have one.
      // Let's adjust masterImage state to allow File to be null if it's generated/url-based.
      setMasterImage({
        id: uuidv4(),
        file: null, // Generated image has no File object initially
        preview: resultUrl
      });
    } catch (e: any) {
      console.error("Master generation failed", e);
      setError("主图生成失败: " + e.message);
    } finally {
      setIsGeneratingMaster(false);
    }
  };

  // --- HANDLERS: MAIN ---

  // Master Image Upload (Manual)
  const handleMasterImageUpload = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const file = files[0];
    setMasterImage({
      id: uuidv4(),
      file,
      preview: URL.createObjectURL(file)
    });
  }, []);

  const handleDeleteMasterImage = () => {
    setMasterImage(null);
  };

  // Product Detail Images Upload
  const handleProductDetailImageUpload = useCallback((files: File[]) => {
    const remaining = MAX_PRODUCT_DETAIL_IMAGES - productDetailImages.length;
    if (remaining <= 0) return;
    
    const newImages = files.slice(0, remaining).map(file => ({
      id: uuidv4(),
      file,
      preview: URL.createObjectURL(file)
    }));
    
    setProductDetailImages(prev => [...prev, ...newImages]);
  }, [productDetailImages.length]);

  const handleDeleteProductDetailImage = (id: string) => {
    setProductDetailImages(prev => prev.filter(img => img.id !== id));
  };

  // Variable Prompt Handlers
  const handleVariablePromptChange = (id: string, value: string) => {
    setVariablePrompts(prev => prev.map(p => p.id === id ? { ...p, prompt: value } : p));
  };

  const handleWeightChange = (id: string, value: number) => {
    setVariablePrompts(prev => prev.map(p => p.id === id ? { ...p, weight: value } : p));
  };

  const handleCharacterConsistencyChange = (id: string, value: number) => {
    setVariablePrompts(prev => prev.map(p => p.id === id ? { ...p, characterConsistency: value } : p));
  };

  const handleSceneConsistencyChange = (id: string, value: number) => {
    setVariablePrompts(prev => prev.map(p => p.id === id ? { ...p, sceneConsistency: value } : p));
  };

  const addVariablePrompt = () => {
    setVariablePrompts(prev => [...prev, { 
      id: uuidv4(), 
      prompt: '', 
      weight: 70,
      characterConsistency: 80,
      sceneConsistency: 20
    }]);
  };

  const removeVariablePrompt = (id: string) => {
    setVariablePrompts(prev => prev.filter(p => p.id !== id));
    setGeneratedImages(prev => {
        const newState = {...prev};
        delete newState[id];
        return newState;
    });
  };

  // Variable Reference Images (Per prompt)
  const handleVariableReferenceImageUpload = (promptId: string, files: File[]) => {
    const newImages = files.map(file => ({
      id: uuidv4(),
      file,
      preview: URL.createObjectURL(file)
    }));
    setVariablePrompts(prev => prev.map(p => 
      p.id === promptId ? { ...p, referenceImages: [...(p.referenceImages || []), ...newImages] } : p
    ));
  };

  const handleDeleteVariableReferenceImage = (promptId: string, imageId: string) => {
    setVariablePrompts(prev => prev.map(p => 
      p.id === promptId ? {
        ...p,
        referenceImages: (p.referenceImages || []).filter(img => img.id !== imageId)
      } : p
    ));
  };

  const handleDownloadImage = async (url: string, filename: string) => {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error('Download failed:', error);
      // Fallback to direct link if fetch fails (e.g. CORS)
      window.open(url, '_blank');
    }
  };

  // Generation Logic
  const handleGenerate = async (promptId: string, isRegeneration = false) => {
    const vp = variablePrompts.find(p => p.id === promptId);
    if (!vp) return;

    // Condition Check
    if (!masterImage) {
      setError("请上传主图 (Master Image)。");
      return;
    }
    if (productDetailImages.length === 0) {
      setError("请至少上传一张产品细节图 (Product Detail Image)。");
      return;
    }
    
    setError(null);
    setGeneratedImages(prev => ({ ...prev, [promptId]: { ...prev[promptId], isLoading: true, error: null } }));

    try {
      // Prepare Master Image Analysis
      let masterAnalysis = null;
      if (consistentPrompt && consistentPrompt.trim()) {
         masterAnalysis = parseImageUnderstandingPrompt(consistentPrompt);
      } else if (masterImage.file) {
         try {
             // Auto-analyze master image if no consistency prompt
             const analysis = await analyzeAndCategorizeImageForKB(masterImage.file);
             setConsistentPrompt(analysis.holistic_description);
             masterAnalysis = analysis;
         } catch (e) {
             console.warn("Auto-analysis of master image failed", e);
         }
      }

      const resultUrl = await generateSingleFromMaster(
        masterImage.preview, 
        vp.prompt,
        productDetailImages.map(img => img.file),
        (vp.referenceImages || []).map(img => img.file),
        vp.weight ?? 70,
        isRegeneration,
        masterAnalysis,
        vp.characterConsistency ?? 80,
        vp.sceneConsistency ?? 20
      );

      setGeneratedImages(prev => ({
        ...prev,
        [promptId]: {
          isLoading: false,
          src: resultUrl, 
          error: null,
          timestamp: Date.now()
        }
      } as any)); 
    } catch (e: any) {
      console.error(e);
      setGeneratedImages(prev => ({
        ...prev,
        [promptId]: {
          isLoading: false,
          src: null,
          error: e.message || "生成失败",
          timestamp: Date.now()
        }
      } as any));
    }
  };

  // Term Insertion Helpers
  const toggleVariableTermMenu = (promptId: string, categoryId: string) => {
    setOpenVariableTermMenu(prev => {
      if (prev && prev.promptId === promptId && prev.categoryId === categoryId) return null;
      return { promptId, categoryId };
    });
  };

  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const isVariableTermSelected = (promptText: string, term: string) => {
    if (!promptText) return false;
    return promptText.includes(term);
  };

  const removeVariablePromptTerm = (promptText: string, term: string) => {
    const escaped = escapeRegExp(term);
    // Match the term surrounded by separators or start/end of string
    const re = new RegExp(`(^|[\\s,，;；\\n]+)${escaped}(?=([\\s,，;；\\n]+|$))`, 'g');
    // Replace with a single separator if it was preceded by one, otherwise empty
    let next = promptText.replace(re, ' '); 
    // Normalize separators: replace sequence of separators/spaces with ", "
    next = next.replace(/[ \t]*[,，;；\n]+[ \t]*/g, ', ').trim();
    // Remove leading/trailing separators
    next = next.replace(/^[,，\s]+/, '').replace(/[,，\s]+$/, '');
    return next;
  };

  const insertVariablePromptTerm = (promptId: string, term: string) => {
    const currentPrompt = variablePrompts.find(p => p.id === promptId)?.prompt || '';
    const textarea = variableTextareaRefs.current[promptId];
    const start = textarea?.selectionStart ?? currentPrompt.length;
    const end = textarea?.selectionEnd ?? currentPrompt.length;
    const before = currentPrompt.slice(0, start);
    const after = currentPrompt.slice(end);

    const beforeTrimmed = before.replace(/\s+$/, '');
    const afterTrimmed = after.replace(/^\s+/, '');
    // Check if we need a delimiter before (if not empty and not ending in separator)
    const needsDelimiterBefore = beforeTrimmed.length > 0 && !/[，,;；\n]$/.test(beforeTrimmed);
    // Check if we need a delimiter after (if not empty and not starting with separator)
    const needsDelimiterAfter = afterTrimmed.length > 0 && !/^[，,;；\n]/.test(afterTrimmed);

    // Use English comma ", "
    const left = `${beforeTrimmed}${needsDelimiterBefore ? ', ' : ''}`;
    const right = `${needsDelimiterAfter ? ', ' : ''}${afterTrimmed}`;
    const nextPrompt = `${left}${term}${right}`;
    const caretPos = left.length + term.length;

    setVariablePrompts(prev => prev.map(p => (p.id === promptId ? { ...p, prompt: nextPrompt } : p)));

    setTimeout(() => {
      const el = variableTextareaRefs.current[promptId];
      if (el) {
        el.focus();
        el.setSelectionRange(caretPos, caretPos);
      }
    }, 0);
  };

  const toggleVariablePromptTerm = (promptId: string, termCn: string, termEn: string) => {
    const currentPrompt = variablePrompts.find(p => p.id === promptId)?.prompt || '';
    // Check using English term
    const selected = isVariableTermSelected(currentPrompt, termEn);
    if (selected) {
      const next = removeVariablePromptTerm(currentPrompt, termEn);
      setVariablePrompts(prev => prev.map(p => (p.id === promptId ? { ...p, prompt: next } : p)));
    } else {
      insertVariablePromptTerm(promptId, termEn);
    }
  };

  return (
    <div className="flex h-full bg-gray-50 overflow-hidden">
      
      {/* --- SIDEBAR: REFERENCE & CONSISTENCY --- */}
      <div className="w-80 flex-shrink-0 bg-white border-r border-gray-200 overflow-y-auto p-4 flex flex-col gap-6">
        <div>
          <h3 className="text-sm font-bold text-gray-800 mb-2 flex items-center justify-between">
            <span>参考图 (Reference Images)</span>
            <span className="text-xs text-gray-500 font-normal">{referenceImages.length} images</span>
          </h3>
          <div className="grid grid-cols-2 gap-2 mb-2">
            {referenceImages.map(img => (
              <div key={img.id} className="relative aspect-square bg-gray-100 rounded-lg overflow-hidden group border border-gray-200">
                <img src={img.originalPreview} alt="Ref" className="w-full h-full object-cover" />
                <button 
                  onClick={() => removeReferenceImage(img.id)}
                  className="absolute top-1 right-1 p-1 bg-black/50 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <TrashIcon className="w-3 h-3" />
                </button>
              </div>
            ))}
            <label className="aspect-square bg-gray-50 rounded-lg border-2 border-dashed border-gray-200 flex flex-col items-center justify-center cursor-pointer hover:bg-gray-100 transition-colors text-gray-400">
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => e.target.files && handleReferenceImageUpload(Array.from(e.target.files))} />
              <PlusIcon className="w-6 h-6" />
            </label>
          </div>
          <button 
            onClick={handleAnalyzeReferences}
            disabled={isAnalyzing || referenceImages.length === 0}
            className="w-full py-2 bg-indigo-50 text-indigo-600 rounded-lg text-sm font-medium hover:bg-indigo-100 transition-colors disabled:opacity-50"
          >
            {isAnalyzing ? "正在理解..." : "图片理解 (Understanding)"}
          </button>
        </div>

        <div className="flex-1 flex flex-col">
          <h3 className="text-sm font-bold text-gray-800 mb-2">一致性内容 (Consistent Content)</h3>
          <textarea 
            value={consistentPrompt}
            onChange={(e) => setConsistentPrompt(e.target.value)}
            placeholder="此处显示图片理解结果，或手动输入一致性描述..."
            className="flex-1 w-full p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm resize-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        <div className="pt-4 border-t border-gray-100">
          <button 
            onClick={handleGenerateMasterFromReferences}
            disabled={isGeneratingMaster || (referenceImages.length === 0 && !consistentPrompt)}
            className="w-full py-3 bg-gradient-to-r from-gray-900 to-gray-800 text-white rounded-xl shadow-sm hover:from-black hover:to-gray-900 transition-all flex items-center justify-center gap-2"
          >
            {isGeneratingMaster ? <LoadingSpinner className="w-4 h-4 text-white" /> : <MagicWandIcon className="w-4 h-4" />}
            <span>生成主图 (Generate Master)</span>
          </button>
        </div>
      </div>

      {/* --- MAIN CONTENT --- */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8">
        
        {/* Master Image & Product Details Section */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          
          {/* Master Image */}
          <div className="xl:col-span-5 bg-white rounded-xl shadow-sm border border-gray-100 p-5 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <span className="w-1 h-5 bg-black rounded-full"></span>
                主图 (Master Image)
              </h3>
              <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-full">Max 1</span>
            </div>

            <div className="flex-1 min-h-[400px] bg-gray-50 rounded-xl border-2 border-dashed border-gray-200 relative group transition-all hover:border-blue-400 overflow-hidden">
              {masterImage ? (
                <div className="relative w-full h-full">
                  <img 
                    src={masterImage.preview} 
                    alt="Master" 
                    className="w-full h-full object-contain p-2"
                  />
                  <div className="absolute top-2 right-2 flex gap-2">
                    <button 
                      onClick={() => setEnlargedImage(masterImage.preview)}
                      className="p-2 bg-white/90 backdrop-blur shadow-sm rounded-full hover:bg-blue-50 text-blue-600 transition-colors"
                      title="放大查看"
                    >
                      <ZoomInIcon className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={handleDeleteMasterImage}
                      className="p-2 bg-white/90 backdrop-blur shadow-sm rounded-full hover:bg-red-50 text-red-600 transition-colors"
                      title="删除图片"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ) : (
                <label className="absolute inset-0 flex flex-col items-center justify-center cursor-pointer text-gray-400 hover:text-blue-500 hover:bg-blue-50/30 transition-colors">
                  <input 
                    type="file" 
                    accept="image/*" 
                    className="hidden" 
                    onChange={(e) => e.target.files && handleMasterImageUpload(Array.from(e.target.files))}
                  />
                  <div className="w-16 h-16 bg-white rounded-full shadow-sm flex items-center justify-center mb-4">
                    <PlusIcon className="w-8 h-8" />
                  </div>
                  <span className="text-sm font-medium">点击上传主图</span>
                  <span className="text-xs mt-1 opacity-70">支持 JPG, PNG</span>
                </label>
              )}
            </div>
          </div>

          {/* Product Details */}
          <div className="xl:col-span-7 bg-white rounded-xl shadow-sm border border-gray-100 p-5 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <span className="w-1 h-5 bg-indigo-600 rounded-full"></span>
                产品细节图 (Product Details)
              </h3>
              <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
                {productDetailImages.length} / {MAX_PRODUCT_DETAIL_IMAGES}
              </span>
            </div>

            <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 gap-4 content-start">
              {productDetailImages.map((img) => (
                <div key={img.id} className="aspect-square bg-gray-50 rounded-lg border border-gray-200 relative group overflow-hidden">
                  <img 
                    src={img.preview} 
                    alt="Detail" 
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                     <button 
                      onClick={() => setEnlargedImage(img.preview)}
                      className="p-1.5 bg-white/90 backdrop-blur shadow-sm rounded-full hover:bg-blue-50 text-blue-600"
                    >
                      <ZoomInIcon className="w-3 h-3" />
                    </button>
                    <button 
                      onClick={() => handleDeleteProductDetailImage(img.id)}
                      className="p-1.5 bg-white/90 backdrop-blur shadow-sm rounded-full hover:bg-red-50 text-red-600"
                    >
                      <TrashIcon className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
              
              {productDetailImages.length < MAX_PRODUCT_DETAIL_IMAGES && (
                <label className="aspect-square bg-gray-50 rounded-lg border-2 border-dashed border-gray-200 flex flex-col items-center justify-center cursor-pointer text-gray-400 hover:text-indigo-500 hover:border-indigo-300 hover:bg-indigo-50/30 transition-all">
                  <input 
                    type="file" 
                    accept="image/*" 
                    multiple 
                    className="hidden" 
                    onChange={(e) => e.target.files && handleProductDetailImageUpload(Array.from(e.target.files))}
                  />
                  <PlusIcon className="w-6 h-6 mb-2" />
                  <span className="text-xs">添加细节图</span>
                </label>
              )}
            </div>
          </div>
        </div>

        {/* --- NON-CONSISTENT CONTENT GENERATION --- */}
        <div className="space-y-6 pb-12">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <MagicWandIcon className="w-6 h-6 text-purple-600" />
              非一致性内容生成 (Non-Consistent Generation)
            </h2>
            <button 
              onClick={addVariablePrompt}
              className="flex items-center gap-2 px-4 py-2 bg-black text-white rounded-lg hover:bg-gray-800 transition-colors shadow-sm"
            >
              <PlusIcon className="w-4 h-4" />
              <span>新增生成项</span>
            </button>
          </div>

          {variablePrompts.map((vp, index) => (
            <div key={vp.id} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              {/* Header / Toolbar */}
              <div className="bg-gray-50/50 px-6 py-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-purple-100 text-purple-700 text-xs font-bold">
                    {index + 1}
                  </span>
                  <span className="font-medium text-gray-700">生成项 #{index + 1}</span>
                </div>
                
                <div className="flex items-center gap-4 flex-wrap justify-end">
                   {/* Weight Control */}
                  <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-lg border border-gray-200 shadow-sm">
                    <span className="text-xs font-medium text-gray-500">重绘权重</span>
                    <input 
                      type="range" 
                      min="0" 
                      max="100" 
                      value={vp.weight ?? 70} 
                      onChange={(e) => handleWeightChange(vp.id, parseInt(e.target.value))}
                      className="w-20 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-purple-600"
                    />
                    <span className="text-xs font-bold text-purple-600 min-w-[2rem] text-right">
                      {vp.weight ?? 70}%
                    </span>
                  </div>

                  {/* Character Consistency */}
                  <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-lg border border-gray-200 shadow-sm">
                    <span className="text-xs font-medium text-gray-500">人物一致性</span>
                    <input 
                      type="range" 
                      min="0" 
                      max="100" 
                      value={vp.characterConsistency ?? 80} 
                      onChange={(e) => handleCharacterConsistencyChange(vp.id, parseInt(e.target.value))}
                      className="w-20 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-pink-600"
                    />
                    <span className="text-xs font-bold text-pink-600 min-w-[2rem] text-right">
                      {vp.characterConsistency ?? 80}%
                    </span>
                  </div>

                  {/* Scene Consistency */}
                  <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-lg border border-gray-200 shadow-sm">
                    <span className="text-xs font-medium text-gray-500">场景一致性</span>
                    <input 
                      type="range" 
                      min="0" 
                      max="100" 
                      value={vp.sceneConsistency ?? 20} 
                      onChange={(e) => handleSceneConsistencyChange(vp.id, parseInt(e.target.value))}
                      className="w-20 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                    />
                    <span className="text-xs font-bold text-blue-600 min-w-[2rem] text-right">
                      {vp.sceneConsistency ?? 20}%
                    </span>
                  </div>

                  <button 
                    onClick={() => removeVariablePrompt(vp.id)}
                    className="text-gray-400 hover:text-red-500 transition-colors p-1"
                    title="删除此项"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
                {/* Left Column: Prompt & Reference */}
                <div className="lg:col-span-7 space-y-6">
                  
                  {/* Prompt Input */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                       <label className="text-sm font-medium text-gray-700">画面修改提示词 (Prompt)</label>
                       <div className="flex gap-2 relative" ref={openMenuWrapperRef}>
                         {VARIABLE_PROMPT_TERM_CATEGORIES.map(cat => (
                           <div key={cat.id} className="relative">
                              <button
                                  onClick={() => toggleVariableTermMenu(vp.id, cat.id)}
                                  className={`px-2 py-1 text-xs rounded border transition-colors ${
                                      openVariableTermMenu?.promptId === vp.id && openVariableTermMenu?.categoryId === cat.id
                                      ? 'bg-purple-50 border-purple-200 text-purple-700'
                                      : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
                                  }`}
                              >
                                  {cat.label}
                              </button>
                              {openVariableTermMenu?.promptId === vp.id && openVariableTermMenu?.categoryId === cat.id && (
                                  <div className="absolute top-full left-0 mt-1 w-64 max-h-60 overflow-y-auto bg-white rounded-lg shadow-xl border border-gray-100 z-50 p-1 grid grid-cols-1 gap-0.5">
                                      {cat.items.map(item => {
                                          const isSelected = isVariableTermSelected(vp.prompt, item.en);
                                          return (
                                              <button
                                                  key={item.cn}
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggleVariablePromptTerm(vp.id, item.cn, item.en);
                                                  }}
                                                  className={`text-left px-3 py-2 text-xs rounded flex items-center justify-between group ${
                                                      isSelected ? 'bg-purple-50 text-purple-700' : 'hover:bg-gray-50 text-gray-700'
                                                  }`}
                                              >
                                                  <span>{item.cn}</span>
                                                  {isSelected && <CheckIcon className="w-3 h-3" />}
                                              </button>
                                          );
                                      })}
                                  </div>
                              )}
                           </div>
                         ))}
                       </div>
                    </div>
                    <textarea
                      ref={el => variableTextareaRefs.current[vp.id] = el}
                      value={vp.prompt}
                      onChange={(e) => handleVariablePromptChange(vp.id, e.target.value)}
                      placeholder="描述你想如何修改主图 (e.g., 换个背景, 改变姿势, 调整光影)..."
                      className="w-full h-32 p-3 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all resize-none text-sm leading-relaxed"
                    />
                  </div>

                  {/* Reference Images for this prompt */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700">参考图 (作为一致性内容)</label>
                    <div className="flex flex-wrap gap-3">
                      {(vp.referenceImages || []).map(img => (
                        <div key={img.id} className="relative w-16 h-16 rounded-lg overflow-hidden border border-gray-200 group">
                          <img src={img.preview} alt="Ref" className="w-full h-full object-cover" />
                          <button 
                            onClick={() => handleDeleteVariableReferenceImage(vp.id, img.id)}
                            className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-white"
                          >
                            <TrashIcon className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                      <label className="w-16 h-16 rounded-lg border-2 border-dashed border-gray-200 flex items-center justify-center cursor-pointer hover:border-purple-400 hover:bg-purple-50/30 text-gray-400 transition-colors">
                        <input 
                          type="file" 
                          accept="image/*" 
                          multiple 
                          className="hidden"
                          onChange={(e) => e.target.files && handleVariableReferenceImageUpload(vp.id, Array.from(e.target.files))} 
                        />
                        <PlusIcon className="w-5 h-5" />
                      </label>
                    </div>
                  </div>

                  {/* Generate Action */}
                  <div className="pt-2">
                     <button
                      onClick={() => handleGenerate(vp.id)}
                      disabled={generatedImages[vp.id]?.isLoading}
                      className={`w-full py-3 rounded-lg flex items-center justify-center gap-2 font-medium text-white shadow-sm transition-all ${
                          generatedImages[vp.id]?.isLoading 
                          ? 'bg-gray-400 cursor-not-allowed'
                          : 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 hover:shadow-md transform hover:-translate-y-0.5'
                      }`}
                     >
                       {generatedImages[vp.id]?.isLoading ? (
                         <>
                           <LoadingSpinner className="w-5 h-5" />
                           <span>生成中...</span>
                         </>
                       ) : (
                         <>
                           <PlayIcon className="w-5 h-5" />
                           <span>开始生成</span>
                         </>
                       )}
                     </button>
                     {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
                  </div>

                </div>

                {/* Right Column: Result */}
                <div className="lg:col-span-5 border-l border-gray-100 pl-8 flex flex-col justify-center min-h-[400px]">
                  {generatedImages[vp.id] ? (
                      generatedImages[vp.id].src ? (
                          <div className="relative w-full aspect-[3/4] bg-gray-100 rounded-lg overflow-hidden shadow-sm group">
                              <img 
                                  src={generatedImages[vp.id].src!} 
                                  alt="Result" 
                                  className="w-full h-full object-cover"
                              />
                              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-4">
                                  <div className="flex gap-2 justify-end">
                                      <button 
                                          onClick={() => setEnlargedImage(generatedImages[vp.id].src!)}
                                          className="p-2 bg-white/20 backdrop-blur rounded-full text-white hover:bg-white/30 transition-colors"
                                          title="放大查看 (Zoom)"
                                      >
                                          <ZoomInIcon className="w-5 h-5" />
                                      </button>
                                      <button
                                          onClick={() => handleDownloadImage(generatedImages[vp.id].src!, `generated-${vp.id}.png`)}
                                          className="p-2 bg-white/20 backdrop-blur rounded-full text-white hover:bg-white/30 transition-colors"
                                          title="下载图片 (Download)"
                                      >
                                          <DownloadIcon className="w-5 h-5" />
                                      </button>
                                  </div>
                              </div>
                          </div>
                      ) : (generatedImages[vp.id] as any).error ? (
                          <div className="w-full aspect-[3/4] bg-red-50 rounded-lg border border-red-100 flex flex-col items-center justify-center p-6 text-center">
                              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center text-red-500 mb-3">
                                  !
                              </div>
                              <p className="text-red-800 font-medium">生成失败</p>
                              <p className="text-sm text-red-600 mt-1">{(generatedImages[vp.id] as any).error}</p>
                              <button 
                                  onClick={() => handleGenerate(vp.id, true)}
                                  className="mt-4 px-4 py-2 bg-white border border-red-200 text-red-600 rounded-lg text-sm hover:bg-red-50 transition-colors"
                              >
                                  重试
                              </button>
                          </div>
                      ) : (
                          <div className="w-full aspect-[3/4] bg-gray-50 rounded-lg flex items-center justify-center">
                               <LoadingSpinner className="w-8 h-8 text-gray-300" />
                          </div>
                      )
                  ) : (
                      <div className="w-full aspect-[3/4] bg-gray-50 rounded-lg border-2 border-dashed border-gray-200 flex flex-col items-center justify-center text-gray-400">
                          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                              <MagicWandIcon className="w-8 h-8 text-gray-300" />
                          </div>
                          <p className="text-sm font-medium">等待生成</p>
                          <p className="text-xs mt-1">结果将显示在这里</p>
                      </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          <button 
            onClick={addVariablePrompt}
            className="w-full py-4 border-2 border-dashed border-gray-300 rounded-xl flex items-center justify-center text-gray-500 hover:border-purple-500 hover:text-purple-600 hover:bg-purple-50/30 transition-all group"
          >
            <PlusIcon className="w-6 h-6 mr-2 group-hover:scale-110 transition-transform" />
            <span className="font-medium">新增生成项</span>
          </button>
        </div>
      </div>

      {/* Enlarged Image Modal */}
      {enlargedImage && (
        <ImageModal
          src={enlargedImage}
          onClose={() => setEnlargedImage(null)}
        />
      )}
    </div>
  );
};
