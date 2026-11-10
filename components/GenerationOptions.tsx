import React from 'react';

export type GenerationSettings={style:string;aspectRatio:string};
export const defaultGenerationSettings:GenerationSettings={style:'产品摄影',aspectRatio:'3:4'};
export const generationSettingsIssue=(value:GenerationSettings)=>!value.style.trim()?'请选择图片风格。':!['1:1','3:4','9:16'].includes(value.aspectRatio)?'请选择画面比例。':'';
export function GenerationOptions({value,onChange,disabled=false,error='',compact=false}:{value:GenerationSettings;onChange:(value:GenerationSettings)=>void;disabled?:boolean;error?:string;compact?:boolean}){
  return <fieldset className={`shrink-0 min-w-0 rounded-xl border border-slate-200 bg-white ${compact?'my-1 p-2 text-xs':'my-3 p-3 text-sm'}`} disabled={disabled}>
    <legend className="px-1 font-bold text-slate-800">生成设置（必选）</legend>
    <div className="flex flex-wrap gap-3">
      <label className="flex-1 min-w-[120px] text-slate-700">图片风格
        <select aria-label="图片风格" className="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2" value={value.style} onChange={e=>onChange({...value,style:e.target.value})}>
          <option value="">请选择风格</option>{['产品摄影','极简','科技感','轻奢','清新','复古胶片'].map(style=><option key={style}>{style}</option>)}
        </select>
      </label>
      <label className="flex-1 min-w-[120px] text-slate-700">画面比例
        <select aria-label="画面比例" className="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2" value={value.aspectRatio} onChange={e=>onChange({...value,aspectRatio:e.target.value})}>
          <option value="">请选择比例</option><option value="1:1">1:1 · 方图</option><option value="3:4">3:4 · 竖图</option><option value="9:16">9:16 · 全屏竖图</option>
        </select>
      </label>
    </div>
    {!compact&&<p className="mt-2 text-xs text-slate-500">本次生成以这里的风格和比例为准，可在发送前修改。</p>}
    {error&&<p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
  </fieldset>;
}
