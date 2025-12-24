import React, { useState, useEffect } from 'react';
import { SmartRetouchRow, KnowledgeBaseEntry } from '../types';
import { analyzeImageSmartRetouch, generateSmartRetouchImage, mergeRetouchPromptsWithImage } from '../services/replicateService';
import { addRetouchLearningEntry } from '../services/knowledgeBaseService';
import { MagicWandIcon, PlayIcon, DownloadIcon, ZoomInIcon, TrashIcon, PlusIcon, FireIcon, RefreshIcon } from './IconComponents';
import { LoadingSpinner } from './LoadingSpinner';
import { ImageModal } from './ImageModal';
import { KnowledgeBaseModal } from './KnowledgeBaseModal';

export const SmartRetouchView: React.FC = () => {
    const [rows, setRows] = useState<SmartRetouchRow[]>([
        { id: '1', originalImage: null, analysisText: '', understandingText: '', retouchStrength: 0.65, isAnalyzing: false, generatedImage: null, isGenerating: false, error: null },
        { id: '2', originalImage: null, analysisText: '', understandingText: '', retouchStrength: 0.65, isAnalyzing: false, generatedImage: null, isGenerating: false, error: null },
        { id: '3', originalImage: null, analysisText: '', understandingText: '', retouchStrength: 0.65, isAnalyzing: false, generatedImage: null, isGenerating: false, error: null },
    ]);
    const [enlargedImage, setEnlargedImage] = useState<string | null>(null);
    const [saveStatus, setSaveStatus] = useState<Record<string, boolean>>({});
    
    // Knowledge Base Modal State
    const [isKbModalOpen, setIsKbModalOpen] = useState(false);
    const [activeRowIdForKb, setActiveRowIdForKb] = useState<string | null>(null);

    // Cleanup blob URLs on unmount
    useEffect(() => {
        return () => {
            rows.forEach(row => {
                if (row.originalImage?.preview) {
                    URL.revokeObjectURL(row.originalImage.preview);
                }
                if (row.generatedImage?.startsWith('blob:')) {
                    URL.revokeObjectURL(row.generatedImage);
                }
            });
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

    return (
        <div>
            {enlargedImage && <ImageModal src={enlargedImage} onClose={() => setEnlargedImage(null)} />}
            
            <div className="text-center mb-8">
                <h2 className="text-3xl font-extrabold text-white mb-2 bg-clip-text text-transparent bg-gradient-to-r from-cyan-300 to-blue-500">智能修图</h2>
                <p className="text-slate-400">AI 全方位解析，一键优化肢体、构图与光影。</p>
            </div>

            <div className="space-y-12">
                {rows.map((row, index) => (
                    <div key={row.id} className="bg-slate-800/40 border border-white/5 rounded-3xl p-8 shadow-xl relative overflow-hidden">
                        {/* Decorative gradient */}
                        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500/50 via-cyan-500/50 to-transparent"></div>
                        
                        {/* Header */}
                        <div className="mb-6 flex items-center gap-3">
                            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 shadow-lg shadow-cyan-500/20 text-white font-extrabold text-lg">
                                {String(index + 1).padStart(2, '0')}
                            </div>
                            <h3 className="text-xl font-bold text-white tracking-wide">
                                ✨ 创作单元 <span className="text-slate-500 text-sm font-normal ml-2">Creative Unit</span>
                            </h3>
                        </div>

                        {/* Main Content: 3-column grid */}
                        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-8 items-start">
                            
                            {/* LEFT: Original Image */}
                            <div className="flex flex-col gap-4">
                                <div 
                                    className={`relative aspect-[3/4] bg-slate-900/60 rounded-2xl border-2 ${row.originalImage ? 'border-transparent' : 'border-dashed border-slate-600'} overflow-hidden group transition-all flex items-center justify-center cursor-pointer shadow-lg`}
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
                                        <label className="cursor-pointer flex flex-col items-center justify-center h-full w-full hover:bg-slate-800/50 transition">
                                            <PlusIcon className="w-12 h-12 text-slate-500 mb-3" />
                                            <span className="text-slate-400 text-sm font-medium">点击上传图片</span>
                                            <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                                                if(e.target.files?.[0]) handleImageUpload(row.id, e.target.files[0]);
                                            }}/>
                                        </label>
                                    )}
                                </div>
                                
                                {/* Re-analyze Button */}
                                <button 
                                    onClick={() => handleAnalyze(row.id)} 
                                    disabled={!row.originalImage || row.isAnalyzing}
                                    className="w-full py-3 rounded-xl font-bold bg-slate-700 hover:bg-slate-600 text-white shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
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
                            </div>

                            {/* MIDDLE: Control Panel */}
                            <div className="flex flex-col gap-4 w-full lg:w-[400px] bg-slate-900/40 rounded-2xl p-6 border border-slate-700/50">
                                
                                {/* Strength Slider */}
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-semibold text-slate-300">重绘幅度</label>
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
                                        className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-fuchsia-500"
                                    />
                                </div>

                                {/* Instructions Textarea */}
                                <div className="relative flex-1 min-h-[300px]">
                                    <textarea 
                                        value={row.analysisText}
                                        onChange={(e) => setRows(prev => prev.map(r => r.id === row.id ? {...r, analysisText: e.target.value} : r))}
                                        placeholder="在此输入修图指令，或等待 AI 解析..."
                                        className="w-full h-full bg-slate-950/60 border border-slate-700 rounded-xl resize-none text-slate-300 text-sm focus:ring-2 focus:ring-fuchsia-500 focus:border-transparent placeholder-slate-600 p-4 custom-scrollbar"
                                        disabled={!row.originalImage}
                                    />
                                    
                                    {/* Inspiration Button */}
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

                                    {/* Non-intrusive Loading */}
                                    {row.isAnalyzing && (
                                        <div className="absolute top-3 right-3 px-3 py-1.5 bg-blue-500/20 text-blue-300 text-xs rounded-full backdrop-blur-sm border border-blue-500/30 flex items-center gap-2 animate-pulse">
                                            <MagicWandIcon className="w-3 h-3" />
                                            AI 正在撰写建议...
                                        </div>
                                    )}
                                </div>

                                {/* Execute Button */}
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
                            </div>

                            {/* RIGHT: Result Image */}
                            <div className="flex flex-col gap-4">
                                <div 
                                    className="relative aspect-[3/4] bg-slate-900/60 rounded-2xl border border-slate-700 overflow-hidden flex items-center justify-center group cursor-pointer shadow-lg"
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
                                            <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-slate-800 flex items-center justify-center">
                                                <MagicWandIcon className="w-8 h-8 opacity-50" />
                                            </div>
                                            <p className="text-sm">优化后的成品<br/>将显示在此处</p>
                                        </div>
                                    )}
                                </div>
                                
                                {/* Save Button */}
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
                        </div>

                        {/* Error Display */}
                        {row.error && (
                            <div className="mt-6">
                                <p className="text-center text-red-400 bg-red-500/10 py-3 rounded-xl text-sm border border-red-500/20">
                                    {row.error}
                                </p>
                            </div>
                        )}
                    </div>
                ))}
            </div>
            
            {/* Knowledge Base Modal */}
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
        </div>
    );
};