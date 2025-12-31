
import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from './IconComponents';

interface ImageModalProps {
    src: string;
    onClose: () => void;
}

export const ImageModal: React.FC<ImageModalProps> = ({ src, onClose }) => {
    const [scale, setScale] = useState(1);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    
    const dragStartRef = useRef<{ x: number, y: number, time: number } | null>(null);
    const imageRef = useRef<HTMLImageElement>(null);

    // 1. Smart Wheel Logic: Zoom if on image, Scroll page if outside
    useEffect(() => {
        const imgEl = imageRef.current;
        if (!imgEl) return;

        const onWheelNative = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation(); // Stop bubbling to prevent page scroll
            
            const zoomSensitivity = -0.002; 
            setScale(prevScale => {
                 let newScale = prevScale + e.deltaY * zoomSensitivity;
                 return Math.min(Math.max(0.5, newScale), 10);
            });
        };

        // Attach non-passive listener to image only
        imgEl.addEventListener('wheel', onWheelNative, { passive: false });

        return () => {
            imgEl.removeEventListener('wheel', onWheelNative);
        };
    }, []);

    // 2. Drag & Click Logic
    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0) return; // Only left click
        e.preventDefault();
        e.stopPropagation(); // Prevent hitting the backdrop click handler
        
        setIsDragging(true);
        dragStartRef.current = { x: e.clientX, y: e.clientY, time: Date.now() };
    };

    // Use effect to handle global mouse events for smooth dragging
    useEffect(() => {
        const handleGlobalMove = (e: MouseEvent) => {
            if (!isDragging || !dragStartRef.current) return;
            const dx = e.clientX - dragStartRef.current.x;
            const dy = e.clientY - dragStartRef.current.y;
            setPosition({ x: dx, y: dy });
        };

        const handleGlobalUp = (e: MouseEvent) => {
            if (!isDragging || !dragStartRef.current) return;
            
            const dx = e.clientX - dragStartRef.current.x;
            const dy = e.clientY - dragStartRef.current.y;
            const distance = Math.sqrt(dx*dx + dy*dy);
            
            setIsDragging(false);
            
            // Heuristic: If moved less than 5px, treat as Click (Close)
            // Otherwise, treat as Drag Release (Snap Back)
            if (distance < 5) {
                onClose();
            } else {
                setPosition({ x: 0, y: 0 });
            }
            dragStartRef.current = null;
        };

        if (isDragging) {
            document.addEventListener('mousemove', handleGlobalMove);
            document.addEventListener('mouseup', handleGlobalUp);
        }

        return () => {
            document.removeEventListener('mousemove', handleGlobalMove);
            document.removeEventListener('mouseup', handleGlobalUp);
        };
    }, [isDragging, onClose]);

    // 3. ESC Key Close Logic
    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', handleEsc);
        return () => window.removeEventListener('keydown', handleEsc);
    }, [onClose]);


    const modal = (
        <div 
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-md"
            onClick={onClose} // Clicking backdrop closes
        >
            {/* Controls Overlay */}
            <div className="absolute top-0 left-0 w-full p-4 flex justify-end z-[102] pointer-events-none">
                <button 
                    onClick={(e) => {
                        e.stopPropagation();
                        onClose();
                    }} 
                    className="pointer-events-auto bg-black/50 hover:bg-red-500 text-white rounded-full p-3 transition-all backdrop-blur-md border border-white/20 shadow-lg"
                    title="Close (Esc)"
                >
                    <XIcon className="w-6 h-6" />
                </button>
            </div>

            {/* Instructions */}
            <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 bg-black/60 px-6 py-3 rounded-full text-white/90 text-sm backdrop-blur-sm border border-white/10 shadow-lg flex flex-col items-center z-[101] pointer-events-none select-none">
                <span className="font-bold">🖱️ 滚轮缩放 · 按住拖动 · 单击关闭</span>
            </div>

            {/* Image Container */}
            <div 
                className="relative w-full h-full flex items-center justify-center overflow-hidden"
                // We do NOT stop propagation here so clicks on empty space in container (if any) fall through to backdrop
            >
                <img 
                    ref={imageRef}
                    src={src} 
                    alt="Enlarged view" 
                    className="max-w-[95vw] max-h-[95vh] object-contain select-none shadow-2xl rounded-lg cursor-grab active:cursor-grabbing will-change-transform"
                    style={{ 
                        transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                        transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)'
                    }}
                    onMouseDown={handleMouseDown}
                    onClick={(e) => e.stopPropagation()} // Prevent click bubbling immediately, logic is handled in mouseUp
                    draggable={false}
                />
            </div>
        </div>
    );

    if (typeof document === 'undefined') return modal;
    return createPortal(modal, document.body);
};
