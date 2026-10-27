import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {X,RotateCcw} from 'lucide-react';
import './ReplicationImageViewer.css';

type Transform={scale:number;x:number;y:number};
const initial:Transform={scale:1,x:0,y:0};
export function ReplicationImageViewer({src,label,onClose}:{key?:string;src:string;label:string;onClose:()=>void}){
  const [transform,setTransform]=useState<Transform>(initial),[dragging,setDragging]=useState(false);
  const current=useRef(initial),stage=useRef<HTMLDivElement>(null),dialog=useRef<HTMLDivElement>(null),close=useRef(onClose);
  const drag=useRef<{id:number;clientX:number;clientY:number;x:number;y:number}|null>(null);
  const update=(value:Transform)=>{current.current=value;setTransform(value);};
  close.current=onClose;
  const resetOrClose=()=>{
    const t=current.current;
    if(Math.abs(t.scale-1)>.0001||Math.abs(t.x)>.01||Math.abs(t.y)>.01){drag.current=null;setDragging(false);update(initial);}
    else close.current();
  };
  useEffect(()=>{
    const el=stage.current;
    const wheel=(event:WheelEvent)=>{
      event.preventDefault();event.stopPropagation();
      const rect=el!.getBoundingClientRect(),t=current.current;
      const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?rect.height:1);
      const scale=Math.min(12,Math.max(.25,t.scale*Math.exp(-delta*.0015)));
      const x=event.clientX-rect.left-rect.width/2,y=event.clientY-rect.top-rect.height/2;
      update({scale,x:x-(x-t.x)*scale/t.scale,y:y-(y-t.y)*scale/t.scale});
    };
    el?.addEventListener('wheel',wheel,{passive:false});
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!event.repeat)resetOrClose();}
      if(event.key==='Tab'&&dialog.current){
        const buttons=Array.from(dialog.current.querySelectorAll('button')) as HTMLButtonElement[];
        const first=buttons[0],last=buttons.at(-1);
        if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    window.addEventListener('keydown',key);
    const previousFocus=document.activeElement as HTMLElement|null,previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';dialog.current?.focus();
    return()=>{el?.removeEventListener('wheel',wheel);window.removeEventListener('keydown',key);document.body.style.overflow=previousOverflow;previousFocus?.focus?.();};
  },[]);
  const end=(event:React.PointerEvent<HTMLDivElement>)=>{
    if(drag.current?.id!==event.pointerId)return;
    drag.current=null;setDragging(false);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const content=<div className="rp-image-viewer" role="dialog" aria-modal="true" aria-label={`${label}放大查看`} tabIndex={-1} ref={dialog}>
    <div className="rp-viewer-heading"><strong>{label}</strong><span>{Math.round(transform.scale*100)}%</span><div><button aria-label="还原图片视图" title="还原尺寸与位置" onClick={()=>{drag.current=null;setDragging(false);update(initial);}}><RotateCcw/></button><button aria-label="还原或关闭大图" title="已缩放或拖动时先还原，再次点击关闭" onClick={resetOrClose}><X/></button></div></div>
    <div className={'rp-viewer-stage '+(dragging?'rp-viewer-dragging':'')} ref={stage}
      onPointerDown={event=>{if(event.button!==0||drag.current)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);drag.current={id:event.pointerId,clientX:event.clientX,clientY:event.clientY,x:current.current.x,y:current.current.y};setDragging(true);}}
      onPointerMove={event=>{const d=drag.current;if(!d||d.id!==event.pointerId)return;update({...current.current,x:d.x+event.clientX-d.clientX,y:d.y+event.clientY-d.clientY});}}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={()=>{drag.current=null;setDragging(false);}}>
      <img src={src} alt={label} draggable={false} style={{transform:`translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`}}/>
    </div><p className="rp-viewer-help">滚轮跟随光标缩放 · 按住拖动 · Esc / 右上角先还原，再关闭</p>
  </div>;
  return typeof document==='undefined'?content:createPortal(content,document.body);
}
