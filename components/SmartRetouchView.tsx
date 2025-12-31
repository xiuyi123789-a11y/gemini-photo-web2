import React, { useState, useEffect, useRef } from 'react';
import { SmartRetouchRow, KnowledgeBaseEntry } from '../types';
import { analyzeImageSmartRetouch, generateSmartRetouchImage, mergeRetouchPromptsWithImage, upscaleImage, DEFAULT_CLARITY_PARAMS, DEFAULT_REAL_ESRGAN_PARAMS, type UpscaleModel, extractSdPromptsFromImage } from '../services/replicateService';
import { addRetouchLearningEntry } from '../services/knowledgeBaseService';
import { MagicWandIcon, PlayIcon, DownloadIcon, ZoomInIcon, TrashIcon, PlusIcon, FireIcon, RefreshIcon } from './IconComponents';
import { LoadingSpinner } from './LoadingSpinner';
import { ImageModal } from './ImageModal';
import { KnowledgeBaseModal } from './KnowledgeBaseModal';

const CLARITY_SCHEDULERS = [
    'DPM++ 2M Karras',
    'DPM++ SDE Karras',
    'DPM++ 2M SDE Exponential',
    'DPM++ 2M SDE Karras',
    'Euler a',
    'Euler',
    'LMS',
    'Heun',
    'DPM2',
    'DPM2 a',
    'DPM++ 2S a',
    'DPM++ 2M',
    'DPM++ SDE',
    'DPM++ 2M SDE',
    'DPM++ 2M SDE Heun',
    'DPM++ 2M SDE Heun Karras',
    'DPM++ 2M SDE Heun Exponential',
    'DPM++ 3M SDE',
    'DPM++ 3M SDE Karras',
    'DPM++ 3M SDE Exponential',
    'DPM fast',
    'DPM adaptive',
    'LMS Karras',
    'DPM2 Karras',
    'DPM2 a Karras',
    'DPM++ 2S a Karras',
    'Restart',
    'DDIM',
    'PLMS',
    'UniPC'
] as const;

const CLARITY_SD_MODELS = [
    'juggernaut_reborn.safetensors [338b85bc4f]',
    'epicrealism_naturalSinRC1VAE.safetensors [84d76a0328]',
    'flat2DAnimegre_v45Sharp.safetensors'
] as const;

const CLARITY_TILING_OPTIONS = [16, 32, 64, 112, 128, 144, 256] as const;
const CLARITY_HANDFIX_OPTIONS = ['disabled', 'hands_only', 'image_and_hands'] as const;
const CLARITY_OUTPUT_FORMATS = ['webp', 'png', 'jpg'] as const;

