
import React, { useState } from 'react';
import { SmartRetouchRow, KnowledgeBaseEntry } from '../types';
import { analyzeImageSmartRetouch, generateSmartRetouchImage, mergeRetouchPromptsWithImage } from '../services/replicateService';
import { addRetouchLearningEntry } from '../services/knowledgeBaseService';
import { MagicWandIcon, PlayIcon, DownloadIcon, ZoomInIcon, TrashIcon, PlusIcon, FireIcon } from './IconComponents';
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

    const handleImageUpload = (rowId: string, file: File) => {
        const preview = URL.createObjectURL(file);
        setRows(prev => prev.map(row => 
            row.id === rowId ? { ...row, originalImage: { file, preview }, error: null } : row
        ));
        
        // Auto-trigger analysis silently
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
            
            // Parallelism Logic: Only update if the user hasn't typed anything yet
            setRows(prev => {
                const currentRow = prev.find(r => r.id === rowId);
                if (currentRow && currentRow.analysisText.trim() !== '') {
                    // User has typed something, don't overwrite visible text, but update internal understanding
                    return prev.map(r => r.id === rowId ? { 
                        ...r, 
                        isAnalyzing: false,
                        understandingText: analysis.understanding 
                    } : r);
                }
                // User hasn't typed, auto-fill both
                return prev.map(r => r.id === rowId ? { 
                    ...r, 
                    isAnalyzing: false, 
                    analysisText: analysis.suggestions,
                    understandingText: analysis.understanding,
                    retouchStrength: parseStrengthFromText(analysis.suggestions) ?? r.retouchStrength
                } : r);
            });
        } catch (e: any) {
            setRows(prev => prev.map(r => r.id === rowId ? { ...r, isAnalyzing: false, error: null } : r));
        }
    };

    const handleGenerate = async (rowId: string) => {
        const row = rows.find(r => r.id === rowId);
        if (!row?.originalImage || !row.analysisText) return;

        setRows(prev => prev.map(r => r.id === rowId ? { ...r, isGenerating: true, error: null } : r));
        try {
            // 1. Merge Prompts: Original Description + User Instructions
            const aiInstructions = extractAiInstructions(row.analysisText);
            let fullPrompt = aiInstructions;
            
            if (row.understandingText) {
                // Use AI to merge logic
                 fullPrompt = await mergeRetouchPromptsWithImage(
                    row.originalImage.file,
                    row.understandingText,
                    aiInstructions
                );
            }

            // 2. Generate Image
            const result = await generateSmartRetouchImage(row.originalImage.file, fullPrompt, row.retouchStrength);
            
            setRows(prev => prev.map(r => r.id === rowId ? { ...r, generatedImage: result, isGenerating: false } : r));
        } catch (e: any) {
            setRows(prev => prev.map(r => r.id === rowId ? { ...r, isGenerating: false, error: e.message || "生成失败" } : r));
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
        
        // 1. Download logic
        const link = document.createElement('a');
        link.href = src;
        link.download = `retouched_image_${rowId}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // 2. AI Learning / Save to KB
        if (row?.originalImage && row.analysisText) {
            try {
                await addRetouchLearningEntry(row.originalImage.file, row.analysisText);
                setSaveStatus(prev => ({ ...prev, [rowId]: true }));
                // Reset status after 3 seconds
                setTimeout(() => setSaveStatus(prev => ({ ...prev, [rowId]: false })), 3000);
            } catch (e) {
                console.error("Failed to save to KB", e);
            }
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
                    <div key={row.id} className="bg-slate-800/40 border border-white/5 rounded-3xl p-6 shadow-xl relative overflow-hidden">
                         {/* Decorative background element */}
                         <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500/50 via-cyan-500/50 to-transparent"></div>
                         
                         <div className="mb-6 flex items-center gap-3">
                             <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 shadow-lg shadow-cyan-500/20 text-white font-extrabold text-lg">
                                 {String(index + 1).padStart(2, '0')}
                             </div>
                             <h3 className="text-xl font-bold text-white tracking-wide">
                                 ✨ 创作单元 <span className="text-slate-500 text-sm font-normal ml-2">Creative Unit</span>
                             </h3>
                         </div>

                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                            {/* Column 1: Upload & Original */}
                            <div className="flex flex-col gap-3">
                                <div 
                                    className={`relative aspect-[3/4] bg-slate-900/60 rounded-2xl border-2 ${row.originalImage ? 'border-transparent' : 'border-dashed border-slate-600'} overflow-hidden group transition-all flex items-center justify-center cursor-pointer`}
                                    onClick={() => row.originalImage && setEnlargedImage(row.originalImage.preview)}
                                >
                                    {row.originalImage ? (
                                        <>
                                            <img src={row.originalImage.preview} alt="Original" className="w-full h-full object-cover" />
                                            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                                 <div className="p-2 bg-white/20 rounded-full text-white hover:bg-white/30 backdrop-blur-sm"><ZoomInIcon className="w-6 h-6"/></div>
                                                 <label 
                                                    className="p-2 bg-white/20 rounded-full text-white hover:bg-white/30 cursor-pointer backdrop-blur-sm"
                                                    onClick={(e) => e.stopPropagation()} // Prevent zoom when clicking delete/change
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
                                            <PlusIcon className="w-10 h-10 text-slate-500 mb-2" />
                                            <span className="text-slate-400 text-sm">点击上传图片</span>
                                            <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                                                 if(e.target.files?.[0]) handleImageUpload(row.id, e.target.files[0]);
                                            }}/>
                                        </label>
                                    )}
                                </div>
                                <button 
                                    onClick={() => handleAnalyze(row.id)} 
                                    disabled={!row.originalImage || row.isAnalyzing}
                                    className="w-full py-3 rounded-xl font-bold bg-slate-700 hover:bg-slate-600 text-white shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
                                >
                                    {row.isAnalyzing ? <LoadingSpinner text="AI 正在思考..." /> : <><MagicWandIcon className="w-5 h-5" /> {row.analysisText ? '重新获取建议' : '获取 AI 建议'}</>}
                                </button>
                            </div>

                            {/* Column 2: Analysis & Suggestions */}
                            <div className="flex flex-col gap-3">
                                <div className="relative aspect-[3/4] bg-slate-900/60 rounded-2xl border border-slate-700 p-4 overflow-hidden">
                                    {row.originalImage ? (
                                        <>
                                            <div className="absolute top-3 left-3 right-3 z-10 flex items-center gap-3 bg-slate-950/40 border border-slate-700/60 rounded-xl px-3 py-2 backdrop-blur">
                                                <span className="text-[11px] font-semibold text-slate-200 whitespace-nowrap">重绘幅度</span>
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
                                                    className="flex-1 accent-fuchsia-500"
                                                />
                                                <input
                                                    type="number"
                                                    min={0}
                                                    max={1}
                                                    step={0.01}
                                                    value={Number(row.retouchStrength.toFixed(2))}
                                                    onChange={(e) => {
                                                        const raw = e.target.value;
                                                        const n = raw === '' ? 0 : Number(raw);
                                                        const next = clamp01(Number.isNaN(n) ? 0 : n);
                                                        setRows(prev => prev.map(r => r.id === row.id ? { ...r, retouchStrength: next } : r));
                                                    }}
                                                    className="w-20 bg-slate-950/40 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100 focus:ring-2 focus:ring-fuchsia-500 focus:border-transparent"
                                                />
                                            </div>
                                            <textarea 
                                                value={row.analysisText}
                                                onChange={(e) => setRows(prev => prev.map(r => r.id === row.id ? {...r, analysisText: e.target.value} : r))}
                                                placeholder="在此输入修图指令，或等待 AI 解析..."
                                                className="w-full h-full bg-transparent border-none resize-none text-slate-300 text-sm focus:ring-0 placeholder-slate-500 custom-scrollbar pt-16 pb-10"
                                            />
                                            <button
                                                onClick={() => openKbModal(row.id)}
                                                className="absolute bottom-3 right-3 px-3 py-1.5 bg-gradient-to-r from-fuchsia-600 to-purple-600 hover:from-fuchsia-500 hover:to-purple-500 text-white rounded-lg backdrop-blur-sm transition-all shadow-lg flex items-center gap-1.5 text-xs font-bold z-10 border border-white/10"
                                                title="从灵感知识库选择"
                                            >
                                                <FireIcon className="w-3.5 h-3.5" />
                                                获取灵感
                                            </button>
                                        </>
                                    ) : (
                                        <div className="h-full flex flex-col items-center justify-center text-slate-600 text-center p-4">
                                            <MagicWandIcon className="w-8 h-8 mb-2 opacity-50" />
                                            <p className="text-sm">AI 将从专业角度评估<br/>并给出具体的修图指令</p>
                                        </div>
                                    )}
                                    
                                    {/* Non-intrusive Loading Indicator */}
                                    {row.isAnalyzing && (
                                        <div className="absolute bottom-2 right-2 px-3 py-1 bg-blue-500/20 text-blue-300 text-xs rounded-full backdrop-blur-sm border border-blue-500/30 flex items-center gap-2 animate-pulse">
                                            <MagicWandIcon className="w-3 h-3" />
                                            AI 正在撰写建议...
                                        </div>
                                    )}
                                </div>
                                <button 
                                    onClick={() => handleGenerate(row.id)}
                                    disabled={!row.originalImage || !row.analysisText || row.isGenerating}
                                    className={`w-full py-3 rounded-xl font-bold text-white shadow-lg flex items-center justify-center gap-2 transition-all
                                        ${(!row.originalImage || !row.analysisText || row.isGenerating) 
                                            ? 'bg-slate-700 opacity-50 cursor-not-allowed' 
                                            : 'bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-500 hover:to-pink-500 shadow-fuchsia-500/20'}`}
                                >
                                     {row.isGenerating ? <LoadingSpinner text="" /> : <><PlayIcon className="w-5 h-5" /> 执行优化指令</>}
                                </button>
                            </div>

                            {/* Column 3: Result */}
                            <div className="flex flex-col gap-3">
                                <div 
                                    className="relative aspect-[3/4] bg-slate-900/60 rounded-2xl border border-slate-700 overflow-hidden flex items-center justify-center group cursor-pointer"
                                    onClick={() => row.generatedImage && setEnlargedImage(row.generatedImage)}
                                >
                                    {row.isGenerating ? (
                                         <LoadingSpinner text="正在重绘..." />
                                    ) : row.generatedImage ? (
                                        <>
                                            <img src={row.generatedImage} alt="Generated" className="w-full h-full object-cover" />
                                             <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                                 <div className="p-2 bg-white/20 rounded-full text-white hover:bg-white/30 backdrop-blur-sm"><ZoomInIcon className="w-6 h-6"/></div>
                                            </div>
                                        </>
                                    ) : (
                                        <div className="text-slate-600 text-center">
                                            <p className="text-sm">优化后的成品<br/>将显示在此处</p>
                                        </div>
                                    )}
                                </div>
                                <button 
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if(row.generatedImage) handleDownload(row.generatedImage, row.id);
                                    }}
                                    disabled={!row.generatedImage}
                                    className={`w-full py-3 rounded-xl font-bold text-white shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all ${
                                        saveStatus[row.id] 
                                        ? 'bg-green-600 hover:bg-green-500 shadow-green-500/20' 
                                        : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-500/20'
                                    }`}
                                >
                                    {saveStatus[row.id] ? (
                                        <>✅ 已保存并记忆</>
                                    ) : (
                                        <><DownloadIcon className="w-5 h-5" /> 一键保存</>
                                    )}
                                </button>
                            </div>
                        </div>
                        {row.error && <p className="mt-4 text-center text-red-400 bg-red-500/10 py-2 rounded-lg text-sm">{row.error}</p>}
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
        </div>
    );
};
