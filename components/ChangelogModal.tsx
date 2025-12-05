import React, { useState, useEffect } from 'react';
import { XIcon, ChevronDownIcon } from './IconComponents';

interface ChangeItem {
    summary: string;
    details?: string;
}

interface ChangelogEntry {
    version: string;
    date: string;
    changes: (string | ChangeItem)[];
    type: string;
}

interface ChangelogModalProps {
    isOpen: boolean;
    onClose: () => void;
    changelogData: ChangelogEntry[];
}

export const ChangelogModal: React.FC<ChangelogModalProps> = ({ isOpen, onClose, changelogData }) => {
    // State for expanded versions (initially only the first one)
    const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set());
    // State for expanded details (by unique key: version-index)
    const [expandedDetails, setExpandedDetails] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (isOpen && changelogData.length > 0) {
            // Default to expand only the latest version
            setExpandedVersions(new Set([changelogData[0].version]));
            setExpandedDetails(new Set());
        }
    }, [isOpen, changelogData]);

    useEffect(() => {
        const handleEsc = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && isOpen) {
                onClose();
            }
        };
        
        if (isOpen) {
            window.addEventListener('keydown', handleEsc);
        }
        
        return () => {
            window.removeEventListener('keydown', handleEsc);
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const toggleVersion = (version: string) => {
        const newSet = new Set(expandedVersions);
        if (newSet.has(version)) {
            newSet.delete(version);
        } else {
            newSet.add(version);
        }
        setExpandedVersions(newSet);
    };

    const toggleDetail = (id: string) => {
        const newSet = new Set(expandedDetails);
        if (newSet.has(id)) {
            newSet.delete(id);
        } else {
            newSet.add(id);
        }
        setExpandedDetails(newSet);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 pointer-events-none">
            <div 
                className="bg-slate-950 border border-slate-700 rounded-2xl w-full max-w-5xl h-[80vh] flex flex-col shadow-2xl overflow-hidden animate-fade-in pointer-events-auto"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-slate-800 bg-slate-900/50 shrink-0">
                    <h2 className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-fuchsia-400 to-purple-400">
                        版本更新记录
                    </h2>
                    <button 
                        onClick={onClose}
                        className="text-slate-400 hover:text-white transition-colors p-1 hover:bg-slate-800 rounded-lg"
                    >
                        <XIcon className="w-6 h-6" />
                    </button>
                </div>

                {/* Content */}
                <div className="overflow-y-auto p-6 custom-scrollbar">
                    <div className="relative border-l border-slate-700 ml-3 space-y-8">
                        {changelogData.map((entry, index) => {
                            const isExpanded = expandedVersions.has(entry.version);
                            
                            return (
                                <div key={index} className="relative pl-8">
                                    {/* Timeline Dot */}
                                    <div className={`absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full border-2 border-slate-900 ${
                                        index === 0 ? 'bg-fuchsia-500 shadow-[0_0_10px_rgba(217,70,239,0.5)]' : 'bg-slate-600'
                                    }`}></div>
                                    
                                    {/* Version Header (Clickable) */}
                                    <div 
                                        className="flex flex-wrap items-center gap-3 mb-2 cursor-pointer group select-none"
                                        onClick={() => toggleVersion(entry.version)}
                                    >
                                        <span className={`text-lg font-bold transition-colors ${index === 0 ? 'text-white' : 'text-slate-300 group-hover:text-white'}`}>
                                            {entry.version}
                                        </span>
                                        <span className={`px-2 py-0.5 text-xs rounded-full font-medium border ${
                                            entry.type === 'Feature' 
                                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                                                : entry.type === 'Fix' 
                                                ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                                                : 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                                        }`}>
                                            {entry.type}
                                        </span>
                                        <span className="text-sm text-slate-500">
                                            {entry.date}
                                        </span>
                                        <ChevronDownIcon className={`w-4 h-4 text-slate-500 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                                    </div>

                                    {/* Changes List (Collapsible) */}
                                    {isExpanded && (
                                        <ul className="space-y-3 mt-3 animate-slide-down">
                                            {entry.changes.map((change, idx) => {
                                                const isString = typeof change === 'string';
                                                const summary = isString ? change : change.summary;
                                                const details = isString ? null : change.details;
                                                const detailId = `${entry.version}-${idx}`;
                                                const isDetailOpen = expandedDetails.has(detailId);

                                                return (
                                                    <li key={idx} className="text-slate-400 text-sm leading-relaxed">
                                                        <div 
                                                            className={`flex items-start ${details ? 'cursor-pointer hover:text-slate-200 transition-colors' : ''}`}
                                                            onClick={() => details && toggleDetail(detailId)}
                                                        >
                                                            <span className="mr-2 text-slate-600 mt-1">•</span>
                                                            <span className="flex-1">
                                                                {summary}
                                                                {details && (
                                                                    <span className="ml-2 text-xs text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700 inline-block align-middle">
                                                                        {isDetailOpen ? '收起' : '详情'}
                                                                    </span>
                                                                )}
                                                            </span>
                                                        </div>
                                                        
                                                        {/* Detail View */}
                                                        {details && isDetailOpen && (
                                                            <div className="mt-2 ml-5 p-3 bg-slate-800/50 border border-slate-700/50 rounded-lg text-xs text-slate-400 whitespace-pre-wrap animate-fade-in">
                                                                {details}
                                                            </div>
                                                        )}
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
};
