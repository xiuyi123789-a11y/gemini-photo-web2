
import React, { useState, useEffect, useMemo } from 'react';
import { getKnowledgeBase } from '../services/knowledgeBaseService';
import { KnowledgeBaseEntry, KnowledgeBaseCategory } from '../types';
import { XIcon, ChevronDownIcon, FireIcon } from './IconComponents';

interface KnowledgeBaseModalProps {
    onClose: () => void;
    onSelectEntry: (entry: KnowledgeBaseEntry) => void;
}

export const KnowledgeBaseModal: React.FC<KnowledgeBaseModalProps> = ({ onClose, onSelectEntry }) => {
    const [entries, setEntries] = useState<KnowledgeBaseEntry[]>([]);
    const [filter, setFilter] = useState('');
    const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({});

    useEffect(() => {
        setEntries(getKnowledgeBase());
        const initialOpenState = Object.values(KnowledgeBaseCategory).reduce((acc, cat) => {
            acc[cat] = true; // Default all categories to open
            return acc;
        }, {} as Record<string, boolean>);
        setOpenCategories(initialOpenState);
    }, []);

    const toggleCategory = (category: KnowledgeBaseCategory) => {
        setOpenCategories(prev => ({ ...prev, [category]: !prev[category] }));
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
    
    const handleSelect = (entry: KnowledgeBaseEntry) => {
        onSelectEntry(entry);
    };

    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm" onClick={onClose}>
            <div 
                className="bg-slate-800 border border-slate-600 rounded-3xl shadow-2xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <header className="p-6 border-b border-slate-700 flex justify-between items-center flex-shrink-0 bg-slate-900/50">
                    <h3 className="text-xl font-bold text-white">✨ 从知识库选择灵感</h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-white p-2 hover:bg-white/10 rounded-full transition-colors">
                        <XIcon className="w-6 h-6" />
                    </button>
                </header>
                
                <div className="p-4 flex-shrink-0 bg-slate-800">
                     <input
                        type="text"
                        placeholder="🔍 搜索提示词或分类..."
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        className="w-full p-3 bg-slate-900 border border-slate-600 rounded-xl focus:ring-2 focus:ring-fuchsia-500 focus:outline-none text-white placeholder-slate-500"
                    />
                </div>

                <main className="overflow-y-auto p-4 space-y-6 bg-slate-800/50">
                     {(Object.values(KnowledgeBaseCategory)).filter(category => filteredAndGroupedEntries[category]?.length > 0).map(category => (
                        <div key={category} className="bg-slate-700/30 rounded-2xl p-4">
                             <button onClick={() => toggleCategory(category)} className="w-full flex justify-between items-center text-left mb-2">
                                <h4 className="text-lg font-bold text-fuchsia-300">{category}</h4>
                                <ChevronDownIcon className={`w-5 h-5 text-fuchsia-300 transition-transform duration-300 ${openCategories[category] ? 'rotate-180' : ''}`} />
                            </button>
                            <div className={`transition-all duration-500 ease-in-out overflow-hidden ${openCategories[category] ? 'max-h-[1000px]' : 'max-h-0'}`}>
                                <div className="space-y-2 pt-2">
                                    {filteredAndGroupedEntries[category].map(entry => (
                                        <div 
                                            key={entry.id} 
                                            className="bg-slate-700/80 rounded-xl p-3 flex gap-4 items-center cursor-pointer hover:bg-slate-600 border border-transparent hover:border-fuchsia-500/40 transition-all relative shadow-sm"
                                            onClick={() => handleSelect(entry)}
                                        >
                                            {entry.category === KnowledgeBaseCategory.FULL_PROMPT && (
                                                <span className="absolute top-2 right-2 text-[10px] bg-fuchsia-500 text-white font-bold px-2 py-0.5 rounded-full">复刻</span>
                                            )}
                                            <img src={entry.sourceImagePreview} alt="Source" className="w-14 h-14 object-cover rounded-lg flex-shrink-0 bg-slate-800" />
                                            <p className="text-slate-200 text-sm flex-grow font-medium line-clamp-2">{entry.promptFragment}</p>
                                            <div className="flex items-center gap-1 text-xs text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded flex-shrink-0" title="应用次数">
                                                <FireIcon className="w-3 h-3" />
                                                <span>{entry.usageCount || 0}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                             </div>
                        </div>
                    ))}
                </main>
            </div>
        </div>
    );
};