export const SmartRetouchView: React.FC = () => {
    const [activePage, setActivePage] = useState<'home' | 'optimize' | 'upscale'>('home');
    const [rows, setRows] = useState<SmartRetouchRow[]>([
        { id: '1', originalImage: null, analysisText: '', understandingText: '', retouchStrength: 0.65, isAnalyzing: false, generatedImage: null, isGenerating: false, error: null },
        { id: '2', originalImage: null, analysisText: '', understandingText: '', retouchStrength: 0.65, isAnalyzing: false, generatedImage: null, isGenerating: false, error: null },
        { id: '3', originalImage: null, analysisText: '', understandingText: '', retouchStrength: 0.65, isAnalyzing: false, generatedImage: null, isGenerating: false, error: null },
    ]);
    const [enlargedImage, setEnlargedImage] = useState<string | null>(null);
    const [saveStatus, setSaveStatus] = useState<Record<string, boolean>>({});
    const [upscaleSource, setUpscaleSource] = useState<{ file: File; preview: string } | null>(null);
    const [upscaledImage, setUpscaledImage] = useState<string | null>(null);
    const [upscaleModel, setUpscaleModel] = useState<UpscaleModel>('real-esrgan');
    const [realEsrganParams, setRealEsrganParams] = useState({ ...DEFAULT_REAL_ESRGAN_PARAMS, scale: 4 });
    const [clarityParams, setClarityParams] = useState({ ...DEFAULT_CLARITY_PARAMS, scale_factor: 2 });
    const [isUpscaling, setIsUpscaling] = useState(false);
    const [upscaleError, setUpscaleError] = useState<string | null>(null);
    const [upscaleSaveStatus, setUpscaleSaveStatus] = useState(false);
    const [isDetectingPrompts, setIsDetectingPrompts] = useState(false);
    
    // Knowledge Base Modal State
    const [isKbModalOpen, setIsKbModalOpen] = useState(false);
    const [activeRowIdForKb, setActiveRowIdForKb] = useState<string | null>(null);

    const rowsRef = useRef(rows);
    const upscaleSourceRef = useRef(upscaleSource);
    const upscaledImageRef = useRef(upscaledImage);

    useEffect(() => {
        rowsRef.current = rows;
    }, [rows]);

    useEffect(() => {
        upscaleSourceRef.current = upscaleSource;
    }, [upscaleSource]);

    useEffect(() => {
        upscaledImageRef.current = upscaledImage;
    }, [upscaledImage]);

    useEffect(() => {
        if (activePage !== 'optimize') {
            setIsKbModalOpen(false);
            setActiveRowIdForKb(null);
        }
    }, [activePage]);

    // Cleanup blob URLs on unmount
    useEffect(() => {
        return () => {
            rowsRef.current.forEach(row => {
                if (row.originalImage?.preview) {
                    URL.revokeObjectURL(row.originalImage.preview);
                }
                if (row.generatedImage?.startsWith('blob:')) {
                    URL.revokeObjectURL(row.generatedImage);
                }
            });
            if (upscaleSourceRef.current?.preview) {
                URL.revokeObjectURL(upscaleSourceRef.current.preview);
            }
            if (upscaledImageRef.current?.startsWith('blob:')) {
                URL.revokeObjectURL(upscaledImageRef.current);
            }
        };
    }, []);

    const handleImageUpload = (rowId: string, file: File) => {
        setRows(prev => prev.map(row => {
            if (row.id === rowId) {
                // Release old blob URL
                if (row.originalImage?.preview) {
                    URL.revokeObjectURL(row.originalImage.preview);
                }
                
                const preview = URL.createObjectURL(file);
                return { 
                    ...row, 
                    originalImage: { file, preview }, 
                    error: null,
                    generatedImage: null,
                    analysisText: '',
                    understandingText: ''
                };
            }
            return row;
        }));
        
        // Auto-trigger analysis
        handleAnalyze(rowId, file);
    };

    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

    const parseStrengthFromText = (text: string) => {
        const match = (text || '').match(/重绘幅度\s*[:：]\s*(0(?:\.\d+)?|1(?:\.0+)?)/);
        if (!match) return null;
        const n = Number(match[1]);
        if (Number.isNaN(n)) return null;
        return clamp01(n);
    };

    const extractAiInstructions = (text: string) => {
        const raw = (text || '').trim();
        if (!raw) return '';

        const match = raw.match(/【\s*给\s*AI\s*看\s*的\s*】([\s\S]*)$/i);
        const section = (match?.[1] || raw).trim();

        const cleaned = section
            .split(/\r?\n/)
            .filter(line => !/重绘幅度|retouch_strength|strength\s*[:：]/i.test(line))
            .join('\n')
            .trim();

        return cleaned || raw;
    };

    const handleAnalyze = async (rowId: string, file?: File) => {
        const row = rows.find(r => r.id === rowId);
        const imageFile = file || row?.originalImage?.file;
        
        if (!imageFile) return;

        setRows(prev => prev.map(r => r.id === rowId ? { ...r, isAnalyzing: true, error: null } : r));
        
        try {
            const analysis = await analyzeImageSmartRetouch(imageFile);
            
            setRows(prev => {
                const currentRow = prev.find(r => r.id === rowId);
                if (currentRow && currentRow.analysisText.trim() !== '') {
                    // User has typed, don't overwrite
                    return prev.map(r => r.id === rowId ? { 
                        ...r, 
                        isAnalyzing: false,
                        understandingText: analysis.understanding 
                    } : r);
                }
                // Auto-fill both
                return prev.map(r => r.id === rowId ? { 
                    ...r, 
                    isAnalyzing: false, 
                    analysisText: analysis.suggestions,
                    understandingText: analysis.understanding,
                    retouchStrength: parseStrengthFromText(analysis.suggestions) ?? r.retouchStrength
                } : r);
            });
        } catch (e: any) {
            console.error('Analysis failed:', e);
            setRows(prev => prev.map(r => r.id === rowId ? { 
                ...r, 
                isAnalyzing: false, 
                error: e.message || 'AI 分析失败，请重试'
            } : r));
        }
    };

    const handleGenerate = async (rowId: string) => {
        const row = rows.find(r => r.id === rowId);
        if (!row?.originalImage || !row.analysisText) return;

        setRows(prev => prev.map(r => r.id === rowId ? { ...r, isGenerating: true, error: null } : r));
        
        try {
            const aiInstructions = extractAiInstructions(row.analysisText);
            let fullPrompt = aiInstructions;
            
            if (row.understandingText) {
                fullPrompt = await mergeRetouchPromptsWithImage(
                    row.originalImage.file,
                    row.understandingText,
                    aiInstructions
                );
            }

            const result = await generateSmartRetouchImage(row.originalImage.file, fullPrompt, row.retouchStrength);
            
            setRows(prev => prev.map(r => r.id === rowId ? { 
                ...r, 
                generatedImage: result, 
                isGenerating: false 
            } : r));
        } catch (e: any) {
            console.error('Generation failed:', e);
            setRows(prev => prev.map(r => r.id === rowId ? { 
                ...r, 
                isGenerating: false, 
                error: e.message || "生成失败，请重试" 
            } : r));
        }
    };
    
    const openKbModal = (rowId: string) => {
        setActiveRowIdForKb(rowId);
        setIsKbModalOpen(true);
    };

    const handleKbSelection = (entry: KnowledgeBaseEntry) => {
        if (!activeRowIdForKb) return;
        
        const textToAdd = entry.promptFragment;
        
        setRows(prev => prev.map(row => {
            if (row.id === activeRowIdForKb) {
                const currentText = row.analysisText || '';
                const newText = currentText ? `${currentText}\n- ${textToAdd}` : `- ${textToAdd}`;
                return { ...row, analysisText: newText };
            }
            return row;
        }));
        
        setIsKbModalOpen(false);
        setActiveRowIdForKb(null);
    };
    
    const handleDownload = async (src: string, rowId: string) => {
        const row = rows.find(r => r.id === rowId);
        
        try {
            const link = document.createElement('a');
            link.href = src;
            link.download = `retouched_image_${rowId}_${Date.now()}.png`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            if (row?.originalImage && row.analysisText) {
                await addRetouchLearningEntry(row.originalImage.file, row.analysisText);
                setSaveStatus(prev => ({ ...prev, [rowId]: true }));
                setTimeout(() => setSaveStatus(prev => ({ ...prev, [rowId]: false })), 3000);
            }
        } catch (e) {
            console.error("Failed to save:", e);
            setRows(prev => prev.map(r => r.id === rowId ? {
                ...r,
                error: '保存失败，请重试'
            } : r));
        }
    };

    const handleUpscaleSourceUpload = (file: File) => {
        if (upscaleSource?.preview) {
            URL.revokeObjectURL(upscaleSource.preview);
        }
        const preview = URL.createObjectURL(file);
        setUpscaleSource({ file, preview });
        setUpscaledImage(null);
        setUpscaleError(null);
        setUpscaleSaveStatus(false);
    };

    const handleRunUpscale = async () => {
        if (!upscaleSource || isUpscaling) return;
        setIsUpscaling(true);
        setUpscaleError(null);

        try {
            const imageUrl = await upscaleImage(
                upscaleSource.file,
                upscaleModel,
                upscaleModel === 'real-esrgan' ? realEsrganParams : clarityParams
            );

            if (upscaledImage?.startsWith('blob:')) {
                URL.revokeObjectURL(upscaledImage);
            }
            setUpscaledImage(imageUrl);
        } catch (e: any) {
            setUpscaleError(e?.message || '放大失败，请重试');
        } finally {
            setIsUpscaling(false);
        }
    };


    const handleDownloadSimple = (src: string, filenameBase: string) => {
        const link = document.createElement('a');
        link.href = src;
        link.download = `${filenameBase}_${Date.now()}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const pageTitle =
        activePage === 'home' ? '图像处理' : activePage === 'upscale' ? '放大图像' : '图像优化';
    const pageDescription =
        activePage === 'home'
            ? '请选择工具入口后进入创作页面。'
            : activePage === 'upscale'
                ? '选择模型与参数，一键生成高清放大图。'
                : 'AI 全方位解析，一键优化肢体、构图与光影。';

    return (
        <div>
            {enlargedImage && <ImageModal src={enlargedImage} onClose={() => setEnlargedImage(null)} />}
            
            <div className="max-w-6xl mx-auto mb-8 flex items-start justify-between gap-6">
                <button
                    type="button"
                    onClick={() => activePage !== 'home' && setActivePage('home')}
                    disabled={activePage === 'home'}
                    className={`text-left ${activePage === 'home' ? '' : 'cursor-pointer'}`}
                >
                    <div className="text-3xl font-extrabold text-slate-900 mb-2">{pageTitle}</div>
                    <div className="text-slate-600">{pageDescription}</div>
                </button>

                {activePage !== 'home' && (
                    <button
                        type="button"
                        onClick={() => setActivePage('home')}
                        className="px-4 py-2.5 rounded-xl font-bold text-slate-700 hover:bg-white/70 transition-colors bg-white/60 border border-slate-200"
                    >
                        返回
                    </button>
                )}
            </div>

            {activePage === 'home' ? (
                <div className="max-w-5xl mx-auto">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <button
                            onClick={() => setActivePage('optimize')}
                            className="bg-white/80 border border-slate-200 rounded-3xl p-8 shadow-sm hover:shadow-md transition-all text-left group"
                        >
                            <div className="flex items-center gap-3 mb-2">
                                <div className="p-3 rounded-2xl bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-100 group-hover:bg-fuchsia-100 transition-colors">
                                    <MagicWandIcon className="w-6 h-6" />
                                </div>
                                <div className="text-xl font-extrabold text-slate-900">图像优化</div>
                            </div>
                            <div className="text-sm text-slate-600">进入修图创作页面</div>
                        </button>

                        <button
                            onClick={() => setActivePage('upscale')}
                            className="bg-white/80 border border-slate-200 rounded-3xl p-8 shadow-sm hover:shadow-md transition-all text-left group"
                        >
                            <div className="flex items-center gap-3 mb-2">
                                <div className="p-3 rounded-2xl bg-blue-50 text-blue-700 border border-blue-100 group-hover:bg-blue-100 transition-colors">
                                    <ZoomInIcon className="w-6 h-6" />
                                </div>
                                <div className="text-xl font-extrabold text-slate-900">放大图像</div>
                            </div>
                            <div className="text-sm text-slate-600">独立的图片放大入口与参数控制</div>
                        </button>
                    </div>
                </div>
            ) : (
                <>
                    {activePage === 'optimize' ? (
                        <>
                            <div className="space-y-12">
                                {rows.map((row) => (
                                    <div key={row.id} className="bg-white/80 border border-slate-200 rounded-3xl p-8 shadow-sm relative overflow-hidden backdrop-blur-sm">
                                        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500/50 via-cyan-500/50 to-transparent"></div>
                                        
                                        <div className="mb-6 flex items-center gap-3">
                                            <h3 className="text-xl font-bold text-slate-900 tracking-wide">
                                                创作单元
                                            </h3>
                                        </div>

                                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-stretch">
                                            <div>
                                                <div 
                                                    className={`relative h-[520px] lg:h-[624px] w-full bg-slate-50 rounded-2xl border-2 ${row.originalImage ? 'border-slate-200' : 'border-dashed border-slate-300'} overflow-hidden group transition-all flex items-center justify-center cursor-pointer shadow-sm`}
                                                    onClick={() => row.originalImage && setEnlargedImage(row.originalImage.preview)}
                                                >
                                                    {row.originalImage ? (
                                                        <>
                                                            <img src={row.originalImage.preview} alt="Original" className="w-full h-full object-cover" />
                                                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                                                                <div className="p-3 bg-white/20 rounded-full text-white hover:bg-white/30 backdrop-blur-sm transition-colors">
                                                                    <ZoomInIcon className="w-6 h-6"/>
                                                                </div>
                                                                <label 
                                                                    className="p-3 bg-white/20 rounded-full text-white hover:bg-white/30 cursor-pointer backdrop-blur-sm transition-colors"
                                                                    onClick={(e) => e.stopPropagation()}
                                                                >
                                                                    <TrashIcon className="w-6 h-6" />
                                                                    <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                                                                        if(e.target.files?.[0]) handleImageUpload(row.id, e.target.files[0]);
                                                                    }}/>
                                                                </label>
                                                            </div>
                                                        </>
                                                    ) : (
                                                        <label className="cursor-pointer flex flex-col items-center justify-center h-full w-full hover:bg-white transition">
                                                            <PlusIcon className="w-12 h-12 text-slate-500 mb-3" />
                                                            <span className="text-slate-600 text-sm font-medium">点击上传图片</span>
                                                            <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                                                                if(e.target.files?.[0]) handleImageUpload(row.id, e.target.files[0]);
                                                            }}/>
                                                        </label>
                                                    )}
                                                </div>
                                            </div>

                                            <div className="flex flex-col gap-4 w-full bg-white/80 rounded-2xl p-6 border border-slate-200 shadow-sm backdrop-blur-sm h-[520px] lg:h-[624px]">
                                                <div className="space-y-2">
                                                    <div className="flex items-center justify-between">
                                                        <label className="text-sm font-semibold text-slate-700">重绘幅度</label>
                                                        <span className="text-sm font-mono text-fuchsia-400">{row.retouchStrength.toFixed(2)}</span>
                                                    </div>
                                                    <input
                                                        type="range"
                                                        min={0}
                                                        max={1}
                                                        step={0.01}
                                                        value={row.retouchStrength}
                                                        onChange={(e) => {
                                                            const next = clamp01(Number(e.target.value));
                                                            setRows(prev => prev.map(r => r.id === row.id ? { ...r, retouchStrength: next } : r));
                                                        }}
                                                        className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-fuchsia-500"
                                                    />
                                                </div>

                                                <div className="relative flex-1 min-h-0">
                                                    <textarea 
                                                        value={row.analysisText}
                                                        onChange={(e) => setRows(prev => prev.map(r => r.id === row.id ? {...r, analysisText: e.target.value} : r))}
                                                        placeholder="在此输入修图指令，或等待 AI 解析..."
                                                        className="w-full h-full min-h-0 bg-white/80 border border-slate-200 rounded-xl resize-none overflow-y-auto text-slate-800 text-sm focus:ring-2 focus:ring-fuchsia-500 focus:border-transparent placeholder-slate-400 p-4 pb-16 custom-scrollbar shadow-sm"
                                                        disabled={!row.originalImage}
                                                    />
                                                    
                                                    {row.originalImage && (
                                                        <button
                                                            onClick={() => openKbModal(row.id)}
                                                            className="absolute bottom-3 right-3 px-3 py-2 bg-gradient-to-r from-fuchsia-600 to-purple-600 hover:from-fuchsia-500 hover:to-purple-500 text-white rounded-lg transition-all shadow-lg flex items-center gap-2 text-xs font-bold border border-white/10"
                                                            title="从灵感知识库选择"
                                                        >
                                                            <FireIcon className="w-4 h-4" />
                                                            获取灵感
                                                        </button>
                                                    )}

                                                    {row.isAnalyzing && (
                                                        <div className="absolute top-3 right-3 px-3 py-1.5 bg-blue-50 text-blue-700 text-xs rounded-full border border-blue-200 flex items-center gap-2 animate-pulse">
                                                            <MagicWandIcon className="w-3 h-3" />
                                                            AI 正在撰写建议...
                                                        </div>
                                                    )}
                                                </div>
                                            </div>

                                            <div>
                                                <div 
                                                    className="relative h-[520px] lg:h-[624px] w-full bg-slate-50 rounded-2xl border border-slate-200 overflow-hidden flex items-center justify-center group cursor-pointer shadow-sm"
                                                    onClick={() => row.generatedImage && setEnlargedImage(row.generatedImage)}
                                                >
                                                    {row.isGenerating ? (
                                                        <LoadingSpinner text="正在重绘..." />
                                                    ) : row.generatedImage ? (
                                                        <>
                                                            <img src={row.generatedImage} alt="Generated" className="w-full h-full object-cover" />
                                                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                                                <div className="p-3 bg-white/20 rounded-full text-white hover:bg-white/30 backdrop-blur-sm transition-colors">
                                                                    <ZoomInIcon className="w-6 h-6"/>
                                                                </div>
                                                            </div>
                                                        </>
                                                    ) : (
                                                        <div className="text-slate-600 text-center px-6">
                                                            <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-white flex items-center justify-center border border-slate-200">
                                                                <MagicWandIcon className="w-8 h-8 opacity-50" />
                                                            </div>
                                                            <p className="text-sm">优化后的成品<br/>将显示在此处</p>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mt-6 items-start">
                                            <button 
                                                onClick={() => handleAnalyze(row.id)} 
                                                disabled={!row.originalImage || row.isAnalyzing}
                                                className="w-full py-3 rounded-xl font-bold bg-white hover:bg-slate-50 text-slate-800 shadow-sm border border-slate-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
                                            >
                                                {row.isAnalyzing ? (
                                                    <LoadingSpinner text="AI 正在思考..." />
                                                ) : (
                                                    <>
                                                        <RefreshIcon className="w-5 h-5" />
                                                        重新获取建议
                                                    </>
                                                )}
                                            </button>

                                            <button 
                                                onClick={() => handleGenerate(row.id)}
                                                disabled={!row.originalImage || !row.analysisText || row.isGenerating}
                                                className={`w-full py-4 rounded-xl font-bold text-white shadow-xl flex items-center justify-center gap-2 transition-all text-base ${
                                                    (!row.originalImage || !row.analysisText || row.isGenerating) 
                                                        ? 'bg-slate-700 opacity-50 cursor-not-allowed' 
                                                        : 'bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-500 hover:to-pink-500 shadow-fuchsia-500/30 hover:shadow-fuchsia-500/50 hover:scale-[1.02]'
                                                }`}
                                            >
                                                {row.isGenerating ? (
                                                    <LoadingSpinner text="" />
                                                ) : (
                                                    <>
                                                        <PlayIcon className="w-5 h-5" />
                                                        执行优化指令
                                                    </>
                                                )}
                                            </button>

                                            <button 
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if(row.generatedImage) handleDownload(row.generatedImage, row.id);
                                                }}
                                                disabled={!row.generatedImage}
                                                className={`w-full py-3 rounded-xl font-bold text-white shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all ${
                                                    saveStatus[row.id] 
                                                        ? 'bg-green-600 hover:bg-green-500 shadow-green-500/30' 
                                                        : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-500/30'
                                                }`}
                                            >
                                                {saveStatus[row.id] ? (
                                                    <>✅ 已保存并记忆</>
                                                ) : (
                                                    <>
                                                        <DownloadIcon className="w-5 h-5" />
                                                        一键保存
                                                    </>
                                                )}
                                            </button>
                                        </div>

                                        {row.error && (
                                            <div className="mt-6">
                                                <p className="text-center text-red-700 bg-red-50 py-3 rounded-xl text-sm border border-red-200">
                                                    {row.error}
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>

                            {isKbModalOpen && (
                                <KnowledgeBaseModal
                                    onClose={() => setIsKbModalOpen(false)}
                                    onSelectEntry={handleKbSelection}
                                    currentContextPrompt={
                                        rows.find(r => r.id === activeRowIdForKb)?.understandingText || 
                                        rows.find(r => r.id === activeRowIdForKb)?.analysisText || 
                                        undefined
                                    }
                                />
                            )}
                        </>
                    ) : (
                        <div className="max-w-6xl mx-auto">
                            <div className="bg-white/80 border border-slate-200 rounded-3xl p-8 shadow-sm relative overflow-hidden backdrop-blur-sm">
                                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500/50 via-cyan-500/50 to-transparent"></div>

                                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
                                    <div>
                                        <div 
                                            className={`relative aspect-[3/4] bg-slate-50 rounded-2xl border-2 ${upscaleSource ? 'border-slate-200' : 'border-dashed border-slate-300'} overflow-hidden group transition-all flex items-center justify-center cursor-pointer shadow-sm`}
                                            onClick={() => upscaleSource?.preview && setEnlargedImage(upscaleSource.preview)}
                                        >
                                            {upscaleSource ? (
                                                <>
                                                    <img src={upscaleSource.preview} alt="Original" className="w-full h-full object-cover" />
                                                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                                                        <div className="p-3 bg-white/20 rounded-full text-white hover:bg-white/30 backdrop-blur-sm transition-colors">
                                                            <ZoomInIcon className="w-6 h-6"/>
                                                        </div>
                                                        <label 
                                                            className="p-3 bg-white/20 rounded-full text-white hover:bg-white/30 cursor-pointer backdrop-blur-sm transition-colors"
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            <TrashIcon className="w-6 h-6" />
                                                            <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                                                                if(e.target.files?.[0]) handleUpscaleSourceUpload(e.target.files[0]);
                                                            }}/>
                                                        </label>
                                                    </div>
                                                </>
                                            ) : (
                                                <label className="cursor-pointer flex flex-col items-center justify-center h-full w-full hover:bg-white transition">
                                                    <PlusIcon className="w-12 h-12 text-slate-500 mb-3" />
                                                    <span className="text-slate-600 text-sm font-medium">点击上传图片</span>
                                                    <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                                                        if(e.target.files?.[0]) handleUpscaleSourceUpload(e.target.files[0]);
                                                    }}/>
                                                </label>
                                            )}
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-4 w-full bg-white/80 rounded-2xl p-6 border border-slate-200 shadow-sm backdrop-blur-sm">
                                        <div className="space-y-2">
                                            <label className="text-sm font-semibold text-slate-700">放大模型</label>
                                            <select
                                                value={upscaleModel}
                                                onChange={(e) => setUpscaleModel(e.target.value as UpscaleModel)}
                                                className="w-full bg-white/80 border border-slate-200 rounded-xl text-slate-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400 px-3 py-2 shadow-sm"
                                            >
                                                <option value="real-esrgan">Real-ESRGAN（快速）</option>
                                                <option value="clarity-upscaler">Clarity Upscaler（高质量）</option>
                                            </select>
                                        </div>

                                        {upscaleModel === 'real-esrgan' ? (
                                            <div className="grid grid-cols-1 gap-4">
                                                <div className="space-y-2">
                                                    <label className="text-xs font-semibold text-slate-700">放大倍数</label>
                                                    <select
                                                        value={realEsrganParams.scale}
                                                        onChange={(e) => setRealEsrganParams(prev => ({ ...prev, scale: Number(e.target.value) }))}
                                                        className="w-full bg-white/80 border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent px-3 py-2 shadow-sm"
                                                    >
                                                        <option value={2}>2x</option>
                                                        <option value={4}>4x</option>
                                                    </select>
                                                </div>
                                                <label className="flex items-center gap-2 text-xs text-slate-700">
                                                    <input
                                                        type="checkbox"
                                                        checked={realEsrganParams.face_enhance}
                                                        onChange={(e) => setRealEsrganParams(prev => ({ ...prev, face_enhance: e.target.checked }))}
                                                        className="h-4 w-4 accent-blue-600"
                                                    />
                                                    人脸增强
                                                </label>
                                            </div>
                                        ) : (
                                            <div className="grid grid-cols-1 gap-4">
                                                <div className="space-y-2">
                                                    <label className="text-xs font-semibold text-slate-700">sd_model</label>
                                                    <select
                                                        value={clarityParams.sd_model}
                                                        onChange={(e) => setClarityParams(prev => ({ ...prev, sd_model: e.target.value }))}
                                                        className="w-full bg-white/80 border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent px-3 py-2 shadow-sm"
                                                    >
                                                        {CLARITY_SD_MODELS.map(m => (
                                                            <option key={m} value={m}>{m}</option>
                                                        ))}
                                                    </select>
                                                </div>

                                                <div className="space-y-2">
                                                    <label className="text-xs font-semibold text-slate-700">调度器</label>
                                                    <select
                                                        value={clarityParams.scheduler}
                                                        onChange={(e) => setClarityParams(prev => ({ ...prev, scheduler: e.target.value }))}
                                                        className="w-full bg-white/80 border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent px-3 py-2 shadow-sm"
                                                    >
                                                        {CLARITY_SCHEDULERS.map(s => (
                                                            <option key={s} value={s}>{s}</option>
                                                        ))}
                                                    </select>
                                                </div>

                                                <div className="grid grid-cols-2 gap-3">
                                                    <div className="space-y-2">
                                                        <label className="text-xs font-semibold text-slate-700">放大倍数</label>
                                                        <select
                                                            value={clarityParams.scale_factor}
                                                            onChange={(e) => setClarityParams(prev => ({ ...prev, scale_factor: Number(e.target.value) }))}
                                                            className="w-full bg-white/80 border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent px-3 py-2 shadow-sm"
                                                        >
                                                            <option value={1}>1x</option>
                                                            <option value={2}>2x</option>
                                                            <option value={3}>3x</option>
                                                            <option value={4}>4x</option>
                                                        </select>
                                                    </div>
                                                    <div className="space-y-2">
                                                        <label className="text-xs font-semibold text-slate-700">输出格式</label>
                                                        <select
                                                            value={clarityParams.output_format}
                                                            onChange={(e) => setClarityParams(prev => ({ ...prev, output_format: e.target.value as (typeof CLARITY_OUTPUT_FORMATS)[number] }))}
                                                            className="w-full bg-white/80 border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent px-3 py-2 shadow-sm"
                                                        >
                                                            {CLARITY_OUTPUT_FORMATS.map(f => (
                                                                <option key={f} value={f}>{f}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                </div>

                                                <div className="grid grid-cols-2 gap-3">
                                                    <div className="space-y-2">
                                                        <label className="text-xs font-semibold text-slate-700">去噪步数</label>
                                                        <input
                                                            type="number"
                                                            min={1}
                                                            max={100}
                                                            value={clarityParams.num_inference_steps}
                                                            onChange={(e) => setClarityParams(prev => ({ ...prev, num_inference_steps: Number(e.target.value) }))}
                                                            className="w-full bg-white/80 border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent px-3 py-2 shadow-sm"
                                                        />
                                                    </div>
                                                    <div className="space-y-2">
                                                        <label className="text-xs font-semibold text-slate-700">降低分辨率</label>
                                                        <input
                                                            type="number"
                                                            step={1}
                                                            min={1}
                                                            value={clarityParams.downscaling_resolution}
                                                            onChange={(e) => setClarityParams(prev => ({ ...prev, downscaling_resolution: Number(e.target.value) }))}
                                                            className="w-full bg-white/80 border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent px-3 py-2 shadow-sm"
                                                        />
                                                    </div>
                                                </div>

                                                <div className="grid grid-cols-2 gap-3">
                                                    <div className="space-y-2">
                                                        <label className="text-xs font-semibold text-slate-700">seed</label>
                                                        <input
                                                            type="number"
                                                            step={1}
                                                            value={clarityParams.seed}
                                                            onChange={(e) => setClarityParams(prev => ({ ...prev, seed: Math.trunc(Number(e.target.value)) }))}
                                                            className="w-full bg-white/80 border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent px-3 py-2 shadow-sm"
                                                        />
                                                    </div>
                                                    <div className="space-y-2">
                                                        <label className="text-xs font-semibold text-slate-700">handfix</label>
                                                        <select
                                                            value={clarityParams.handfix}
                                                            onChange={(e) => setClarityParams(prev => ({ ...prev, handfix: e.target.value as (typeof CLARITY_HANDFIX_OPTIONS)[number] }))}
                                                            className="w-full bg-white/80 border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent px-3 py-2 shadow-sm"
                                                        >
                                                            {CLARITY_HANDFIX_OPTIONS.map(v => (
                                                                <option key={v} value={v}>{v}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                </div>

                                                <div className="grid grid-cols-2 gap-3">
                                                    <div className="space-y-2">
                                                        <label className="text-xs font-semibold text-slate-700">分型度</label>
                                                        <select
                                                            value={clarityParams.tiling_width}
                                                            onChange={(e) => setClarityParams(prev => ({ ...prev, tiling_width: Number(e.target.value) }))}
                                                            className="w-full bg-white/80 border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent px-3 py-2 shadow-sm"
                                                        >
                                                            {CLARITY_TILING_OPTIONS.map(v => (
                                                                <option key={v} value={v}>{v}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                    <div className="space-y-2">
                                                        <label className="text-xs font-semibold text-slate-700">分型效果</label>
                                                        <select
                                                            value={clarityParams.tiling_height}
                                                            onChange={(e) => setClarityParams(prev => ({ ...prev, tiling_height: Number(e.target.value) }))}
                                                            className="w-full bg-white/80 border border-slate-200 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent px-3 py-2 shadow-sm"
                                                        >
                                                            {CLARITY_TILING_OPTIONS.map(v => (
                                                                <option key={v} value={v}>{v}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                </div>

                                                <label className="flex items-center gap-2 text-xs text-slate-700">
                                                    <input
                                                        type="checkbox"
                                                        checked={clarityParams.pattern}
                                                        onChange={(e) => setClarityParams(prev => ({ ...prev, pattern: e.target.checked }))}
                                                        className="h-4 w-4 accent-blue-600"
                                                    />
                                                    pattern（无缝平铺）
                                                </label>

                                                <div className="space-y-2">
                                                    <div className="flex items-center justify-between">
                                                        <label className="text-xs font-semibold text-slate-700">HDR 强度</label>
                                                        <span className="text-xs font-mono text-blue-600">{clarityParams.dynamic}</span>
                                                    </div>
                                                    <input
                                                        type="range"
                                                        min={1}
                                                        max={50}
                                                        step={1}
                                                        value={clarityParams.dynamic}
                                                        onChange={(e) => setClarityParams(prev => ({ ...prev, dynamic: Number(e.target.value) }))}
                                                        className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                                    />
                                                </div>

                                                <div className="grid grid-cols-2 gap-3">
                                                    <div className="space-y-2">
                                                        <div className="flex items-center justify-between">
                                                            <label className="text-xs font-semibold text-slate-700">创意度</label>
                                                            <span className="text-xs font-mono text-blue-600">{clarityParams.creativity.toFixed(2)}</span>
                                                        </div>
                                                        <input
                                                            type="range"
                                                            min={0}
                                                            max={1}
                                                            step={0.01}
                                                            value={clarityParams.creativity}
                                                            onChange={(e) => setClarityParams(prev => ({ ...prev, creativity: Number(e.target.value) }))}
                                                            className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                                        />
                                                    </div>
                                                    <div className="space-y-2">
                                                        <div className="flex items-center justify-between">
                                                            <label className="text-xs font-semibold text-slate-700">相似度</label>
                                                            <span className="text-xs font-mono text-blue-600">{clarityParams.resemblance.toFixed(2)}</span>
                                                        </div>
                                                        <input
                                                            type="range"
                                                            min={0}
                                                            max={3}
                                                            step={0.01}
                                                            value={clarityParams.resemblance}
                                                            onChange={(e) => setClarityParams(prev => ({ ...prev, resemblance: Number(e.target.value) }))}
                                                            className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                                        />
                                                    </div>
                                                </div>

                                                <div className="space-y-2">
                                                    <div className="flex items-center justify-between">
                                                        <label className="text-xs font-semibold text-slate-700">正向提示词</label>
                                                        <button
                                                            type="button"
                                                            disabled={!upscaleSource || isDetectingPrompts}
                                                            onClick={async () => {
                                                                if (!upscaleSource) return;
                                                                setIsDetectingPrompts(true);
                                                                setUpscaleError(null);
                                                                try {
                                                                    const result = await extractSdPromptsFromImage(upscaleSource.file);
                                                                    setClarityParams(prev => ({ ...prev, prompt: result.positive }));
                                                                    setClarityParams(prev => ({ ...prev, negative_prompt: result.negative }));
                                                                } catch (e: any) {
                                                                    setUpscaleError(e?.message || '图像检测失败');
                                                                } finally {
                                                                    setIsDetectingPrompts(false);
                                                                }
                                                            }}
                                                            className="px-2 py-1 rounded-lg text-xs font-bold border border-slate-200 bg-white/80 hover:bg-slate-50 text-slate-700 disabled:opacity-50"
                                                            title="图像检测"
                                                        >
                                                            {isDetectingPrompts ? '检测中...' : '图像检测'}
                                                        </button>
                                                    </div>
                                                    <textarea
                                                        value={clarityParams.prompt}
                                                        onChange={(e) => setClarityParams(prev => ({ ...prev, prompt: e.target.value }))}
                                                        className="w-full bg-white/80 border border-slate-200 rounded-xl resize-y text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400 p-3 min-h-[88px] shadow-sm"
                                                    />
                                                </div>

                                                <div className="space-y-2">
                                                    <label className="text-xs font-semibold text-slate-700">负向提示词</label>
                                                    <textarea
                                                        value={clarityParams.negative_prompt}
                                                        onChange={(e) => setClarityParams(prev => ({ ...prev, negative_prompt: e.target.value }))}
                                                        className="w-full bg-white/80 border border-slate-200 rounded-xl resize-y text-slate-800 text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400 p-3 min-h-[72px] shadow-sm"
                                                    />
                                                </div>
                                            </div>
                                        )}

                                        <div className="mt-2">
                                            <div className="text-xs font-semibold text-slate-700 mb-1">调用指令预览</div>
                                            <pre className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-[11px] text-slate-700 overflow-x-auto">
{JSON.stringify({ model: upscaleModel, params: (upscaleModel === 'real-esrgan' ? realEsrganParams : clarityParams) }, null, 2)}
                                            </pre>
                                        </div>
                                    </div>

                                    <div className="space-y-4">
                                        <div 
                                            className="relative aspect-[3/4] bg-slate-50 rounded-2xl border border-slate-200 overflow-hidden flex items-center justify-center group cursor-pointer shadow-sm"
                                            onClick={() => upscaledImage && setEnlargedImage(upscaledImage)}
                                        >
                                            {isUpscaling ? (
                                                <LoadingSpinner text="放大中..." />
                                            ) : upscaledImage ? (
                                                <>
                                                    <img src={upscaledImage} alt="Upscaled" className="w-full h-full object-cover" />
                                                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                                        <div className="p-3 bg-white/20 rounded-full text-white hover:bg-white/30 backdrop-blur-sm transition-colors">
                                                            <ZoomInIcon className="w-6 h-6"/>
                                                        </div>
                                                    </div>
                                                </>
                                            ) : (
                                                <div className="text-slate-600 text-center px-6">
                                                    <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-white flex items-center justify-center border border-slate-200">
                                                        <ZoomInIcon className="w-8 h-8 opacity-50" />
                                                    </div>
                                                    <p className="text-sm">放大后的成品<br/>将显示在此处</p>
                                                </div>
                                            )}
                                        </div>

                                        {upscaleError && (
                                            <p className="text-center text-red-700 bg-red-50 py-3 rounded-xl text-sm border border-red-200">
                                                {upscaleError}
                                            </p>
                                        )}
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mt-6 items-start">
                                    <div />
                                    <button 
                                        onClick={handleRunUpscale}
                                        disabled={!upscaleSource || isUpscaling}
                                        className={`w-full py-4 rounded-xl font-bold text-white shadow-xl flex items-center justify-center gap-2 transition-all text-base ${
                                            (!upscaleSource || isUpscaling) 
                                                ? 'bg-slate-700 opacity-50 cursor-not-allowed' 
                                                : 'bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 shadow-blue-500/30 hover:shadow-blue-500/50 hover:scale-[1.02]'
                                        }`}
                                    >
                                        {isUpscaling ? (
                                            <LoadingSpinner text="" />
                                        ) : (
                                            <>
                                                <PlayIcon className="w-5 h-5" />
                                                生成图像
                                            </>
                                        )}
                                    </button>
                                    <div />
                                </div>

                                <div className="mt-6">
                                    <button 
                                        onClick={() => {
                                            if (!upscaledImage) return;
                                            handleDownloadSimple(upscaledImage, 'upscaled_image');
                                            setUpscaleSaveStatus(true);
                                            setTimeout(() => setUpscaleSaveStatus(false), 3000);
                                        }}
                                        disabled={!upscaledImage}
                                        className={`w-full py-3 rounded-xl font-bold text-white shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all ${
                                            upscaleSaveStatus 
                                                ? 'bg-green-600 hover:bg-green-500 shadow-green-500/30' 
                                                : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-500/30'
                                        }`}
                                    >
                                        {upscaleSaveStatus ? (
                                            <>✅ 已保存</>
                                        ) : (
                                            <>
                                                <DownloadIcon className="w-5 h-5" />
                                                一键保存
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};
