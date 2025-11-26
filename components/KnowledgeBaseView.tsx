
import React, { useState, useEffect, useMemo } from 'react';
import { FileUpload } from './FileUpload';
import { ImageFile, KnowledgeBaseEntry, KnowledgeBaseCategory, KnowledgeBaseAnalysis } from '../types';
import { analyzeAndCategorizeImageForKB } from '../services/geminiService';
import { getKnowledgeBase, addMultipleKnowledgeBaseEntries, deleteKnowledgeBaseEntry, resizeImage, KB_UPDATE_EVENT } from '../services/knowledgeBaseService';
import { LoadingSpinner } from './LoadingSpinner';
import { TrashIcon, ChevronDownIcon, FireIcon } from './IconComponents';
import { useApiKey } from '../src/contexts/ApiKeyContext';

export const KnowledgeBaseView: React.FC = () => {
    const [entries, setEntries] = useState<KnowledgeBaseEntry[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<string>('');
    const [analysisProgress, setAnalysisProgress] = useState<{current: number, total: number} | null>(null);
    const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({});
    const { apiKey } = useApiKey();

    const loadEntries = () => {
        setEntries(getKnowledgeBase());
    };

    useEffect(() => {
        loadEntries();
        
        // Initialize categories state
        const initialOpenState = Object.values(KnowledgeBaseCategory).reduce((acc, cat) => {
            acc[cat] = true; 
            return acc;
        }, {} as Record<string, boolean>);
        setOpenCategories(initialOpenState);

        // Listen for updates from other components (e.g. SmartRetouchView saving)
        window.addEventListener(KB_UPDATE_EVENT, loadEntries);
        return () => {
            window.removeEventListener(KB_UPDATE_EVENT, loadEntries);
        }
    }, []);

     const toggleCategory = (category: KnowledgeBaseCategory) => {
        setOpenCategories(prev => ({ ...prev, [category]: !prev[category] }));
    };

    const handleFileAnalyze = async (files: ImageFile[]) => {
        if (files.length === 0) return;

        if (!apiKey) {
            setError("请先设置您的 API Key。");
            return;
        }
        
        setIsLoading(true);
        setError(null);
        setAnalysisProgress({ current: 0, total: files.length });

        let processedCount = 0;

        for (const imageFile of files) {
            try {
                const thumbnail = await resizeImage(imageFile.file);
                const analysisResult: KnowledgeBaseAnalysis = await analyzeAndCategorizeImageForKB(imageFile.file, apiKey);
                
                const newEntries: Omit<KnowledgeBaseEntry, 'id' | 'usageCount'>[] = [];
                
                // --- Create FRAGMENT entries from analysisResult.fragments ---
                for (const category in analysisResult.fragments) {
                    const prompts = analysisResult.fragments[category as KnowledgeBaseCategory];
                    if (prompts) {
                        prompts.forEach(promptFragment => {
                            newEntries.push({
                                category: category as KnowledgeBaseCategory,
                                promptFragment,
                                sourceImagePreview: thumbnail,
                            });
                        });
                    }
                }

                // --- Create FULL PROMPT entry from analysisResult.holistic_description ---
                const consistentPromptText = `场景: ${analysisResult.fragments[KnowledgeBaseCategory.SCENE]?.[0] || ''}. 风格: ${analysisResult.fragments[KnowledgeBaseCategory.STYLE]?.[0] || ''}. 光照: ${analysisResult.fragments[KnowledgeBaseCategory.LIGHTING]?.[0] || ''}.`;
                const variablePromptText = analysisResult.holistic_description;
                
                newEntries.push({
                    category: KnowledgeBaseCategory.FULL_PROMPT,
                    promptFragment: `完整复刻: ${variablePromptText.substring(0, 50)}...`,
                    sourceImagePreview: thumbnail,
                    fullPrompt: {
                        consistentPrompt: consistentPromptText,
                        variablePrompt: variablePromptText,
                    }
                });

                addMultipleKnowledgeBaseEntries(newEntries);
                processedCount++;
                setAnalysisProgress({ current: processedCount, total: files.length });

            } catch (e: any) {
                console.error(`Failed to process file ${imageFile.file.name}:`, e);
                setError(`处理文件 ${imageFile.file.name} 失败: ${e.message}`);
            }
        }
        
        setIsLoading(false);
        setAnalysisProgress(null);
    };
    
    const handleDelete = (id: string) => {
        deleteKnowledgeBaseEntry(id);
    };

    const filteredAndGroupedEntries = useMemo(() => {
        const filtered = entries.filter(entry => 
            entry.promptFragment.toLowerCase().includes(filter.toLowerCase()) ||
            entry.category.toLowerCase().includes(filter.toLowerCase())
        );

        return filtered.reduce((acc, entry) => {
            if (!acc[entry.category]) {
                acc[entry.category] = [];
            }
            acc[entry.category].push(entry);
            return acc;
        }, {} as Record<KnowledgeBaseCategory, KnowledgeBaseEntry[]>);
    }, [entries, filter]);

    return (
        <div>
            <div className="text-center mb-8">
                <h2 className="text-3xl font-bold text-white mb-2">✨ 灵感知识库</h2>
                <p className="text-slate-400">上传您喜欢的图片，AI会自动解析其美学基因，转化为您的专属创作素材。</p>
            </div>

            <div className="mb-8 p-8 bg-slate-800/50 rounded-3xl border border-white/10 shadow-xl backdrop-blur-sm">
                <h3 className="text-lg font-bold text-white mb-4 ml-1">📥 添加新灵感 (AI 自动拆解)</h3>
                {isLoading ? (
                    <LoadingSpinner text={`正在提取美学基因... (${analysisProgress?.current} / ${analysisProgress?.total})`} />
                ) : (
                    <FileUpload onFilesSelected={handleFileAnalyze} multiple={true} />
                )}
                {error && <p className="text-red-400 mt-4 text-center">{error}</p>}
            </div>

            <div className="bg-slate-900/30 rounded-3xl p-8 border border-white/5">
                <div className="flex flex-col md:flex-row justify-between items-center mb-6 gap-4">
                    <h3 className="text-xl font-bold text-white">📚 浏览素材</h3>
                    <input
                        type="text"
                        placeholder="🔍 搜索提示词或分类..."
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        className="w-full md:w-1/3 p-3 bg-slate-800 border border-slate-600 rounded-full focus:ring-2 focus:ring-fuchsia-500 focus:outline-none text-sm"
                    />
                </div>

                {Object.keys(filteredAndGroupedEntries).length === 0 && !isLoading ? (
                    <div className="text-center py-16 text-slate-500 flex flex-col items-center">
                        <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center mb-4 text-4xl">🤷‍♂️</div>
                        <p className="text-lg">知识库空空如也，或未找到匹配项。</p>
                        <p className="text-sm mt-2">试着上传一些图片来填充它吧！</p>
                    </div>
                ) : (
                    <div className="space-y-8">
                        {(Object.values(KnowledgeBaseCategory)).filter(category => filteredAndGroupedEntries[category]?.length > 0).map(category => (
                            <div key={category} className="bg-slate-800/30 rounded-2xl p-4 border border-white/5">
                                <button onClick={() => toggleCategory(category)} className="w-full flex justify-between items-center text-left mb-2 p-2 rounded-lg hover:bg-white/5 transition-colors">
                                    <h4 className="text-xl font-bold text-fuchsia-300 flex items-center gap-2">
                                        {category}
                                        {category === KnowledgeBaseCategory.RETOUCH_LEARNING && <span className="bg-blue-500/20 text-blue-300 text-xs px-2 py-0.5 rounded-full">AI Memory</span>}
                                    </h4>
                                    <div className="flex items-center gap-2 text-slate-400 text-sm">
                                        <span>{filteredAndGroupedEntries[category].length} 个条目</span>
                                        <ChevronDownIcon className={`w-5 h-5 transition-transform duration-300 ${openCategories[category] ? 'rotate-180' : ''}`} />
                                    </div>
                                </button>
                                <div className={`transition-all duration-500 ease-in-out grid-flow-row overflow-hidden ${openCategories[category] ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'}`}>
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
                                        {filteredAndGroupedEntries[category].map(entry => (
                                            <div key={entry.id} className="bg-slate-700/50 rounded-xl p-3 flex gap-3 group relative border border-transparent hover:border-fuchsia-500/30 transition-all hover:bg-slate-700">
                                                 {entry.category === KnowledgeBaseCategory.FULL_PROMPT && (
                                                    <span className="absolute top-2 right-2 text-[10px] bg-fuchsia-500 text-white font-bold px-2 py-0.5 rounded-full shadow-sm">复刻</span>
                                                )}
                                                <div className="w-20 h-20 flex-shrink-0 rounded-lg overflow-hidden bg-slate-800">
                                                    <img src={entry.sourceImagePreview} alt="Source" className="w-full h-full object-cover" />
                                                </div>
                                                <div className="flex-grow flex flex-col justify-between min-w-0">
                                                    <p className="text-slate-200 text-sm mb-1 line-clamp-3 font-medium">{entry.promptFragment}</p>
                                                    <div className="flex justify-between items-center">
                                                        <div className="flex items-center gap-1 text-xs text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded" title="应用次数">
                                                            <FireIcon className="w-3 h-3" />
                                                            <span>{entry.usageCount || 0}</span>
                                                        </div>
                                                        <button onClick={() => handleDelete(entry.id)} className="self-end p-1.5 rounded-full text-slate-500 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all">
                                                            <TrashIcon className="w-4 h-4" />
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
