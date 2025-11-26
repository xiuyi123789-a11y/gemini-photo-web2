
import React, { useState } from 'react';
import { SmartRetouchRow } from '../types';
import { analyzeImageForImprovement, generateImprovedImage } from '../services/geminiService';
import { addRetouchLearningEntry } from '../services/knowledgeBaseService';
import { MagicWandIcon, PlayIcon, DownloadIcon, ZoomInIcon, TrashIcon, PlusIcon } from './IconComponents';
import { LoadingSpinner } from './LoadingSpinner';
import { ImageModal } from './ImageModal';
import { useApiKey } from '../src/contexts/ApiKeyContext';

export const SmartRetouchView: React.FC = () => {
    const [rows, setRows] = useState<SmartRetouchRow[]>([
        { id: '1', originalImage: null, analysisText: '', isAnalyzing: false, generatedImage: null, isGenerating: false, error: null },
        { id: '2', originalImage: null, analysisText: '', isAnalyzing: false, generatedImage: null, isGenerating: false, error: null },
        { id: '3', originalImage: null, analysisText: '', isAnalyzing: false, generatedImage: null, isGenerating: false, error: null },
    ]);
    const [enlargedImage, setEnlargedImage] = useState<string | null>(null);
    // New state for save feedback (per row id)
    const [saveStatus, setSaveStatus] = useState<Record<string, boolean>>({});
    const { apiKey } = useApiKey();

    const handleImageUpload = (rowId: string, file: File) => {
        const preview = URL.createObjectURL(file);
        setRows(prev => prev.map(row => 
            row.id === rowId ? { ...row, originalImage: { file, preview }, error: null } : row
        ));
    };

    const handleAnalyze = async (rowId: string) => {
        const row = rows.find(r => r.id === rowId);
        if (!row?.originalImage) return;

        if (!apiKey) {
            setRows(prev => prev.map(r => r.id === rowId ? { ...r, error: "请先设置您的 API Key。" } : r));
            return;
        }

        setRows(prev => prev.map(r => r.id === rowId ? { ...r, isAnalyzing: true, error: null } : r));
        try {
            const analysis = await analyzeImageForImprovement(row.originalImage.file, apiKey);
            setRows(prev => prev.map(r => r.id === rowId ? { ...r, isAnalyzing: false, analysisText: analysis } : r));
        } catch (e: any) {
            setRows(prev => prev.map(r => r.id === rowId ? { ...r, isAnalyzing: false, error: e.message || "分析失败" } : r));
        }
    };

    const handleGenerate = async (rowId: string) => {
        const row = rows.find(r => r.id === rowId);
        if (!row?.originalImage || !row.analysisText) return;

        if (!apiKey) {
            setRows(prev => prev.map(r => r.id === rowId ? { ...r, error: "请先设置您的 API Key。" } : r));
            return;
        }

        setRows(prev => prev.map(r => r.id === rowId ? { ...r, isGenerating: true, error: null } : r));
        try {
            const generatedSrc = await generateImprovedImage(row.originalImage.file, row.analysisText, apiKey);
            setRows(prev => prev.map(r => r.id === rowId ? { ...r, isGenerating: false, generatedImage: generatedSrc } : r));
        } catch (e: any) {
            setRows(prev => prev.map(r => r.id === rowId ? { ...r, isGenerating: false, error: e.message || "生成失败" } : r));
        }
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
                                    className="w-full py-3 rounded-xl font-bold bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white shadow-lg shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                >
                                    {row.isAnalyzing ? <LoadingSpinner text="" /> : <><MagicWandIcon className="w-5 h-5" /> AI 解析</>}
                                </button>
                            </div>

                            {/* Column 2: Analysis & Suggestions */}
                            <div className="flex flex-col gap-3">
                                <div className="relative aspect-[3/4] bg-slate-900/60 rounded-2xl border border-slate-700 p-4 overflow-hidden">
                                    {row.isAnalyzing ? (
                                        <div className="h-full flex items-center justify-center">
                                            <LoadingSpinner text="正在深度诊断..." />
                                        </div>
                                    ) : row.analysisText ? (
                                        <textarea 
                                            value={row.analysisText}
                                            onChange={(e) => setRows(prev => prev.map(r => r.id === row.id ? {...r, analysisText: e.target.value} : r))}
                                            className="w-full h-full bg-transparent border-none resize-none text-slate-300 text-sm focus:ring-0 placeholder-slate-600 custom-scrollbar"
                                        />
                                    ) : (
                                        <div className="h-full flex flex-col items-center justify-center text-slate-600 text-center p-4">
                                            <MagicWandIcon className="w-8 h-8 mb-2 opacity-50" />
                                            <p className="text-sm">AI 将从专业角度评估<br/>并给出具体的修图指令</p>
                                        </div>
                                    )}
                                </div>
                                <button 
                                    onClick={() => handleGenerate(row.id)}
                                    disabled={!row.analysisText || row.isGenerating}
                                    className="w-full py-3 rounded-xl font-bold bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-500 hover:to-pink-500 text-white shadow-lg shadow-fuchsia-500/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
        </div>
    );
};
