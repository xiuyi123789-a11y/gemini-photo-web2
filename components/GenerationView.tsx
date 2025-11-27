
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AnalysisResult, ImageFile, VariablePrompt, GeneratedImageState, KnowledgeBaseEntry, KnowledgeBaseCategory, ReferenceImageFile } from '../types';
import { MagicWandIcon, PlusIcon, TrashIcon, RefreshIcon, DownloadIcon, ZoomInIcon, EyeIcon, PlayIcon } from './IconComponents';
import { generateMasterImage, modifyMasterImage, generateSingleFromMaster, removeWatermark } from '../services/geminiService';
import { incrementEntryUsage } from '../services/knowledgeBaseService';
import { LoadingSpinner } from './LoadingSpinner';
import { KnowledgeBaseModal } from './KnowledgeBaseModal';
import { ImageModal } from './ImageModal';
import { useApiKey } from '../src/contexts/ApiKeyContext';

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
  initialAnalysisResult: AnalysisResult | null;
}

const MAX_REF_IMAGES = 8;

export const GenerationView: React.FC<GenerationViewProps> = ({ initialAnalysisResult }) => {
  const [referenceImages, setReferenceImages] = useState<ReferenceImageFile[]>([]);
  const [consistentPrompt, setConsistentPrompt] = useState('');
  const [variablePrompts, setVariablePrompts] = useState<VariablePrompt[]>([
    { id: uuidv4(), prompt: '' }
  ]);
  
  const [masterImage, setMasterImage] = useState<{ src: string | null; isLoading: boolean }>({ src: null, isLoading: false });
  const [masterPromptStale, setMasterPromptStale] = useState(false);
  const [modificationPrompt, setModificationPrompt] = useState('');
  
  const [error, setError] = useState<string | null>(null);
  const [generatedImages, setGeneratedImages] = useState<GeneratedImageState>({});
  const [enlargedImage, setEnlargedImage] = useState<string | null>(null);
  
  const [isKbModalOpen, setIsKbModalOpen] = useState(false);
  const [editingField, setEditingField] = useState<'consistent' | string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { apiKey } = useApiKey();


  const populateFromAnalysis = useCallback((analysisResult: AnalysisResult | null) => {
    if (analysisResult) {
      const { consistent_elements, inconsistent_elements } = analysisResult;
      
      const consistentText = `主要主体: ${consistent_elements.primary_subject.item} (品牌: ${consistent_elements.primary_subject.brand}), 关键特征: ${consistent_elements.primary_subject.key_features.join(', ')}, 材质: ${consistent_elements.primary_subject.materials.join(', ')}.
场景环境: ${consistent_elements.scene_environment.general_location}, 包含 ${consistent_elements.scene_environment.shared_elements.join(', ')} 等元素.
风格与质量: ${consistent_elements.image_quality_and_composition.style}, 使用 ${consistent_elements.image_quality_and_composition.lens_type} 拍摄, 光照为 ${consistent_elements.image_quality_and_composition.lighting}, 画质 ${consistent_elements.image_quality_and_composition.quality}.
情感氛围: ${consistent_elements.primary_subject.emotional_tone}.`;
      setConsistentPrompt(consistentText);

      const variableItems = inconsistent_elements.map(item => ({
        id: uuidv4(),
        prompt: `宽高比: ${item.aspect_ratio}. 景别: ${item.framing}. 姿势: ${item.subject_pose}. 人物描述 (重要): ${item.person_description}. 独特细节: ${item.unique_details}. 相机设置: ${item.camera_settings}.`
      }));
      setVariablePrompts(variableItems.length > 0 ? variableItems : [{ id: uuidv4(), prompt: '' }]);
    }
  }, []);

  useEffect(() => {
    populateFromAnalysis(initialAnalysisResult);
  }, [initialAnalysisResult, populateFromAnalysis]);

  const handleFileSelect = useCallback(async (selectedFiles: ImageFile[]) => {
    const newUploads = selectedFiles.slice(0, MAX_REF_IMAGES - referenceImages.length);
    if (newUploads.length === 0) return;

    const newImageStates: ReferenceImageFile[] = newUploads.map(imgFile => ({
        id: uuidv4(),
        file: imgFile.file,
        originalPreview: imgFile.preview,
        processedPreview: null,
        isProcessing: true,
    }));

    setReferenceImages(prev => [...prev, ...newImageStates]);

    // Process each new upload
    for (const imageState of newImageStates) {
        try {
            if (!apiKey) {
              setError('请先设置您的 API Key。');
              setReferenceImages(prev => prev.map(img => 
                  img.id === imageState.id ? { ...img, isProcessing: false, processedPreview: imageState.originalPreview } : img
              ));
              continue;
            }
            const processedSrc = await removeWatermark(imageState.file, apiKey);
            setReferenceImages(prev => prev.map(img => 
                img.id === imageState.id ? { ...img, processedPreview: processedSrc, isProcessing: false } : img
            ));
        } catch (error) {
            console.error("Watermark removal failed:", error);
            setError(`图片 ${imageState.file.name} 的水印去除失败。`);
            setReferenceImages(prev => prev.map(img => 
                img.id === imageState.id ? { ...img, isProcessing: false, processedPreview: imageState.originalPreview } : img // Use original on error
            ));
        }
    }
  }, [referenceImages.length]);

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
    setVariablePrompts(prev => [...prev, { id: crypto.randomUUID(), prompt: '' }]);
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
      const processed = referenceImages.map(img => img.processedPreview).filter((p): p is string => p !== null);
      if (processed.length !== referenceImages.length) {
          setError("请等待所有参考图处理（例如，去水印）完成。");
          return null;
      }
      return processed;
  };

  const handleGenerateMaster = async (isRegeneration = false) => {
    if (!apiKey) {
      setError('请先设置您的 API Key。');
      return;
    }
    const processedImages = getProcessedImages();
    if (!processedImages || processedImages.length === 0 || !variablePrompts[0]?.prompt) {
        setError("请上传、等待处理完成至少一张参考图，并填写第一个非一致性提示。");
        return;
    }
    setError(null);
    setMasterImage({ src: null, isLoading: true });
    
    try {
        const result = await generateMasterImage(processedImages, consistentPrompt, variablePrompts[0].prompt, apiKey);
        setMasterImage({ src: result, isLoading: false });
        setMasterPromptStale(false);
    } catch (e: any) {
        setError(e.message || "主图生成失败。");
        setMasterImage({ src: null, isLoading: false });
    }
  };

  const handleModifyMaster = async () => {
    if (!apiKey) {
      setError('请先设置您的 API Key。');
      return;
    }
    const processedImages = getProcessedImages();
    if (!processedImages || processedImages.length === 0 || !masterImage.src || !modificationPrompt) {
        setError("无法修改，缺少参考图、主图或修改指令。");
        return;
    }
    setError(null);
    setMasterImage(prev => ({ ...prev, isLoading: true }));
    try {
        const result = await modifyMasterImage(processedImages, masterImage.src, consistentPrompt, variablePrompts[0].prompt, modificationPrompt, apiKey);
        setMasterImage({ src: result, isLoading: false });
        setModificationPrompt('');
    } catch (e: any) {
        setError(e.message || "主图修改失败。");
        setMasterImage(prev => ({ ...prev, isLoading: false }));
    }
  };
  
  const handleGenerateAll = async () => {
    if (!apiKey) {
      setError('请先设置您的 API Key。');
      return;
    }
    const processedImages = getProcessedImages();
    if (!processedImages || processedImages.length === 0 || !masterImage.src) {
        setError("请先生成并确认主图，才能生成系列图片。");
        return;
    }
    setError(null);
    
    const imagePromises = variablePrompts.map(vp => 
        generateSingleFromMaster(processedImages, masterImage.src!, consistentPrompt, vp.prompt, false, apiKey)
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
    if (!apiKey) {
      setError('请先设置您的 API Key。');
      return;
    }
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
        const imageSrc = await generateSingleFromMaster(processedImages, masterImage.src, consistentPrompt, promptToRegenerate.prompt, true, apiKey);
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

  const handleSelectKbEntry = (entry: KnowledgeBaseEntry) => {
    incrementEntryUsage(entry.id);
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

  return (
    <div>
        {enlargedImage && <ImageModal src={enlargedImage} onClose={() => setEnlargedImage(null)} />}
        {isKbModalOpen && <KnowledgeBaseModal onClose={() => setIsKbModalOpen(null)} onSelectEntry={handleSelectKbEntry} />}
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
              </div>
              
              <div>
                 <div className="flex justify-between items-center mb-3">
                    <h3 className="text-xl font-bold text-white flex items-center gap-2">
                        <span className="bg-violet-500 w-8 h-8 rounded-full flex items-center justify-center text-sm">2</span>
                        一致性内容
                    </h3>
                     <button onClick={() => openKbModal('consistent')} className="px-3 py-1.5 text-fuchsia-300 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 rounded-full transition-colors flex items-center gap-1.5 text-sm font-semibold border border-fuchsia-500/20" title="从知识库获取灵感">
                        <MagicWandIcon className="w-4 h-4" />
                        获取灵感
                    </button>
                </div>
                <textarea
                  value={consistentPrompt}
                  onChange={handleConsistentPromptChange}
                  rows={5}
                  className="w-full p-4 bg-slate-800/50 border border-slate-600 rounded-2xl focus:ring-2 focus:ring-fuchsia-500 focus:border-transparent transition-all text-slate-200 placeholder-slate-500 resize-y shadow-inner"
                  placeholder="例如：一名19岁的女大学生，穿着白色超大T恤和浅蓝色宽松牛仔裤..."
                />
              </div>

              <div>
                <h3 className="text-xl font-bold text-white mb-3 flex items-center gap-2">
                    <span className="bg-blue-500 w-8 h-8 rounded-full flex items-center justify-center text-sm">3</span>
                    非一致性内容 (单张定义)
                </h3>
                <div className="space-y-5">
                  {variablePrompts.map((vp, index) => (
                    <div key={vp.id} className="bg-slate-800/40 border border-white/5 p-4 rounded-2xl shadow-lg backdrop-blur-sm hover:border-white/10 transition-colors">
                      <div className="flex items-center justify-between mb-2">
                         <span className="text-sm font-bold text-fuchsia-400 uppercase tracking-wider">图片 #{index + 1}</span>
                         <div className="flex space-x-1">
                            <button onClick={() => openKbModal(vp.id)} className="p-2 text-slate-400 hover:text-fuchsia-400 hover:bg-white/5 rounded-full transition-colors" title="从知识库获取灵感">
                                <MagicWandIcon className="w-4 h-4" />
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
                        className="w-full p-3 bg-slate-900/50 border border-slate-700 rounded-xl focus:ring-2 focus:ring-fuchsia-500 focus:border-transparent transition text-slate-300 placeholder-slate-600"
                        placeholder={index === 0 ? '主图的提示词：全身照，站在镜子前...' : '例如：鞋子特写，无人物...'}
                      />
                      
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
                  ))}
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
                    <button onClick={() => handleGenerateMaster(false)} disabled={masterImage.isLoading || referenceImages.some(i => i.isProcessing) || referenceImages.length === 0 || !variablePrompts[0]?.prompt} className={`flex-grow font-bold py-3 px-6 rounded-xl transition-all shadow-lg transform active:scale-95 ${masterPromptStale ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-amber-500/30' : 'bg-gradient-to-r from-fuchsia-600 to-purple-600 hover:from-fuchsia-500 hover:to-purple-500 text-white shadow-fuchsia-500/30'} disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none`}>
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
